// ============================================================================
// MODULE CONTRACT(架构 SSOT:docs/architecture.md §3 §4 §6)
// ----------------------------------------------------------------------------
// 层:L0 Infrastructure
// 责任:SQLite 连接 + schema + migrations + prepared statements + 通用 helper
// 公共 API:export { db, stmts, recordMessage, recordEvent }
// 允许依赖:仅 config(L0 内部)
// 禁止:
//   - 业务 store(那是 L1 — ProjectStore/ThreadStore 等;**recordMessage /
//     recordEvent 是历史包袱**,见 arch-debt §3,新加业务函数去 L1)
//   - 调任何 L1+ 模块(单向依赖)
//   - 处理 stream-json event(L2 spawn 的责任)
// ============================================================================
//
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
// v4 -> v5 [需求@2026-06-12 Phase 2E §1.5]:
//          mate_pending_sends + mate_quota_state 双表(§3 排队 + §6 quota 暂停共用)
// v5 -> v6 [2026-06-13]: mate 角色重命名 — planA-R/H/execB/testC → mate-R/H/B/C
//          物理隔离 sibling 项目同名 .claude/commands/*.md 的污染。
//          ALTER 不动 schema,只 UPDATE role_instances.role_name + 现有 events.payload_json
//          / messages.role_name 等都 lazy,新 role 名生效后自动 OK。
const SCHEMA_VERSION = 6;
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

// [需求@2026-06-12 Phase 2E §1.5] v4 -> v5:
//   mate_pending_sends:§3 mateTerm busy 排队 + §6 quota 暂停期间 user send / handoff marker 缓存
//   mate_quota_state:§6 5h / 7d 配额状态持久化,mate 重启后能恢复 PAUSED 态 + setTimer
if (curVersion < 5) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mate_pending_sends (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      kind            TEXT NOT NULL,         -- 'direct_send' | 'thread_send' | 'handoff_marker'
      target_kind     TEXT NOT NULL,         -- 'instance' | 'thread'
      target_id       TEXT NOT NULL,         -- instance.id 或 thread_slug
      project_id      INTEGER,
      payload_json    TEXT NOT NULL,
      enqueued_at     INTEGER NOT NULL,
      reason          TEXT                   -- 'busy' | 'quota_pause' | 'spawning'
    );
    CREATE INDEX IF NOT EXISTS idx_pending_sends_target ON mate_pending_sends(target_kind, target_id, enqueued_at);
    CREATE INDEX IF NOT EXISTS idx_pending_sends_reason ON mate_pending_sends(reason, enqueued_at);

    CREATE TABLE IF NOT EXISTS mate_quota_state (
      rate_limit_type TEXT PRIMARY KEY,      -- 'five_hour' | 'seven_day'
      status          TEXT NOT NULL,         -- 'allowed' | 'allowed_warning' | 'rate_limited' | 'manual_override'
      utilization     REAL,
      resets_at       INTEGER NOT NULL,      -- Unix ms(注意:rate_limit_event 给的是秒,这里统一换算成 ms)
      updated_at      INTEGER NOT NULL,
      manual_override INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).run('schema_version', '5');
  curVersion = 5;
}

// [2026-06-13] v5 -> v6:mate 角色重命名
//   planA-R → mate-R / planA-H → mate-H / execB → mate-B / testC → mate-C
//   把 role_instances.role_name + messages.role_name 全部翻新。
//   thread.metadata.current_role_instances 是按 role.type 映射的,不动。
//   instance.id 里也含老 role name(`planA-R.xxxxxx`),改 instance.id 风险大(各处外键引用),
//   保留旧 id;新查 / spawn 都用新 role 名。
if (curVersion < 6) {
  const RENAME_MAP = {
    'planA-R': 'mate-R',
    'planA-H': 'mate-H',
    'execB':   'mate-B',
    'testC':   'mate-C',
  };
  for (const [oldName, newName] of Object.entries(RENAME_MAP)) {
    try {
      const r1 = db.prepare(`UPDATE role_instances SET role_name = ? WHERE role_name = ?`).run(newName, oldName);
      const r2 = db.prepare(`UPDATE messages SET role_name = ? WHERE role_name = ?`).run(newName, oldName);
      if (r1.changes || r2.changes) {
        console.log(`[db v6] renamed ${oldName} → ${newName}: role_instances=${r1.changes}, messages=${r2.changes}`);
      }
    } catch (e) {
      console.warn(`[db v6] rename ${oldName} → ${newName} failed: ${e.message}`);
    }
  }
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).run('schema_version', '6');
  curVersion = 6;
}

