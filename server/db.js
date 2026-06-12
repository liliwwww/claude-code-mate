// SQLite layer using better-sqlite3 (synchronous, single-process app).
// Owns the schema, migrations, and exposes a singleton `db` connection.
//
// [需求@2026-06-10] 多 project first-class (user Q1/Q4):
//   - 新增 projects 表
//   - threads/role_instances/messages/dispatches/events 加 project_id 外键
//   - 已有 Phase 1 数据通过 migration 归入 default project(id=1, name='Default', root_dir=mate's own root)
//
// [需求@2026-06-10] 数据永久持久化:WAL 模式 + 重启 lazy 恢复(SpawnManager.restoreFromDisk)
//   保证程序重启不丢任何线索/对话/实例状态。

const Database = require('better-sqlite3');
const path = require('node:path');
const config = require('./config');

const db = new Database(config.paths.sqlite);

// Pragmas: WAL for crash-safety + concurrent reads while writing.
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

// ============================================================================
// Schema (idempotent, all CREATE IF NOT EXISTS)
// ============================================================================

// [需求@2026-06-10] 三段式 schema 应用,兼容 Phase 1 老库 + 新装库:
// 1) 用 v1 schema(无 project_id)CREATE IF NOT EXISTS — 老库不变,新库建空表
// 2) Migration: 加 projects 表 + ALTER 老表加 project_id + 回填 default project
// 3) 在升级后的 schema 上 CREATE INDEX (含 project_id 的索引)

// --- Step 1: v1 base schema(idempotent) ---
db.exec(`
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  slug          TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  stage         TEXT NOT NULL DEFAULT 'discussing',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS role_instances (
  id                 TEXT PRIMARY KEY,
  role_name          TEXT NOT NULL,
  pid                INTEGER,
  claude_session_id  TEXT,
  status             TEXT NOT NULL,
  bound_thread_slug  TEXT,
  spawn_args_json    TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  last_active_at     INTEGER NOT NULL,
  died_at            INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_slug        TEXT,
  instance_id        TEXT,
  role_name          TEXT,
  direction          TEXT NOT NULL,
  claude_session_id  TEXT,
  ts                 INTEGER NOT NULL,
  event_type         TEXT,
  payload_json       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dispatches (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_slug          TEXT NOT NULL,
  from_role            TEXT NOT NULL,
  to_role              TEXT NOT NULL,
  to_instance_id       TEXT,
  handoff_file_path    TEXT,
  dispatch_file_path   TEXT,
  dispatched_at        INTEGER NOT NULL,
  acknowledged_at      INTEGER,
  completed_at         INTEGER,
  outcome              TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  thread_slug  TEXT,
  instance_id  TEXT,
  payload_json TEXT NOT NULL
);
`);

// --- Step 2: migrations ---
// v1 -> v2: add projects + project_id columns
// v2 -> v3 [需求@2026-06-12]: pool_slot for role_instances + is_system for projects
//          + ensureSystemProject + ensureSystemThread
// v3 -> v4 [需求@2026-06-12 §9 mateTerm]:
//          messages.direct_target 列(直连模式消息的目标 instance);
//          删除 mate-self thread bootstrap(mateBot 砍掉,System project 保留)
const SCHEMA_VERSION = 4;
let cur = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get();
let curVersion = cur ? parseInt(cur.value, 10) : 1;

function tableHasColumn(table, col) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === col);
}

function ensureProjectsTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL UNIQUE,
      root_dir      TEXT NOT NULL,
      settings_json TEXT NOT NULL DEFAULT '{}',
      created_at    INTEGER NOT NULL,
      archived_at   INTEGER
    );
  `);
}

function ensureDefaultProject() {
  const existing = db.prepare(`SELECT id FROM projects WHERE name = 'Default'`).get();
  if (existing) return existing.id;
  const path = require('node:path');
  const ROOT = path.resolve(__dirname, '..');
  const r = db.prepare(`
    INSERT INTO projects (name, root_dir, settings_json, created_at)
    VALUES (?, ?, ?, ?)
  `).run('Default', ROOT, '{}', Date.now());
  return r.lastInsertRowid;
}

if (curVersion < 2) {
  ensureProjectsTable();
  const oldTables = ['threads', 'role_instances', 'messages', 'dispatches', 'events'];
  for (const t of oldTables) {
    if (!tableHasColumn(t, 'project_id')) {
      db.exec(`ALTER TABLE ${t} ADD COLUMN project_id INTEGER`);
    }
  }
  const defaultId = ensureDefaultProject();
  for (const t of oldTables) {
    db.prepare(`UPDATE ${t} SET project_id = ? WHERE project_id IS NULL`).run(defaultId);
  }
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).run('schema_version', '2');
  curVersion = 2;
} else {
  ensureProjectsTable();
  ensureDefaultProject();
}

// [需求@2026-06-12 §8.2] v2 -> v3:
//   projects.is_system flag (1 = hidden System project for mate-self chat)
//   role_instances.pool_slot integer (NULL for non-pooled R; 1..N for pooled execB/testC/H)
//   Auto-create System project + mate-self singleton thread
if (curVersion < 3) {
  if (!tableHasColumn('projects', 'is_system')) {
    db.exec(`ALTER TABLE projects ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0`);
  }
  if (!tableHasColumn('role_instances', 'pool_slot')) {
    db.exec(`ALTER TABLE role_instances ADD COLUMN pool_slot INTEGER`);
  }
  ensureSystemProject();
  // v3 once created `mate-self` thread; v4 migration removes it (see below).
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).run('schema_version', '3');
  curVersion = 3;
} else {
  // Even on already-v3 DBs, make sure System project exists (fresh install / accidental delete)
  ensureSystemProject();
}

// [需求@2026-06-12 §9] v3 -> v4 mateTerm:
//   messages.direct_target 列 = 直连模式下消息的目标 instance.id(thread_slug 为 NULL)
//   并删除 §8.2 创建的 mate-self thread(mateBot 方案已废弃)
if (curVersion < 4) {
  if (!tableHasColumn('messages', 'direct_target')) {
    db.exec(`ALTER TABLE messages ADD COLUMN direct_target TEXT`);
  }
  // Drop the now-defunct mate-self thread; System project itself stays (it's cheap).
  try {
    const sys = db.prepare(`SELECT id FROM projects WHERE is_system = 1`).get();
    if (sys) {
      db.prepare(`DELETE FROM threads WHERE project_id = ? AND slug = 'mate-self'`).run(sys.id);
    }
  } catch (e) {
    console.warn(`[db] v4 mate-self cleanup failed: ${e.message}`);
  }
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).run('schema_version', '4');
  curVersion = 4;
}

function ensureSystemProject() {
  const existing = db.prepare(`SELECT id FROM projects WHERE name = 'System'`).get();
  if (existing) return existing.id;
  const path = require('node:path');
  const ROOT = path.resolve(__dirname, '..');
  const r = db.prepare(`
    INSERT INTO projects (name, root_dir, settings_json, created_at, is_system)
    VALUES (?, ?, ?, ?, 1)
  `).run('System', ROOT, '{"hidden":true}', Date.now());
  return r.lastInsertRowid;
}

// [需求@2026-06-12 §9] ensureSystemThread 删除:
//   原 mate-self 单例 thread 是为 mateBot 准备的;mateBot 已废弃,改用 mateTerm 直连机制。
//   System project 仍保留(便宜,后续可能复用)。v4 migration 会清空遗留的 mate-self thread 行。

// --- Step 3: indexes (safe to recreate on v2 schema) ---
db.exec(`
CREATE INDEX IF NOT EXISTS idx_threads_stage_v2        ON threads(project_id, stage);
CREATE INDEX IF NOT EXISTS idx_threads_updated_v2      ON threads(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_instances_proj_role_st  ON role_instances(project_id, role_name, status);
CREATE INDEX IF NOT EXISTS idx_messages_thread_ts_v2   ON messages(project_id, thread_slug, ts);
CREATE INDEX IF NOT EXISTS idx_messages_instance_ts    ON messages(instance_id, ts);
CREATE INDEX IF NOT EXISTS idx_messages_session        ON messages(claude_session_id);
CREATE INDEX IF NOT EXISTS idx_messages_direct_ts      ON messages(direct_target, ts);
CREATE INDEX IF NOT EXISTS idx_events_kind_ts          ON events(kind, ts DESC);
`);

// ============================================================================
// Prepared-statement helpers (hot path)
// ============================================================================

const stmts = {
  // [需求@2026-06-10] project_id 字段在所有 hot-path statements 里贯通
  // [需求@2026-06-12 §9] direct_target 字段:
  //   非 null 时表示这是 mateTerm 直连消息(thread_slug 为 NULL),持久化跟 instance 绑定
  insertMessage: db.prepare(`
    INSERT INTO messages (project_id, thread_slug, instance_id, role_name, direction, claude_session_id, ts, event_type, payload_json, direct_target)
    VALUES (@project_id, @thread_slug, @instance_id, @role_name, @direction, @claude_session_id, @ts, @event_type, @payload_json, @direct_target)
  `),
  // [需求@2026-06-12 §8.3] pool_slot 字段贯通持久化
  upsertInstance: db.prepare(`
    INSERT INTO role_instances (id, project_id, role_name, pid, claude_session_id, status, bound_thread_slug, spawn_args_json, created_at, last_active_at, pool_slot)
    VALUES (@id, @project_id, @role_name, @pid, @claude_session_id, @status, @bound_thread_slug, @spawn_args_json, @created_at, @last_active_at, @pool_slot)
    ON CONFLICT(id) DO UPDATE SET
      pid               = excluded.pid,
      claude_session_id = excluded.claude_session_id,
      status            = excluded.status,
      bound_thread_slug = excluded.bound_thread_slug,
      last_active_at    = excluded.last_active_at,
      pool_slot         = excluded.pool_slot
  `),
  setInstanceStatus: db.prepare(`UPDATE role_instances SET status = ?, last_active_at = ? WHERE id = ?`),
  setInstanceDied:   db.prepare(`UPDATE role_instances SET status = 'dead', died_at = ? WHERE id = ?`),
  setInstanceSession:db.prepare(`UPDATE role_instances SET claude_session_id = ?, last_active_at = ? WHERE id = ?`),

  listInstancesByProject: db.prepare(`SELECT * FROM role_instances WHERE project_id = ? AND status != 'dead' ORDER BY created_at`),
  listAllNonDeadInstances:db.prepare(`SELECT * FROM role_instances WHERE status != 'dead' ORDER BY created_at`),
  listMessages:           db.prepare(`SELECT * FROM messages WHERE instance_id = ? ORDER BY ts ASC LIMIT ?`),
  recentMessages:         db.prepare(`SELECT * FROM messages WHERE instance_id = ? ORDER BY ts DESC LIMIT ?`),

  insertEvent: db.prepare(`INSERT INTO events (project_id, ts, kind, thread_slug, instance_id, payload_json) VALUES (?, ?, ?, ?, ?, ?)`),

  // Project CRUD
  // [需求@2026-06-12] 默认 list 过滤 is_system(=1 是 mate self chat 用的隐藏 System project)
  listProjects:       db.prepare(`SELECT * FROM projects WHERE archived_at IS NULL AND is_system = 0 ORDER BY id`),
  listAllProjects:    db.prepare(`SELECT * FROM projects WHERE archived_at IS NULL ORDER BY id`),
  getProject:         db.prepare(`SELECT * FROM projects WHERE id = ?`),
  getProjectByName:   db.prepare(`SELECT * FROM projects WHERE name = ?`),
  getSystemProject:   db.prepare(`SELECT * FROM projects WHERE is_system = 1 LIMIT 1`),
  insertProject:      db.prepare(`INSERT INTO projects (name, root_dir, settings_json, created_at) VALUES (?, ?, ?, ?)`),
  archiveProject:     db.prepare(`UPDATE projects SET archived_at = ? WHERE id = ?`),
};

module.exports = {
  db,
  stmts,
  // convenience wrappers — project_id is REQUIRED in Phase 2A onward
  // [需求@2026-06-10] 所有持久化必须带 project_id
  recordMessage(msg) {
    stmts.insertMessage.run({
      project_id: msg.projectId,
      thread_slug: msg.threadSlug || null,
      instance_id: msg.instanceId || null,
      role_name: msg.roleName || null,
      direction: msg.direction,
      claude_session_id: msg.claudeSessionId || null,
      ts: msg.ts ?? Date.now(),
      event_type: msg.eventType || null,
      payload_json: typeof msg.payload === 'string' ? msg.payload : JSON.stringify(msg.payload ?? {}),
      // [需求@2026-06-12 §9] mateTerm 直连消息标记;为 null 时表示普通 thread 消息
      direct_target: msg.directTarget || null,
    });
  },
  recordEvent(kind, payload, opts = {}) {
    stmts.insertEvent.run(
      opts.projectId ?? null,
      Date.now(),
      kind,
      opts.threadSlug || null,
      opts.instanceId || null,
      typeof payload === 'string' ? payload : JSON.stringify(payload ?? {})
    );
  },
};
