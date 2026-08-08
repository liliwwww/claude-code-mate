// ============================================================================
// MODULE CONTRACT(设计 SSOT:docs/supervisor 设计.md)
// ----------------------------------------------------------------------------
// 层:L2 Process Control
// 责任:mate 的"值班室" — 实时监控 chain / role / queue 健康,给出具体处理建议,
//   透明化决策过程。event-driven + 定时兜底,不动业务实体,不替 LLM 决策。
// 公共 API:
//   start() / stop()          — 生命周期
//   getState()                — 当前 findings 汇总(供 GET /api/supervisor/state)
//   getFindings(filter?)      — 详细列表
//   getRestartVerdict()       — 重启门控专用
//   dismissFinding(id)        — 用户忽略某 finding
//   applyFinding(id)          — 一键采纳 suggestedAction(内部调对应 endpoint)
// 允许依赖:messageBus / db / PendingSends / ThreadStore(纯读) / RoleCatalog
// 禁止:
//   - 替 LLM 决策
//   - 直接改 chain / stack(自愈 stack_drift 除外,与 X1 沿用同规则)
//   - 破坏性动作自动执行(kill inst / cancel queue 需 user 一键确认)
// ============================================================================
//
// [需求@2026-08-08 supervisor] 主动值班监督组件。
//
// 触发源两条:
//   1. bus 事件订阅(实时)—— instance.status_change / dispatch.completed /
//      queue.added / instance.session_lost_recovered 等
//   2. 30s cron 兜底 —— 捞事件驱动漏掉的场景(mate 重启后 event 断层等)
//
// Findings 存 store,broadcast 到 UI。每条 finding 有:
//   - severity(info/warn/error)
//   - rule id + threadSlug + instanceId
//   - message(人类可读)
//   - suggestedAction(可一键执行)
//   - evidence(判断依据)

const bus = require('../messageBus');
const log = require('../logger');
const MOD = 'Supervisor';

const store = require('./store');

// 规则集合 — 每条规则是 { id, check(ctx) => finding[] | null, subscribe(bus, dispatch) }
const rules = [
  require('./rules/missing_marker'),
  require('./rules/long_turn'),
  require('./rules/restart_gate'),
  require('./rules/blocked_marker'),
  // [Phase 2c @2026-08-08]
  require('./rules/chain_stalled'),
  require('./rules/target_dead'),
  require('./rules/queue_stuck'),
];

const CRON_INTERVAL_MS = 30 * 1000;    // 30s 兜底扫全库
let _cronTimer = null;
let _subscriptions = [];

function start() {
  if (_cronTimer) {
    log.warn({ module: MOD, event: 'already_started' });
    return;
  }
  // 1. 注册事件订阅(每条规则订阅自己感兴趣的 bus topic)
  for (const rule of rules) {
    if (typeof rule.subscribe === 'function') {
      const unsub = rule.subscribe(bus, (finding) => _emit(finding, rule));
      _subscriptions.push(unsub);
    }
  }
  // 2. 定时兜底扫
  _cronTimer = setInterval(() => {
    _runCronCheck().catch((e) => log.warn({ module: MOD, event: 'cron_failed', error: e.message }));
  }, CRON_INTERVAL_MS);
  // 3. Boot 立即跑一次
  setImmediate(() => _runCronCheck().catch((e) => log.warn({ module: MOD, event: 'boot_check_failed', error: e.message })));
  log.info({ module: MOD, event: 'started', ruleCount: rules.length, cronIntervalSec: CRON_INTERVAL_MS / 1000 });
}

function stop() {
  if (_cronTimer) {
    clearInterval(_cronTimer);
    _cronTimer = null;
  }
  for (const unsub of _subscriptions) {
    try { if (typeof unsub === 'function') unsub(); } catch {}
  }
  _subscriptions = [];
  log.info({ module: MOD, event: 'stopped' });
}

// 定时兜底 — 让每条规则跑一次 check()
async function _runCronCheck() {
  for (const rule of rules) {
    if (typeof rule.check !== 'function') continue;
    try {
      const findings = await rule.check();
      if (findings && findings.length) {
        for (const f of findings) _emit(f, rule);
      }
    } catch (e) {
      log.warn({ module: MOD, event: 'rule_check_failed', ruleId: rule.id, error: e.message });
    }
  }
}

// finding 落 store + broadcast
function _emit(finding, rule) {
  // 规则可以返 findingId(便于 dedup),否则 store 会生成
  const enriched = {
    ruleId: rule.id,
    severity: finding.severity || 'warn',
    detectedAt: finding.detectedAt || Date.now(),
    ...finding,
  };
  const wasNew = store.upsertFinding(enriched);
  if (wasNew) {
    log.info({ module: MOD, event: 'finding_new', ruleId: rule.id, severity: enriched.severity,
      threadSlug: enriched.threadSlug, instanceId: enriched.instanceId, message: enriched.message });
    try {
      bus.publish('supervisor.finding', enriched);
    } catch (e) { log.warn({ module: MOD, event: 'broadcast_failed', error: e.message }); }
  }
}

// ============ 公共查询 API ============

function getState() {
  const findings = store.listActiveFindings();
  const byServ = { info: 0, warn: 0, error: 0 };
  findings.forEach((f) => { byServ[f.severity] = (byServ[f.severity] || 0) + 1; });
  const verdict = byServ.error > 0 ? 'error'
                : byServ.warn > 0 ? 'warn'
                : 'ok';
  return {
    ts: Date.now(),
    verdict,
    total: findings.length,
    byServerity: byServ,
    ruleCount: rules.length,
  };
}

function getFindings(filter) {
  return store.listActiveFindings(filter);
}

function getLog(sinceTs) {
  return store.listLog(sinceTs);
}

// 重启门控:只看 restart_gate 规则输出
async function getRestartVerdict() {
  const gateRule = rules.find((r) => r.id === 'restart_gate');
  if (!gateRule) return { verdict: 'ok', blockers: [], warnings: [], note: 'no restart_gate rule' };
  const findings = await gateRule.check();
  return gateRule.deriveVerdict ? gateRule.deriveVerdict(findings || []) : {
    verdict: (findings || []).some((f) => f.severity === 'error') ? 'block'
           : (findings || []).some((f) => f.severity === 'warn') ? 'caution' : 'ok',
    blockers: (findings || []).filter((f) => f.severity === 'error'),
    warnings: (findings || []).filter((f) => f.severity === 'warn'),
  };
}

function dismissFinding(id) {
  return store.dismiss(id);
}

// 一键采纳 — MVP 阶段仅 log,不真跑动作(需 Phase 2 添加安全性检查)
async function applyFinding(id) {
  const f = store.getFinding(id);
  if (!f) throw new Error(`finding ${id} not found`);
  if (!f.suggestedAction) throw new Error(`finding ${id} has no suggestedAction`);
  log.info({ module: MOD, event: 'apply_finding', findingId: id, ruleId: f.ruleId, action: f.suggestedAction.label });
  // MVP: 返回动作描述,由前端确认后调对应 endpoint
  return { finding: f, action: f.suggestedAction };
}

module.exports = {
  start, stop,
  getState, getFindings, getLog, getRestartVerdict,
  dismissFinding, applyFinding,
  // 单元测试用:允许注入自定义规则(不用 subscribe,只 check)
  _rules: rules,
};