// [2026-06-15] v6 -> v7:queue 状态机 + dispatch_chain
//   mate_pending_sends 扩字段:
//     - status: 'waiting_user' | 'queued' | 'backlog' | 'processing' | 'done' | 'cancelled'
//     - dispatch_chain: JSON 数组,thread.metadata 的快照(派工链)
//     - backlog_at / cancelled_at / processed_at:状态机时间戳
//     - cancel_reason: 文本(可选)
//     - from_instance_id: 触发派工的源实例(R 或 H)
//     - thread_slug: 关联线索(便于 UI 反查;原 target_id 也可能是 instance.id 没线索)
//
//   旧 row(reason='busy/quota_pause/spawning' 时无 status)默认补 status='queued'
//   保持向后兼容。
if (curVersion < 7) {
  const cols = [
    { name: 'status',           type: "TEXT NOT NULL DEFAULT 'queued'" },
    { name: 'dispatch_chain',   type: 'TEXT' },
    { name: 'thread_slug',      type: 'TEXT' },
    { name: 'from_instance_id', type: 'TEXT' },
    { name: 'backlog_at',       type: 'INTEGER' },
    { name: 'processed_at',     type: 'INTEGER' },
    { name: 'cancelled_at',     type: 'INTEGER' },
    { name: 'cancel_reason',    type: 'TEXT' },
  ];
  for (const { name, type } of cols) {
    if (!tableHasColumn('mate_pending_sends', name)) {
      db.exec(`ALTER TABLE mate_pending_sends ADD COLUMN ${name} ${type}`);
    }
  }
  // 给老 row 兜底 status(已有 NOT NULL DEFAULT 但 ALTER ADD 不回填):
  db.exec(`UPDATE mate_pending_sends SET status = 'queued' WHERE status IS NULL OR status = ''`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_sends_status   ON mate_pending_sends(status, enqueued_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_sends_thread   ON mate_pending_sends(thread_slug, status, enqueued_at)`);
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).run('schema_version', '7');
  curVersion = 7;
  console.log('[db v7] mate_pending_sends extended for queue state machine');
}

// [需求@2026-06-16] v7 -> v8:FTS5 全文检索
//   messages_fts:虚拟表,external content 模式(content=messages, content_rowid=id)
//   - INSERT INTO messages_fts(rowid, content) VALUES (msg.id, extracted_text)
//   - 搜索:SELECT m.* FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid WHERE messages_fts MATCH ?
//   - tokenize=unicode61:支持中英文混合搜索(基本 unicode 分词)
//   recordMessage 同步:每写 messages 就 INSERT INTO messages_fts(rowid, content)
//   backfill:扫所有现有 messages 提取 text 灌入(可能跑 5-30 秒,看数据量)
if (curVersion < 8) {
  try {
    // 不用 external content 模式(messages 没有 content 列);用普通 FTS5
    //   FTS5 自己维护 content,~4 MB 额外占用(8813 × 平均 500 bytes 估算)
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        tokenize='unicode61'
      );
    `);

    // Backfill — 扫所有 messages 提取 search_text
    const extractSearchText = (eventType, payloadStr) => {
      try {
        const p = JSON.parse(payloadStr);
        // user / assistant: 提 content[].text + tool_use.name+input + tool_result.content
        if (eventType === 'assistant') {
          const c = p.message?.content || [];
          return c.map((x) => {
            if (x.type === 'text') return x.text || '';
            if (x.type === 'tool_use') return `[${x.name||''}] ${JSON.stringify(x.input||{})}`;
            return '';
          }).join(' ');
        }
        if (eventType === 'user') {
          const c = p.message?.content || [];
          return c.map((x) => {
            if (x.type === 'text') return x.text || '';
            if (x.type === 'tool_result') {
              return typeof x.content === 'string' ? x.content : JSON.stringify(x.content||'');
            }
            return '';
          }).join(' ');
        }
        if (eventType === 'system/init') {
          return `session ${p.session_id||''} model ${p.model||''}`;
        }
        if (typeof eventType === 'string' && eventType.startsWith('result')) {
          return p.result || p.error || '';
        }
        return '';
      } catch { return ''; }
    };

    const all = db.prepare(`SELECT id, event_type, payload_json FROM messages`).all();
    const insertFts = db.prepare(`INSERT INTO messages_fts(rowid, content) VALUES (?, ?)`);
    let n = 0, skipped = 0;
    const tx = db.transaction(() => {
      for (const row of all) {
        const text = extractSearchText(row.event_type, row.payload_json);
        if (!text || !text.trim()) { skipped++; continue; }
        try { insertFts.run(row.id, text.trim()); n++; } catch (e) { skipped++; }
      }
    });
    tx();
    console.log(`[db v8] FTS5 backfill: ${n} indexed, ${skipped} skipped (empty text)`);
  } catch (e) {
    console.warn(`[db v8] FTS5 setup failed: ${e.message}`);
  }
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).run('schema_version', '8');
  curVersion = 8;
  console.log('[db v8] messages_fts table + backfill done');
}

