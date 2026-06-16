// ============================================================================
// MODULE CONTRACT(架构 SSOT:docs/architecture.md §3 §4 §6)
// ----------------------------------------------------------------------------
// 层:L1 Domain Stores
// 责任:events 表 CRUD + 业务查询(派工时序 / handoff 历史 / project 维度过滤)
// 公共 API:
//   record(kind, payload, opts) → eventId
//   list({ kinds, projectId, threadSlug, instanceId, sinceTs, untilTs, limit, order })
//   listByKind(kind, opts)
//   listDispatchHistory({ limit })       — dashboard tab 3 派工时序
//   listRecentHandoffsForProject(projectId, limit) — H 任务面板
// 允许依赖:db(L0)
// 禁止:
//   - 调 SpawnManager / RoleInstance(单向依赖)
//   - 直接发 bus 事件(调用方决定)
//   - 跨业务实体 join(各 store 各管自己)
// ============================================================================
//
// [arch-debt §3+§6 ✅ 2026-06-13] events 表的统一 store。
//   原行为:`db.recordEvent` insert + 各处散落 `db.prepare('SELECT FROM events ...')`
//   现在:insert 仍走 db.recordEvent(向后兼容,13 处现有调用不动);
//        所有 SELECT 集中到 EventStore.list* 系列。

const { db } = require('../db');

// 预编译 statements(热路径)
const stmts = {
  // 派工时序 — dashboard tab 3 用,跨 project
  //   Phase 2H 加 dispatch.rejected,跟 thread.* 一起在一个 timeline 显示
  selectDispatchHistory: db.prepare(`
    SELECT id, project_id, ts, kind, thread_slug, instance_id, payload_json
    FROM events
    WHERE kind IN ('thread.handoff', 'thread.done', 'thread.blocked', 'dispatch.rejected')
    ORDER BY ts DESC LIMIT ?
  `),
  // H 任务面板用:某 project 最近 N 个 thread.handoff
  selectRecentHandoffsForProject: db.prepare(`
    SELECT ts, thread_slug, payload_json
    FROM events
    WHERE project_id = ? AND kind = 'thread.handoff'
    ORDER BY ts DESC LIMIT ?
  `),
  // 通用查询(filter 由调用方组装 SQL — 这里仅用于聚合 count)
  countByKind: db.prepare(`SELECT kind, COUNT(*) AS n FROM events GROUP BY kind`),
};

/**
 * 写入一个 event。**等价于 db.recordEvent**(向后兼容包装,新代码用本函数)。
 *
 * @param {string} kind          事件 kind (e.g. 'thread.handoff')
 * @param {Object} payload       事件 payload(自动 JSON.stringify)
 * @param {Object} opts          可选 { projectId, threadSlug, instanceId }
 * @returns {number}             插入的 rowid
 */
function record(kind, payload, opts = {}) {
  // delegate 到 db.recordEvent 保持单点写
  const { recordEvent } = require('../db');
  recordEvent(kind, payload, opts);
  // recordEvent 不返 id;若需要 id 走 list 兜底。本函数返 0(本轮无 caller 关心 id)
  return 0;
}

/**
 * 通用查询。
 *
 * @param {Object} opts
 * @param {string[]} [opts.kinds]      kind 过滤(IN ...);省略 = 所有 kind
 * @param {number}   [opts.projectId]  project 过滤
 * @param {string}   [opts.threadSlug] thread 过滤
 * @param {string}   [opts.instanceId] instance 过滤
 * @param {number}   [opts.sinceTs]    ts >= sinceTs(包括)
 * @param {number}   [opts.untilTs]    ts <= untilTs(包括)
 * @param {number}   [opts.limit=200]  最多多少条
 * @param {'asc'|'desc'} [opts.order='desc']
 * @returns {Object[]}  parsed events,payload 已 JSON.parse
 */
function list(opts = {}) {
  const limit = Math.min(opts.limit ?? 200, 2000);
  const order = opts.order === 'asc' ? 'ASC' : 'DESC';
  const where = [];
  const args = [];
  if (opts.kinds && opts.kinds.length) {
    where.push(`kind IN (${opts.kinds.map(() => '?').join(',')})`);
    args.push(...opts.kinds);
  }
  if (opts.projectId != null) { where.push('project_id = ?'); args.push(opts.projectId); }
  if (opts.threadSlug) { where.push('thread_slug = ?'); args.push(opts.threadSlug); }
  if (opts.instanceId) { where.push('instance_id = ?'); args.push(opts.instanceId); }
  if (opts.sinceTs != null) { where.push('ts >= ?'); args.push(opts.sinceTs); }
  if (opts.untilTs != null) { where.push('ts <= ?'); args.push(opts.untilTs); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sql = `
    SELECT id, project_id, ts, kind, thread_slug, instance_id, payload_json
    FROM events ${whereSql}
    ORDER BY ts ${order}, id ${order} LIMIT ?
  `;
  args.push(limit);
  const rows = db.prepare(sql).all(...args);
  return rows.map(parseRow);
}

/**
 * 派工时序 — dashboard tab 3 用。返 3 类 event 跨所有 project。
 */
function listDispatchHistory({ limit = 200 } = {}) {
  const rows = stmts.selectDispatchHistory.all(Math.min(limit, 500));
  return rows.map(parseRow);
}

/**
 * 某 project 最近 N 个 thread.handoff — H 任务面板 _buildTaskBoardSnapshot 用。
 * 返回 raw row(ts / thread_slug / payload_json),保持原 _buildTaskBoardSnapshot
 * 处理风格(不强制 parse,因为它就在 try/catch 里 parse)。
 */
function listRecentHandoffsForProject(projectId, limit = 5) {
  return stmts.selectRecentHandoffsForProject.all(projectId, Math.min(limit, 100));
}

/**
 * kind 维度计数(诊断 / 监控用)
 */
function countByKind() {
  const rows = stmts.countByKind.all();
  const out = {};
  for (const r of rows) out[r.kind] = r.n;
  return out;
}

function parseRow(r) {
  let payload = {};
  try { payload = JSON.parse(r.payload_json || '{}'); } catch {}
  return {
    id: r.id,
    projectId: r.project_id,
    ts: r.ts,
    kind: r.kind,
    threadSlug: r.thread_slug,
    instanceId: r.instance_id,
    payload,
  };
}

module.exports = {
  record,
  list,
  listDispatchHistory,
  listRecentHandoffsForProject,
  countByKind,
};
