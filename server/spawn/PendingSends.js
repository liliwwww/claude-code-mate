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

function enqueue({ kind, targetKind, targetId, projectId = null, payload, reason }) {
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
  return {
    id: r.id,
    kind: r.kind,
    targetKind: r.target_kind,
    targetId: r.target_id,
    projectId: r.project_id,
    payload,
    enqueuedAt: r.enqueued_at,
    reason: r.reason,
  };
}

module.exports = {
  enqueue,
  listForTarget,
  listAll,
  listByProject,
  remove,
  count,
  countByProject,
  countByReason,
};