// [需求@2026-06-16 fix] v8 -> v9:重建 messages_fts
//   v8 第一次用了 external content 模式 (content='messages') 但 messages 没 content 列,
//   导致 snippet() 查询报 "no such column: T.content"。改成 contentless FTS5。
//   tokenize='trigram':3-char sliding window,**中英文都能搜**(unicode61 中文要整段精确匹配)
//   代价:index 体积约 3-5x,但 15MB 数据级别可接受
if (curVersion < 9) {
  try {
    db.exec(`DROP TABLE IF EXISTS messages_fts`);
    db.exec(`
      CREATE VIRTUAL TABLE messages_fts USING fts5(
        content,
        tokenize='trigram'
      );
    `);
    const extractSearchTextLocal = (eventType, payloadStr) => {
      try {
        const p = JSON.parse(payloadStr);
        if (eventType === 'assistant') {
          const c = p.message?.content || [];
          return c.map((x) => {
            if (x.type === 'text') return x.text || '';
            if (x.type === 'tool_use') return `[${x.name||''}] ${JSON.stringify(x.input||{})}`;
            return '';
          }).join(' ');
        }
        if (eventType === 'user') {
          const c = p.message?.content || [];
          return c.map((x) => {
            if (x.type === 'text') return x.text || '';
            if (x.type === 'tool_result') {
              return typeof x.content === 'string' ? x.content : JSON.stringify(x.content||'');
            }
            return '';
          }).join(' ');
        }
        if (eventType === 'system/init') return `session ${p.session_id||''} model ${p.model||''}`;
        if (typeof eventType === 'string' && eventType.startsWith('result')) return p.result || p.error || '';
        return '';
      } catch { return ''; }
    };
    const all = db.prepare(`SELECT id, event_type, payload_json FROM messages`).all();
    const insertFts = db.prepare(`INSERT INTO messages_fts(rowid, content) VALUES (?, ?)`);
    let n = 0, skipped = 0;
    const tx = db.transaction(() => {
      for (const row of all) {
        const text = extractSearchTextLocal(row.event_type, row.payload_json);
        if (!text || !text.trim()) { skipped++; continue; }
        try { insertFts.run(row.id, text.trim()); n++; } catch { skipped++; }
      }
    });
    tx();
    console.log(`[db v9] FTS5 rebuilt: ${n} indexed, ${skipped} skipped`);
  } catch (e) {
    console.warn(`[db v9] FTS5 rebuild failed: ${e.message}`);
  }
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).run('schema_version', '9');
  curVersion = 9;
}

