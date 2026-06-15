// ============================================================================
// MODULE CONTRACT(架构 SSOT:docs/architecture.md §3 §4 §6)
// ----------------------------------------------------------------------------
// 层:L2 Process Control
// 责任:mate_pending_sends 表的薄包装(CRUD only)
// 公共 API:enqueue / listForTarget / listAll / listByProject / remove /
//   count / countByProject / countByReason
// 允许依赖:db(L0)
// 禁止:
//   - 解释队列语义(SpawnManager / QuotaState 调用方决定何时入队/何时 flush)
//   - 自己 publish bus 事件(让调用方决定)
// ============================================================================
//
// [需求@2026-06-12 Phase 2E §1.5 §3 §6] mate_pending_sends 表的薄包装
//
// 用途两面:
//   §3 mateTerm 直连 busy 实例 → 进 queue,等 inst idle 自动 flush
//   §6 quota PAUSED 期间 user send + handoff marker → 进 queue,等 reset 自动 flush
//
// 单条记录形态:
//   {
//     id: <auto>,
//     kind: 'direct_send' | 'thread_send' | 'handoff_marker',
//     target_kind: 'instance' | 'thread',
//     target_id: <instance.id 或 thread_slug>,
//     project_id: <可选>,
//     payload: { text, ... } 或 { fromInstanceId, target, reason, ... }(handoff),
//     reason: 'busy' | 'quota_pause' | 'spawning'
//   }

const { stmts } = require('../db');

// [需求@2026-06-15 Phase 2G] 加 status / dispatch_chain / thread_slug / from_instance_id
//   status 默认 'queued'(向后兼容);新代码显式传 'waiting_user' / 'backlog'
function enqueue({
  kind, targetKind, targetId, projectId = null, payload, reason,
  status = 'queued', dispatchChain = null, threadSlug = null, fromInstanceId = null,
}) {
  if (!kind || !targetKind || !targetId || !payload || !reason) {
    throw new Error(`PendingSends.enqueue requires kind/targetKind/targetId/payload/reason`);
  }
  const r = stmts.psEnqueue.run({
    kind,
    target_kind: targetKind,
    target_id: targetId,
    project_id: projectId,
    payload_json: typeof payload === 'string' ? payload : JSON.stringify(payload),
    enqueued_at: Date.now(),
    reason,
    status,
    dispatch_chain: dispatchChain ? (typeof dispatchChain === 'string' ? dispatchChain : JSON.stringify(dispatchChain)) : null,
    thread_slug: threadSlug,
    from_instance_id: fromInstanceId,
  });
  return r.lastInsertRowid;
}

function listForTarget(targetKind, targetId) {
  return stmts.psListByTarget.all(targetKind, targetId).map(parseRow);
}

function listAll() {
  return stmts.psListAll.all().map(parseRow);
}

function listByProject(projectId) {
  return stmts.psListByProject.all(projectId).map(parseRow);
}

function remove(id) {
  return stmts.psDelete.run(id);
}

function count() {
  return stmts.psCount.get().n;
}

function countByProject(projectId) {
  return stmts.psCountByProject.get(projectId).n;
}

function countByReason() {
  // returns { busy: N, quota_pause: M, ... }
  const rows = stmts.psCountByReason.all();
  const out = {};
  for (const r of rows) out[r.reason || 'unknown'] = r.n;
  return out;
}

function parseRow(r) {
  if (!r) return null;
  let payload = null;
  try { payload = JSON.parse(r.payload_json); } catch { payload = { _parse_error: true, raw: r.payload_json }; }
  let dispatchChain = null;
  if (r.dispatch_chain) {
    try { dispatchChain = JSON.parse(r.dispatch_chain); } catch { dispatchChain = []; }
  }
  return {
    id: r.id,
    kind: r.kind,
    targetKind: r.target_kind,
    targetId: r.target_id,
    projectId: r.project_id,
    payload,
    enqueuedAt: r.enqueued_at,
    reason: r.reason,
    // [v7 字段]
    status: r.status || 'queued',
    dispatchChain,
    threadSlug: r.thread_slug || null,
    fromInstanceId: r.from_instance_id || null,
    backlogAt: r.backlog_at || null,
    processedAt: r.processed_at || null,
    cancelledAt: r.cancelled_at || null,
    cancelReason: r.cancel_reason || null,
  };
}

// ============================== v7 state machine helpers ==============================

function getById(id) {
  return parseRow(stmts.psGetById.get(id));
}

function listByStatus(status) {
  return stmts.psListByStatus.all(status).map(parseRow);
}

function listByThread(threadSlug) {
  return stmts.psListByThread.all(threadSlug).map(parseRow);
}

// 状态机迁移
function markBacklog(id) {
  return stmts.psSetBacklog.run(Date.now(), id);
}

function markQueued(id) {
  return stmts.psSetStatus.run('queued', null, id);
}

function markProcessing(id) {
  return stmts.psSetStatus.run('processing', Date.now(), id);
}

function markCancelled(id, reason = null) {
  return stmts.psSetCancelled.run(Date.now(), reason, id);
}

// 找最早可派发的 queued 项,匹配 (target_kind, target_id)
function findOldestQueuedFor(targetKind, targetId) {
  return parseRow(stmts.psFindOldestQueuedFor.get(targetKind, targetId));
}

module.exports = {
  enqueue,
  listForTarget,
  listAll,
  listByProject,
  listByStatus,
  listByThread,
  getById,
  remove,
  count,
  countByProject,
  countByReason,
  markBacklog,
  markQueued,
  markProcessing,
  markCancelled,
  findOldestQueuedFor,
};
