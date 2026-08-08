// ============================================================================
// MODULE CONTRACT
// ----------------------------------------------------------------------------
// 层:L2 内部存储
// 责任:supervisor findings 内存 store + 决策日志(异步落 events 表)。
//   findings 是"当前活跃的问题",log 是"历史决策时间线"。
// 公共 API:
//   upsertFinding(f)  → boolean(true=新)
//   listActiveFindings(filter?) → array
//   getFinding(id) → object|null
//   dismiss(id) → boolean
//   listLog(sinceTs?) → array
// 允许依赖:db(recordEvent 落长期日志)/ logger
// 禁止:业务判断(那是 rules 的活)
// ============================================================================

const { recordEvent } = require('../db');
const log = require('../logger');
const MOD = 'SupervisorStore';

const _findings = new Map();  // findingId → finding
const _log = [];              // 时间线(内存滚动,最多 500 条)
const LOG_MAX = 500;

let _idCounter = 0;
function _nextId() { return `sv-${Date.now().toString(36)}-${++_idCounter}`; }

// 规则可以自己算 dedupKey(比如 rule:missing_marker + threadSlug + inst → 同一条不重复)
function _dedupKey(f) {
  return f.dedupKey || `${f.ruleId}:${f.threadSlug || '-'}:${f.instanceId || '-'}`;
}

function upsertFinding(f) {
  const key = _dedupKey(f);
  // 找是否已存在(active 状态下)
  for (const [id, existing] of _findings) {
    if (_dedupKey(existing) === key && existing.status === 'active') {
      // 更新证据 / lastSeen,不算新
      existing.lastSeenAt = Date.now();
      existing.evidence = f.evidence || existing.evidence;
      existing.message = f.message || existing.message;
      return false;
    }
  }
  const id = _nextId();
  const finding = {
    id,
    status: 'active',
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    ...f,
  };
  _findings.set(id, finding);
  _appendLog({
    kind: 'finding_created',
    findingId: id,
    ruleId: f.ruleId,
    severity: f.severity,
    threadSlug: f.threadSlug,
    instanceId: f.instanceId,
    message: f.message,
    ts: Date.now(),
  });
  return true;
}

function listActiveFindings(filter) {
  let arr = Array.from(_findings.values()).filter((f) => f.status === 'active');
  if (filter?.severity) arr = arr.filter((f) => f.severity === filter.severity);
  if (filter?.ruleId) arr = arr.filter((f) => f.ruleId === filter.ruleId);
  if (filter?.threadSlug) arr = arr.filter((f) => f.threadSlug === filter.threadSlug);
  return arr.sort((a, b) => b.createdAt - a.createdAt);
}

function getFinding(id) {
  return _findings.get(id) || null;
}

function dismiss(id) {
  const f = _findings.get(id);
  if (!f) return false;
  f.status = 'dismissed';
  f.dismissedAt = Date.now();
  _appendLog({ kind: 'finding_dismissed', findingId: id, ruleId: f.ruleId, ts: Date.now() });
  return true;
}

// 资源型:auto-resolve(比如 role 从 busy 转 idle 又转 busy,旧的 long_turn 应该消失)
// 规则可以在 check 时调 markResolvedByPredicate
function markResolvedByPredicate(predicate) {
  let n = 0;
  for (const f of _findings.values()) {
    if (f.status === 'active' && predicate(f)) {
      f.status = 'resolved';
      f.resolvedAt = Date.now();
      _appendLog({ kind: 'finding_resolved', findingId: f.id, ruleId: f.ruleId, ts: Date.now() });
      n++;
    }
  }
  return n;
}

function _appendLog(entry) {
  _log.push(entry);
  if (_log.length > LOG_MAX) _log.splice(0, _log.length - LOG_MAX);
  // 长期落 events 表(可选,失败不阻塞)
  try {
    recordEvent('supervisor.' + entry.kind, entry, {
      instanceId: entry.instanceId,
      threadSlug: entry.threadSlug,
    });
  } catch (e) {
    log.warn({ module: MOD, event: 'record_event_failed', error: e.message });
  }
}

function listLog(sinceTs) {
  if (!sinceTs) return [..._log];
  return _log.filter((l) => l.ts >= sinceTs);
}

module.exports = {
  upsertFinding,
  listActiveFindings,
  getFinding,
  dismiss,
  markResolvedByPredicate,
  listLog,
};