// [需求@2026-06-16] v9 -> v10:tokenizer unicode61 → trigram(中英文都能搜)
if (curVersion < 10) {
  try {
    db.exec(`DROP TABLE IF EXISTS messages_fts`);
    db.exec(`
      CREATE VIRTUAL TABLE messages_fts USING fts5(
        content,
        tokenize='trigram'
      );
    `);
    const extractSearchTextLocal = (eventType, payloadStr) => {
      try {
        const p = JSON.parse(payloadStr);
        if (eventType === 'assistant') {
          const c = p.message?.content || [];
          return c.map((x) => {
            if (x.type === 'text') return x.text || '';
            if (x.type === 'tool_use') return `[${x.name||''}] ${JSON.stringify(x.input||{})}`;
            return '';
          }).join(' ');
        }
        if (eventType === 'user') {
          const c = p.message?.content || [];
          return c.map((x) => {
            if (x.type === 'text') return x.text || '';
            if (x.type === 'tool_result') {
              return typeof x.content === 'string' ? x.content : JSON.stringify(x.content||'');
            }
            return '';
          }).join(' ');
        }
        if (eventType === 'system/init') return `session ${p.session_id||''} model ${p.model||''}`;
        if (typeof eventType === 'string' && eventType.startsWith('result')) return p.result || p.error || '';
        return '';
      } catch { return ''; }
    };
    const all = db.prepare(`SELECT id, event_type, payload_json FROM messages`).all();
    const insertFts = db.prepare(`INSERT INTO messages_fts(rowid, content) VALUES (?, ?)`);
    let n = 0, skipped = 0;
    const tx = db.transaction(() => {
      for (const row of all) {
        const text = extractSearchTextLocal(row.event_type, row.payload_json);
        if (!text || !text.trim()) { skipped++; continue; }
        try { insertFts.run(row.id, text.trim()); n++; } catch { skipped++; }
      }
    });
    tx();
    console.log(`[db v10] FTS5 rebuilt with trigram tokenizer: ${n} indexed, ${skipped} skipped`);
  } catch (e) {
    console.warn(`[db v10] FTS5 trigram rebuild failed: ${e.message}`);
  }
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).run('schema_version', '10');
  curVersion = 10;
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

  // [需求@2026-06-12 Phase 2E §1.5 + 2026-06-15 v7] mate_pending_sends 操作
  psEnqueue: db.prepare(`
    INSERT INTO mate_pending_sends (
      kind, target_kind, target_id, project_id, payload_json, enqueued_at, reason,
      status, dispatch_chain, thread_slug, from_instance_id
    )
    VALUES (
      @kind, @target_kind, @target_id, @project_id, @payload_json, @enqueued_at, @reason,
      @status, @dispatch_chain, @thread_slug, @from_instance_id
    )
  `),
  psListByTarget: db.prepare(`
    SELECT * FROM mate_pending_sends
    WHERE target_kind = ? AND target_id = ?
    ORDER BY enqueued_at ASC
  `),
  psListAll: db.prepare(`SELECT * FROM mate_pending_sends ORDER BY enqueued_at ASC`),
  psListByProject: db.prepare(`SELECT * FROM mate_pending_sends WHERE project_id = ? ORDER BY enqueued_at ASC`),
  psListByStatus: db.prepare(`SELECT * FROM mate_pending_sends WHERE status = ? ORDER BY enqueued_at ASC`),
  psListByThread: db.prepare(`SELECT * FROM mate_pending_sends WHERE thread_slug = ? ORDER BY enqueued_at ASC`),
  psGetById: db.prepare(`SELECT * FROM mate_pending_sends WHERE id = ?`),
  psDelete: db.prepare(`DELETE FROM mate_pending_sends WHERE id = ?`),
  psCount: db.prepare(`SELECT COUNT(*) AS n FROM mate_pending_sends`),
  psCountByProject: db.prepare(`SELECT COUNT(*) AS n FROM mate_pending_sends WHERE project_id = ?`),
  psCountByReason: db.prepare(`SELECT reason, COUNT(*) AS n FROM mate_pending_sends GROUP BY reason`),
  // 状态机迁移
  psSetStatus: db.prepare(`UPDATE mate_pending_sends SET status = ?, processed_at = ? WHERE id = ?`),
  psSetBacklog: db.prepare(`UPDATE mate_pending_sends SET status = 'backlog', backlog_at = ? WHERE id = ?`),
  psSetCancelled: db.prepare(`UPDATE mate_pending_sends SET status = 'cancelled', cancelled_at = ?, cancel_reason = ? WHERE id = ?`),
  // 找最早的可派发(queued)
  psFindOldestQueuedFor: db.prepare(`
    SELECT * FROM mate_pending_sends
    WHERE target_kind = ? AND target_id = ? AND status = 'queued'
    ORDER BY enqueued_at ASC LIMIT 1
  `),

  // [需求@2026-06-12 Phase 2E §1.5 §6] mate_quota_state 操作
  qsUpsert: db.prepare(`
    INSERT INTO mate_quota_state (rate_limit_type, status, utilization, resets_at, updated_at, manual_override)
    VALUES (@rate_limit_type, @status, @utilization, @resets_at, @updated_at, @manual_override)
    ON CONFLICT(rate_limit_type) DO UPDATE SET
      status          = excluded.status,
      utilization     = excluded.utilization,
      resets_at       = excluded.resets_at,
      updated_at      = excluded.updated_at,
      manual_override = excluded.manual_override
  `),
  qsList: db.prepare(`SELECT * FROM mate_quota_state`),
  qsGet:  db.prepare(`SELECT * FROM mate_quota_state WHERE rate_limit_type = ?`),
  qsDelete: db.prepare(`DELETE FROM mate_quota_state WHERE rate_limit_type = ?`),
  qsClearAll: db.prepare(`DELETE FROM mate_quota_state`),

  // [需求@2026-06-16 B2] FTS5 — recordMessage 同步索引,/api/search 用
  insertFts: db.prepare(`INSERT INTO messages_fts(rowid, content) VALUES (?, ?)`),
};

