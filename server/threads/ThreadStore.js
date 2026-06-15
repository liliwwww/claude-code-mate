// ============================================================================
// MODULE CONTRACT(架构 SSOT:docs/architecture.md §3 §4 §6)
// ----------------------------------------------------------------------------
// 层:L1 Domain Stores
// 责任:Thread 实体 CRUD + stage state machine + role-instance binding metadata
// 公共 API:list / get / create / setStage / setTitle / touch / bindInstance
// 允许依赖:db
// 禁止:
//   - 调 SpawnManager(thread 不知道 instance lifecycle)
//   - 直接发 bus 事件(调用方决定)
//   - 跨 project 操作(scope 严格 per project_id)
// ============================================================================
//
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

  // [需求@2026-06-10 §1.4] slug 默认自动生成(t-<base36>),user 不感知
  //   如果调用方没传 slug,自动生成一个 collision-free 的
  // [需求@2026-06-15] 显式传 title(非空字符串) → metadata.title_locked=true,
  //   后续 SystemAgent 跳过该 thread 的自动 title 摘要(user 设了不动)
  create(projectId, { slug, title }) {
    if (!projectId) throw new Error('projectId required');
    if (!slug) {
      slug = 't-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    }
    if (typeof slug !== 'string') throw new Error('slug must be a string');
    if (!SLUG_RE.test(slug)) {
      throw new Error('slug must match [a-z0-9][a-z0-9_-]{0,63} (case-insensitive)');
    }
    const existing = stmts.get.get(projectId, slug);
    if (existing) throw new Error(`thread "${slug}" already exists in this project`);

    const userProvidedTitle = typeof title === 'string' && title.trim().length > 0;
    const now = Date.now();
    const metadata = {
      // [需求@2026-06-10] 线索绑定到具体实例 — 一个角色 type 当前最多一个 active 实例
      // [需求@2026-06-12] 加 advisor 槽位给 mateBot(只在 System thread 用)
      current_role_instances: {
        requirements: null,
        orchestrator: null,
        executor: null,
        validator: null,
        advisor: null,
      },
      // For Phase 2C session-TTL anti-rot check
      last_session_activity_at: {},
      // For Phase 3 integration with the doc/queue/ file protocol
      queue_file_path: null,
      // [需求@2026-06-15] user 显式给了 title → 锁住,自动摘要不覆盖
      ...(userProvidedTitle ? { title_locked: true } : {}),
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

  // [需求@2026-06-15] fromUser 区分:
  //   - fromUser=true(默认,human 显式改名 / 创建时取的名):title_locked=true,SystemAgent 永不覆盖
  //   - fromUser=false(SystemAgent 自动摘要):不动 title_locked,允许被后续 user 改盖
  setTitle(projectId, slug, newTitle, { fromUser = true } = {}) {
    const cur = ThreadStore.get(projectId, slug);
    if (!cur) throw new Error(`thread ${slug} not found`);
    stmts.updateTitle.run(newTitle, Date.now(), projectId, slug);
    if (fromUser) {
      const meta = cur.metadata || {};
      if (!meta.title_locked) {
        const merged = { ...meta, title_locked: true };
        db.prepare(`UPDATE threads SET metadata_json = ? WHERE project_id = ? AND slug = ?`)
          .run(JSON.stringify(merged), projectId, slug);
      }
    }
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
