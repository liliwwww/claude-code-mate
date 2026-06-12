// [需求@2026-06-12 Phase 2E §1.5 §3 §6] PendingSends helper 单测
//
// 由于 PendingSends 仅是 SQLite 表的薄包装,这里做一个临时表的纯 wrapper 测试
// 验证 enqueue / list / remove / count 流程

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Database = require('better-sqlite3');
const { describe, it, expect } = require('../_framework');

// 临时 DB
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mate-ps-test-'));
const tmpDbPath = path.join(tmpDir, 'test.sqlite');
const tdb = new Database(tmpDbPath);
tdb.pragma('journal_mode = WAL');
tdb.exec(`
  CREATE TABLE mate_pending_sends (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    kind            TEXT NOT NULL,
    target_kind     TEXT NOT NULL,
    target_id       TEXT NOT NULL,
    project_id      INTEGER,
    payload_json    TEXT NOT NULL,
    enqueued_at     INTEGER NOT NULL,
    reason          TEXT
  );
`);

// Stub db module with table-equivalent prepared statements
const fakeStmts = {
  psEnqueue: tdb.prepare(`
    INSERT INTO mate_pending_sends (kind, target_kind, target_id, project_id, payload_json, enqueued_at, reason)
    VALUES (@kind, @target_kind, @target_id, @project_id, @payload_json, @enqueued_at, @reason)
  `),
  psListByTarget: tdb.prepare(`SELECT * FROM mate_pending_sends WHERE target_kind = ? AND target_id = ? ORDER BY enqueued_at ASC`),
  psListAll: tdb.prepare(`SELECT * FROM mate_pending_sends ORDER BY enqueued_at ASC`),
  psListByProject: tdb.prepare(`SELECT * FROM mate_pending_sends WHERE project_id = ? ORDER BY enqueued_at ASC`),
  psDelete: tdb.prepare(`DELETE FROM mate_pending_sends WHERE id = ?`),
  psCount: tdb.prepare(`SELECT COUNT(*) AS n FROM mate_pending_sends`),
  psCountByProject: tdb.prepare(`SELECT COUNT(*) AS n FROM mate_pending_sends WHERE project_id = ?`),
  psCountByReason: tdb.prepare(`SELECT reason, COUNT(*) AS n FROM mate_pending_sends GROUP BY reason`),
};

const dbPath = path.resolve(__dirname, '../../server/db.js');
require.cache[dbPath] = { exports: { stmts: fakeStmts, db: tdb, recordEvent: () => {} } };

const ps = require('../../server/spawn/PendingSends');

function reset() {
  tdb.prepare(`DELETE FROM mate_pending_sends`).run();
}

describe('PendingSends.enqueue/list/count', () => {
  it('enqueue inserts and returns id', () => {
    reset();
    const id = ps.enqueue({ kind: 'direct_send', targetKind: 'instance', targetId: 'planA-H.abc', projectId: 1, payload: { text: 'hi' }, reason: 'busy' });
    expect(typeof id).toBe('number');
    expect(id > 0).toBe(true);
    expect(ps.count()).toBe(1);
  });

  it('throws if required fields missing', () => {
    reset();
    let threw = false;
    try { ps.enqueue({ kind: 'direct_send', targetKind: 'instance' }); } catch { threw = true; }
    expect(threw).toBe(true);
  });

  it('listForTarget filters by (target_kind, target_id)', () => {
    reset();
    ps.enqueue({ kind: 'direct_send', targetKind: 'instance', targetId: 'A', payload: { text: '1' }, reason: 'busy' });
    ps.enqueue({ kind: 'direct_send', targetKind: 'instance', targetId: 'A', payload: { text: '2' }, reason: 'busy' });
    ps.enqueue({ kind: 'direct_send', targetKind: 'instance', targetId: 'B', payload: { text: '3' }, reason: 'busy' });
    expect(ps.listForTarget('instance', 'A')).toHaveLength(2);
    expect(ps.listForTarget('instance', 'B')).toHaveLength(1);
    expect(ps.listForTarget('thread', 'A')).toHaveLength(0);
  });

  it('listForTarget orders by enqueued_at ASC', () => {
    reset();
    ps.enqueue({ kind: 'thread_send', targetKind: 'thread', targetId: 'x', payload: { n: 1 }, reason: 'quota_pause' });
    ps.enqueue({ kind: 'thread_send', targetKind: 'thread', targetId: 'x', payload: { n: 2 }, reason: 'quota_pause' });
    const rows = ps.listForTarget('thread', 'x');
    expect(rows[0].payload.n).toBe(1);
    expect(rows[1].payload.n).toBe(2);
  });

  it('remove decreases count', () => {
    reset();
    const id = ps.enqueue({ kind: 'direct_send', targetKind: 'instance', targetId: 'A', payload: { text: 'x' }, reason: 'busy' });
    expect(ps.count()).toBe(1);
    ps.remove(id);
    expect(ps.count()).toBe(0);
  });

  it('countByReason aggregates by reason field', () => {
    reset();
    ps.enqueue({ kind: 'direct_send', targetKind: 'instance', targetId: 'A', payload: {}, reason: 'busy' });
    ps.enqueue({ kind: 'thread_send', targetKind: 'thread', targetId: 'B', payload: {}, reason: 'quota_pause' });
    ps.enqueue({ kind: 'thread_send', targetKind: 'thread', targetId: 'C', payload: {}, reason: 'quota_pause' });
    const by = ps.countByReason();
    expect(by.busy).toBe(1);
    expect(by.quota_pause).toBe(2);
  });

  it('payload roundtrip preserves structure', () => {
    reset();
    const original = { text: 'hello\nworld', nested: { a: 1, b: [2, 3] } };
    ps.enqueue({ kind: 'direct_send', targetKind: 'instance', targetId: 'A', payload: original, reason: 'busy' });
    const rows = ps.listForTarget('instance', 'A');
    expect(rows[0].payload).toEqual(original);
  });

  it('listByProject filters', () => {
    reset();
    ps.enqueue({ kind: 'thread_send', targetKind: 'thread', targetId: 'a', projectId: 1, payload: {}, reason: 'quota_pause' });
    ps.enqueue({ kind: 'thread_send', targetKind: 'thread', targetId: 'b', projectId: 2, payload: {}, reason: 'quota_pause' });
    expect(ps.listByProject(1)).toHaveLength(1);
    expect(ps.countByProject(1)).toBe(1);
    expect(ps.countByProject(99)).toBe(0);
  });
});

process.on('exit', () => {
  try { tdb.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});
