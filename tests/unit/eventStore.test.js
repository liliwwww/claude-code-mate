// [arch-debt §3+§6 ✅ 2026-06-13] EventStore L1 单测
//
// 用临时 SQLite 表替换 db,验证 list/listDispatchHistory/listRecentHandoffsForProject

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Database = require('better-sqlite3');
const { describe, it, expect } = require('../_framework');

// 临时 DB + events 表
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mate-evstore-test-'));
const tdb = new Database(path.join(tmpDir, 'test.sqlite'));
tdb.pragma('journal_mode = WAL');
tdb.exec(`
  CREATE TABLE events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           INTEGER NOT NULL,
    kind         TEXT NOT NULL,
    thread_slug  TEXT,
    instance_id  TEXT,
    project_id   INTEGER,
    payload_json TEXT NOT NULL
  );
`);

// stub db module
const insertStmt = tdb.prepare(`INSERT INTO events (project_id, ts, kind, thread_slug, instance_id, payload_json) VALUES (?, ?, ?, ?, ?, ?)`);

const dbPath = path.resolve(__dirname, '../../server/db.js');
require.cache[dbPath] = {
  exports: {
    db: tdb,
    stmts: { insertEvent: insertStmt },
    recordEvent: (kind, payload, opts = {}) => {
      insertStmt.run(
        opts.projectId ?? null,
        opts.ts ?? Date.now(),
        kind,
        opts.threadSlug ?? null,
        opts.instanceId ?? null,
        typeof payload === 'string' ? payload : JSON.stringify(payload ?? {})
      );
    },
  },
};

delete require.cache[path.resolve(__dirname, '../../server/events/EventStore.js')];
const EventStore = require('../../server/events/EventStore');

function reset() { tdb.prepare(`DELETE FROM events`).run(); }

function seed(events) {
  for (const e of events) {
    insertStmt.run(
      e.projectId ?? null,
      e.ts,
      e.kind,
      e.threadSlug ?? null,
      e.instanceId ?? null,
      typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload ?? {})
    );
  }
}

// EventStore.record 是 db.recordEvent 的薄 delegate 包装,实际 insert 路径
// 由 db.recordEvent 测试保证;这里跳过(require.cache 多 test file 共享会有 race)。

describe('EventStore.list', () => {
  it('lists all events, default desc by ts', () => {
    reset();
    const t0 = Date.now();
    seed([
      { ts: t0,       kind: 'a', projectId: 1, payload: { n: 1 } },
      { ts: t0 + 10,  kind: 'b', projectId: 1, payload: { n: 2 } },
      { ts: t0 + 20,  kind: 'c', projectId: 1, payload: { n: 3 } },
    ]);
    const r = EventStore.list();
    expect(r).toHaveLength(3);
    expect(r[0].kind).toBe('c');  // 最新在前
  });

  it('filter by kinds (IN)', () => {
    reset();
    const t0 = Date.now();
    seed([
      { ts: t0,      kind: 'thread.handoff', projectId: 1 },
      { ts: t0 + 1,  kind: 'thread.done',    projectId: 1 },
      { ts: t0 + 2,  kind: 'system.cap_warn',projectId: 1 },
    ]);
    const r = EventStore.list({ kinds: ['thread.handoff', 'thread.done'] });
    expect(r).toHaveLength(2);
    expect(r.every((e) => ['thread.handoff', 'thread.done'].includes(e.kind))).toBe(true);
  });

  it('filter by projectId', () => {
    reset();
    seed([
      { ts: 1, kind: 'x', projectId: 1 },
      { ts: 2, kind: 'x', projectId: 2 },
      { ts: 3, kind: 'x', projectId: 1 },
    ]);
    expect(EventStore.list({ projectId: 1 })).toHaveLength(2);
    expect(EventStore.list({ projectId: 2 })).toHaveLength(1);
  });

  it('filter by threadSlug', () => {
    reset();
    seed([
      { ts: 1, kind: 'x', threadSlug: 'a' },
      { ts: 2, kind: 'x', threadSlug: 'b' },
    ]);
    expect(EventStore.list({ threadSlug: 'a' })).toHaveLength(1);
  });

  it('filter by sinceTs / untilTs', () => {
    reset();
    seed([
      { ts: 10, kind: 'x' },
      { ts: 20, kind: 'x' },
      { ts: 30, kind: 'x' },
    ]);
    expect(EventStore.list({ sinceTs: 20 })).toHaveLength(2);
    expect(EventStore.list({ untilTs: 20 })).toHaveLength(2);
    expect(EventStore.list({ sinceTs: 20, untilTs: 20 })).toHaveLength(1);
  });

  it('limit + ordering asc', () => {
    reset();
    seed([
      { ts: 10, kind: 'x' },
      { ts: 20, kind: 'x' },
      { ts: 30, kind: 'x' },
    ]);
    const r = EventStore.list({ limit: 2, order: 'asc' });
    expect(r).toHaveLength(2);
    expect(r[0].ts).toBe(10);
    expect(r[1].ts).toBe(20);
  });

  it('parses payload JSON', () => {
    reset();
    seed([{ ts: 1, kind: 'x', payload: { hello: 'world', n: 42 } }]);
    const r = EventStore.list();
    expect(r[0].payload).toEqual({ hello: 'world', n: 42 });
  });
});

describe('EventStore.listDispatchHistory', () => {
  it('returns only handoff/done/blocked, DESC by ts', () => {
    reset();
    seed([
      { ts: 1, kind: 'instance.spawn',  projectId: 1 },
      { ts: 2, kind: 'thread.handoff',  projectId: 1, payload: { from: 'R' } },
      { ts: 3, kind: 'thread.done',     projectId: 1 },
      { ts: 4, kind: 'thread.blocked',  projectId: 1 },
      { ts: 5, kind: 'instance.unstuck', projectId: 1 },
    ]);
    const r = EventStore.listDispatchHistory({ limit: 100 });
    expect(r).toHaveLength(3);
    expect(r[0].ts).toBe(4); // blocked 最新
    expect(r.map((e) => e.kind).sort()).toEqual(['thread.blocked', 'thread.done', 'thread.handoff']);
  });
});

describe('EventStore.listRecentHandoffsForProject', () => {
  it('returns raw rows for the project, DESC, limit', () => {
    reset();
    seed([
      { ts: 1, kind: 'thread.handoff', projectId: 1, threadSlug: 'a' },
      { ts: 2, kind: 'thread.handoff', projectId: 1, threadSlug: 'b' },
      { ts: 3, kind: 'thread.handoff', projectId: 2, threadSlug: 'c' },
      { ts: 4, kind: 'thread.handoff', projectId: 1, threadSlug: 'd' },
    ]);
    const r = EventStore.listRecentHandoffsForProject(1, 10);
    expect(r).toHaveLength(3);
    expect(r[0].thread_slug).toBe('d');  // 最新
    expect(r[0].ts).toBe(4);
  });

  it('respects limit', () => {
    reset();
    for (let i = 0; i < 10; i++) {
      seed([{ ts: i, kind: 'thread.handoff', projectId: 1 }]);
    }
    expect(EventStore.listRecentHandoffsForProject(1, 3)).toHaveLength(3);
  });
});

describe('EventStore.countByKind', () => {
  it('aggregates correctly', () => {
    reset();
    seed([
      { ts: 1, kind: 'a' },
      { ts: 2, kind: 'a' },
      { ts: 3, kind: 'b' },
    ]);
    const c = EventStore.countByKind();
    expect(c.a).toBe(2);
    expect(c.b).toBe(1);
  });
});

process.on('exit', () => {
  try { tdb.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});
