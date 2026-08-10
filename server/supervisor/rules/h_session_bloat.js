// ============================================================================
// Supervisor 规则:H session bloat
// ----------------------------------------------------------------------------
// 消除事故 · 2026-08-10 t-msk1tsdu-znm8 · H.7ipp53 session cost $135 累积到
//   Claude API 服务端隐性上限 → 403 "socket connection was closed"
//
// 背景:H 是 project singleton,一个 H session 处理该 project 所有 thread 的
//   编排任务。用得久了 session 累积巨大 conversation history,某个阈值撞墙。
//
// 逻辑:H 类实例 · 查 messages 表最近 result event 的 total_cost_usd / num_turns
//   - warn: cost > $30 OR turns > 200
//   - error: cost > $80 OR turns > 400
//   suggestedAction: reset H session(kill + respawn + memo)
//
// 只对 role_name='mate-H'(orchestrator) 检查 — R 是 per-thread 无累积压力,
//   B/C 是 pool 但每个 thread 独立 session 可 recycle,不像 H 那样共享
// ============================================================================

const { db } = require('../../db');

const RULE_ID = 'h_session_bloat';
const WARN_COST_USD = 30;
const ERROR_COST_USD = 80;
const WARN_TURNS = 200;
const ERROR_TURNS = 400;

function _fetchLatestResult(instanceId) {
  const row = db.prepare(`
    SELECT ts, payload_json FROM messages
    WHERE instance_id = ? AND event_type LIKE 'result/%'
    ORDER BY ts DESC LIMIT 1
  `).get(instanceId);
  if (!row) return null;
  try {
    const p = JSON.parse(row.payload_json);
    return {
      ts: row.ts,
      totalCostUsd: p.total_cost_usd || 0,
      numTurns: p.num_turns || 0,
      sessionId: p.session_id,
    };
  } catch { return null; }
}

async function check() {
  const store = require('../store');
  store.markResolvedByPredicate((f) => f.ruleId === RULE_ID);

  const findings = [];
  const hInsts = db.prepare(`
    SELECT id, role_name, project_id, status
    FROM role_instances
    WHERE role_name = 'mate-H' AND status != 'dead'
  `).all();

  for (const h of hInsts) {
    const result = _fetchLatestResult(h.id);
    if (!result) continue;

    const cost = result.totalCostUsd || 0;
    const turns = result.numTurns || 0;

    let severity, reason;
    if (cost > ERROR_COST_USD || turns > ERROR_TURNS) {
      severity = 'error';
      reason = cost > ERROR_COST_USD ? `cost $${cost.toFixed(2)} > $${ERROR_COST_USD}` : `${turns} turns > ${ERROR_TURNS}`;
    } else if (cost > WARN_COST_USD || turns > WARN_TURNS) {
      severity = 'warn';
      reason = cost > WARN_COST_USD ? `cost $${cost.toFixed(2)} > $${WARN_COST_USD}` : `${turns} turns > ${WARN_TURNS}`;
    } else continue;

    findings.push({
      ruleId: RULE_ID,
      severity,
      threadSlug: null,
      instanceId: h.id,
      message: `⚠ H session 累积过大 · ${h.id} · ${reason} · 建议 reset 避免撞 Claude API socket close`,
      detectedAt: Date.now(),
      dedupKey: `${RULE_ID}:${h.id}`,
      evidence: {
        totalCostUsd: cost,
        numTurns: turns,
        sessionId: result.sessionId,
        lastResultTs: result.ts,
        lastResultIso: new Date(result.ts).toISOString(),
        projectId: h.project_id,
        instanceStatus: h.status,
        thresholds: { warnCost: WARN_COST_USD, errorCost: ERROR_COST_USD, warnTurns: WARN_TURNS, errorTurns: ERROR_TURNS },
      },
      suggestedAction: {
        label: `Reset H session ${h.id}(kill + 起新 session + 注入 memo)`,
        kind: 'endpoint',
        endpoint: `/api/system/reset-h-session`,
        body: { projectId: h.project_id },
        confirmPrompt: `即将 kill ${h.id}(cost $${cost.toFixed(2)})并起新 H session。\n\nmate 会自动生成"接班 memo"注入新 H,包含项目所有 active thread 的当前状态。\n\n继续?`,
      },
    });
  }
  return findings;
}

function subscribe(bus, dispatch) {
  // event 驱动:每次 result event 是"turn 结束"信号,可能 cost 又涨了
  const handler = () => check().then((fs) => fs.forEach(dispatch)).catch(() => {});
  const unsub = bus.subscribe('instance.status_change', (p) => {
    if (p.to === 'idle') handler();  // 转 idle = turn 结束 → 检查
  });
  return typeof unsub === 'function' ? unsub : (() => {});
}

module.exports = { id: RULE_ID, check, subscribe };