// [需求@2026-06-16 B2] FTS5 — 从 payload 提取可搜索文本
//   - assistant:concat all text + tool_use name/input
//   - user:concat text + tool_result content
//   - system/init:session + model
//   - result/*:.result or .error
function extractSearchText(eventType, payloadStr) {
  try {
    const p = typeof payloadStr === 'string' ? JSON.parse(payloadStr) : payloadStr;
    if (eventType === 'assistant') {
      const c = p.message?.content || [];
      return c.map((x) => {
        if (x.type === 'text') return x.text || '';
        if (x.type === 'tool_use') return `[${x.name || ''}] ${JSON.stringify(x.input || {})}`;
        return '';
      }).join(' ');
    }
    if (eventType === 'user') {
      const c = p.message?.content || [];
      return c.map((x) => {
        if (x.type === 'text') return x.text || '';
        if (x.type === 'tool_result') {
          return typeof x.content === 'string' ? x.content : JSON.stringify(x.content || '');
        }
        return '';
      }).join(' ');
    }
    if (eventType === 'system/init') {
      return `session ${p.session_id || ''} model ${p.model || ''}`;
    }
    if (typeof eventType === 'string' && eventType.startsWith('result')) {
      return p.result || p.error || '';
    }
    return '';
  } catch { return ''; }
}

module.exports = {
  db,
  stmts,
  // convenience wrappers — project_id is REQUIRED in Phase 2A onward
  // [需求@2026-06-10] 所有持久化必须带 project_id
  recordMessage(msg) {
    // [需求@2026-06-12 Phase 2E §12] 返回 SQLite autoincrement id,用于乐观 UI dedup
    const payloadStr = typeof msg.payload === 'string' ? msg.payload : JSON.stringify(msg.payload ?? {});
    const r = stmts.insertMessage.run({
      project_id: msg.projectId,
      thread_slug: msg.threadSlug || null,
      instance_id: msg.instanceId || null,
      role_name: msg.roleName || null,
      direction: msg.direction,
      claude_session_id: msg.claudeSessionId || null,
      ts: msg.ts ?? Date.now(),
      event_type: msg.eventType || null,
      payload_json: payloadStr,
      // [需求@2026-06-12 §9] mateTerm 直连消息标记;为 null 时表示普通 thread 消息
      direct_target: msg.directTarget || null,
    });
    // [需求@2026-06-16 B2] 同步插入 FTS5 索引(失败不影响主写入)
    try {
      const text = extractSearchText(msg.eventType, payloadStr);
      if (text && text.trim()) {
        stmts.insertFts.run(r.lastInsertRowid, text.trim());
      }
    } catch (e) {
      // FTS 失败不阻塞主写入
      if (!recordMessage._ftsWarned) {
        console.warn(`[db] FTS5 insert failed (will only warn once): ${e.message}`);
        recordMessage._ftsWarned = true;
      }
    }
    return r.lastInsertRowid;
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
