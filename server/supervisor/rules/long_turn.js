// ============================================================================
// Supervisor 规则:长 turn 心跳
// ----------------------------------------------------------------------------
// 消除事故 #5(2026-08-07 用户看 H 长 turn 无输出以为卡了,重启 mate)
//
// 逻辑:role busy 且开始 > 60s → 每 30s cron 查:
//   - 最近 30s 内有 tool_use / thinking_tokens event → severity=info,"在跑勿打扰"
//   - 60-180s 无任何 event → severity=warn,"可能真卡了"
//   - > 180s 完全静默 → severity=error,建议强制解卡
// ============================================================================

const { db } = require('../../db');

const RULE_ID = 'long_turn';
const TURN_MIN_MS = 60 * 1000;         // busy > 60s 才开始关注
const RECENT_ACTIVITY_MS = 30 * 1000;  // 30s 内有 event = 活跃
const CAUTION_MS = 60 * 1000;          // 60s+ 无 event = warn
const CRITICAL_MS = 3 * 60 * 1000;     // 180s+ 无 event = error

// 拿 inst 最近 event ts(messages 表 MAX(ts))— #199 教训:用最鲜活数据源
function _fetchLastEventTs(instanceId) {
  const row = db.prepare(`SELECT MAX(ts) as mx FROM messages WHERE instance_id = ?`).get(instanceId);
  return row?.mx || 0;
}

// 拿 inst 当前 turn 开始时间(最近一次 status='busy' 的 ts)
// 简化实现:用最近一次 user_to_role 的 ts(触发 turn 的时刻)
function _fetchTurnStartTs(instanceId) {
  const row = db.prepare(`
    SELECT ts FROM messages
    WHERE instance_id = ? AND direction = 'user_to_role'
    ORDER BY ts DESC LIMIT 1
  `).get(instanceId);
  return row?.ts || 0;
}

// 统计 turn 内 tool_use / thinking 数(视觉上表现"在工作")
function _countToolUseInTurn(instanceId, sinceTs) {
  const row = db.prepare(`
    SELECT COUNT(*) as n FROM messages
    WHERE instance_id = ? AND ts > ?
      AND (event_type LIKE 'system/thinking%' OR event_type = 'assistant')
  `).get(instanceId, sinceTs);
  return row?.n || 0;
}

function _checkOne(instanceId, threadSlug, roleName) {
  const turnStart = _fetchTurnStartTs(instanceId);
  if (!turnStart) return null;
  const turnDurMs = Date.now() - turnStart;
  if (turnDurMs < TURN_MIN_MS) return null;  // 太短不关注

  const lastEventTs = _fetchLastEventTs(instanceId);
  const silentMs = Date.now() - lastEventTs;
  const toolUseCount = _countToolUseInTurn(instanceId, turnStart);

  const durMin = Math.floor(turnDurMs / 60000);
  const durSec = Math.floor((turnDurMs % 60000) / 1000);
  const durStr = `${durMin}m ${durSec}s`;

  let severity, message, suggestedAction;
  if (silentMs < RECENT_ACTIVITY_MS) {
    // 在工作 — info,让 UI 知道"正常"
    severity = 'info';
    message = `${roleName || instanceId} 正常在跑(已 ${durStr},最近事件 ${Math.floor(silentMs/1000)}s 前 · turn 内 ${toolUseCount} 次工具/思考)`;
  } else if (silentMs < CRITICAL_MS) {
    severity = 'warn';
    message = `${roleName || instanceId} busy 但静默 ${Math.floor(silentMs/1000)}s(turn 已 ${durStr},内含 ${toolUseCount} 次事件),可能长思考中`;
  } else {
    severity = 'error';
    message = `${roleName || instanceId} busy 但静默 ${Math.floor(silentMs/60000)}min(turn 已 ${durStr}),疑似真卡死`;
    suggestedAction = {
      label: '强制解卡(翻 idle)',
      kind: 'unstick',
      endpoint: `/api/instances/${instanceId}/unstick`,
      body: {},
      confirmPrompt: `确认强制解卡 ${roleName || instanceId}?(它当前 busy,解卡后消息可能丢失)`,
    };
  }

  return {
    ruleId: RULE_ID,
    severity,
    threadSlug,
    instanceId,
    message,
    detectedAt: Date.now(),
    dedupKey: `${RULE_ID}:${instanceId}:${turnStart}`,  // 同 turn 只报一次(升级 severity 时更新)
    evidence: {
      turnStartTs: turnStart,
      turnStartIso: new Date(turnStart).toISOString(),
      turnDurMs,
      lastEventTs,
      silentMs,
      toolUseCount,
    },
    suggestedAction,
  };
}

async function check() {
  const rows = db.prepare(`
    SELECT id, role_name, bound_thread_slug FROM role_instances
    WHERE status = 'busy' AND bound_thread_slug IS NOT NULL
  `).all();
  const findings = [];
  for (const r of rows) {
    const f = _checkOne(r.id, r.bound_thread_slug, r.role_name);
    if (f) findings.push(f);
  }
  return findings;
}

// 事件驱动:instance.status_change to='busy' 时不立即报(要等 > TURN_MIN_MS),
// 让 cron 每 30s 兜底。这里只处理 to='idle' 清理:turn 结束了,mark 相关 long_turn resolved
function subscribe(bus, dispatch) {
  const handler = (payload) => {
    if (payload.to !== 'idle') return;
    // turn 结束 → 该 inst 的 long_turn finding 自动 resolve(靠 store predicate)
    const store = require('../store');
    store.markResolvedByPredicate((f) =>
      f.ruleId === RULE_ID && f.instanceId === payload.instanceId
    );
  };
  const unsub = bus.subscribe('instance.status_change', handler);
  return typeof unsub === 'function' ? unsub : (() => {});
}

module.exports = { id: RULE_ID, check, subscribe };
