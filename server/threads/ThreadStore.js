// [需求@2026-06-10] 线索 = user 需求(一等公民),Phase 2B 主视图就是线索看板。
//   线索的生命周期:discussing → designing → executing → testing → verified → closed
//   每条线索绑定 0..N 个角色实例(metadata.current_role_instances[roleType] = instanceId)
//   线索的真理在 SQLite,不在 claude session 里 — 进程死/重启都不影响线索本身
//
// ThreadStore 是 `threads` 表的 CRUD 封装。

const { db } = require('../db');

const ALLOWED_STAGES = ['discussing', 'designing', 'executing', 'testing', 'verified', 'closed'];
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

const stmts = {
  list: db.prepare(`
    SELECT slug, project_id, title, stage, created_at, updated_at, metadata_json
    FROM threads
    WHERE project_id = ? AND stage != 'closed'
    ORDER BY updated_at DESC
  `),
  listAll: db.prepare(`
    SELECT slug, project_id, title, stage, created_at, updated_at, metadata_json
    FROM threads
    WHERE project_id = ?
    ORDER BY updated_at DESC
  `),
  get: db.prepare(`
    SELECT slug, project_id, title, stage, created_at, updated_at, metadata_json
    FROM threads
    WHERE project_id = ? AND slug = ?
  `),
  insert: db.prepare(`
    INSERT INTO threads (slug, project_id, title, stage, created_at, updated_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  updateStage: db.prepare(`
    UPDATE threads SET stage = ?, updated_at = ?
    WHERE project_id = ? AND slug = ?
  `),
  updateTitle: db.prepare(`
    UPDATE threads SET title = ?, updated_at = ?
    WHERE project_id = ? AND slug = ?
  `),
  updateMetadata: db.prepare(`
    UPDATE threads SET metadata_json = ?, updated_at = ?
    WHERE project_id = ? AND slug = ?
  `),
};

function hydrate(row) {
  if (!row) return null;
  return {
    projectId: row.project_id,
    slug: row.slug,
    title: row.title,
    stage: row.stage,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: JSON.parse(row.metadata_json || '{}'),
  };
}

const ThreadStore = {
  ALLOWED_STAGES,

  list(projectId, { includeClosed = false } = {}) {
    const rows = includeClosed ? stmts.listAll.all(projectId) : stmts.list.all(projectId);
    return rows.map(hydrate);
  },

  get(projectId, slug) {
    return hydrate(stmts.get.get(projectId, slug));
  },

  create(projectId, { slug, title }) {
    if (!projectId) throw new Error('projectId required');
    if (!slug || typeof slug !== 'string') throw new Error('slug required');
    if (!SLUG_RE.test(slug)) {
      throw new Error('slug must match [a-z0-9][a-z0-9_-]{0,63} (case-insensitive)');
    }
    const existing = stmts.get.get(projectId, slug);
    if (existing) throw new Error(`thread "${slug}" already exists in this project`);

    const now = Date.now();
    const metadata = {
      // [需求@2026-06-10] 线索绑定到具体实例 — 一个角色 type 当前最多一个 active 实例
      current_role_instances: {
        requirements: null,
        orchestrator: null,
        executor: null,
        validator: null,
      },
      // For Phase 2C session-TTL anti-rot check
      last_session_activity_at: {},
      // For Phase 3 integration with the doc/queue/ file protocol
      queue_file_path: null,
    };
    stmts.insert.run(slug, projectId, title || slug, 'discussing', now, now, JSON.stringify(metadata));
    return ThreadStore.get(projectId, slug);
  },

  setStage(projectId, slug, newStage) {
    if (!ALLOWED_STAGES.includes(newStage)) {
      throw new Error(`stage must be one of: ${ALLOWED_STAGES.join(', ')}`);
    }
    const cur = ThreadStore.get(projectId, slug);
    if (!cur) throw new Error(`thread ${slug} not found`);
    stmts.updateStage.run(newStage, Date.now(), projectId, slug);
    return ThreadStore.get(projectId, slug);
  },

  setTitle(projectId, slug, newTitle) {
    const cur = ThreadStore.get(projectId, slug);
    if (!cur) throw new Error(`thread ${slug} not found`);
    stmts.updateTitle.run(newTitle, Date.now(), projectId, slug);
    return ThreadStore.get(projectId, slug);
  },

  /**
   * Patch a single key under metadata.current_role_instances[roleType].
   * [需求@2026-06-10] 用于 SpawnManager 绑定/解绑角色实例到线索。
   */
  bindInstance(projectId, slug, roleType, instanceId) {
    const cur = ThreadStore.get(projectId, slug);
    if (!cur) throw new Error(`thread ${slug} not found`);
    const meta = cur.metadata;
    meta.current_role_instances = meta.current_role_instances || {};
    meta.current_role_instances[roleType] = instanceId;
    meta.last_session_activity_at = meta.last_session_activity_at || {};
    meta.last_session_activity_at[roleType] = Date.now();
    stmts.updateMetadata.run(JSON.stringify(meta), Date.now(), projectId, slug);
    return ThreadStore.get(projectId, slug);
  },

  /**
   * Reset last_session_activity_at for a role type — used as TTL rolling timer (Phase 2C).
   */
  touch(projectId, slug, roleType) {
    const cur = ThreadStore.get(projectId, slug);
    if (!cur) return;
    const meta = cur.metadata;
    meta.last_session_activity_at = meta.last_session_activity_at || {};
    meta.last_session_activity_at[roleType] = Date.now();
    stmts.updateMetadata.run(JSON.stringify(meta), Date.now(), projectId, slug);
  },
};

module.exports = ThreadStore;
