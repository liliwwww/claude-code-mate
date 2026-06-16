// [需求@2026-06-15 Phase 2G M1.1] QueueDispatcher 状态机单测
//
// 测三个核心:
//   1. enqueueBusy → handleUserChoice('wait') → 入 queue,WS topic 触发
//   2. handleUserChoice('backlog') → 落 backlog,dispatchBacklog 转回 queued + flush
//   3. handleUserChoice('cancel') → cancelled,行被 remove
//
// 用临时 sqlite 表替代真 db,绕过 SpawnManager / RoleInstance 实体依赖

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Database = require('better-sqlite3');
const { describe, it, expect } = require('../_framework');

// 临时 DB(含 v7 字段)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mate-qd-test-'));
const tdb = new Database(path.join(tmpDir, 'test.sqlite'));
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
    reason          TEXT,
    status          TEXT NOT NULL DEFAULT 'queued',
    dispatch_chain  TEXT,
    thread_slug     TEXT,
    from_instance_id TEXT,
    backlog_at      INTEGER,
    processed_at    INTEGER,
    cancelled_at    INTEGER,
    cancel_reason   TEXT
  );
`);

// 完整 stmts(对齐 v7)
const fakeStmts = {
  psEnqueue: tdb.prepare(`
    INSERT INTO mate_pending_sends (
      kind, target_kind, target_id, project_id, payload_json, enqueued_at, reason,
      status, dispatch_chain, thread_slug, from_instance_id
    )
    VALUES (
      @kind, @target_kind, @target_id, @project_id, @payload_json, @enqueued_at, @reason,
      @status, @dispatch_chain, @thread_slug, @from_instance_id
    )
  `),
  psListByTarget: tdb.prepare(`SELECT * FROM mate_pending_sends WHERE target_kind = ? AND target_id = ? ORDER BY enqueued_at ASC`),
  psListAll: tdb.prepare(`SELECT * FROM mate_pending_sends ORDER BY enqueued_at ASC`),
  psListByProject: tdb.prepare(`SELECT * FROM mate_pending_sends WHERE project_id = ? ORDER BY enqueued_at ASC`),
  psListByStatus: tdb.prepare(`SELECT * FROM mate_pending_sends WHERE status = ? ORDER BY enqueued_at ASC`),
  psListByThread: tdb.prepare(`SELECT * FROM mate_pending_sends WHERE thread_slug = ? ORDER BY enqueued_at ASC`),
  psGetById: tdb.prepare(`SELECT * FROM mate_pending_sends WHERE id = ?`),
  psDelete: tdb.prepare(`DELETE FROM mate_pending_sends WHERE id = ?`),
  psCount: tdb.prepare(`SELECT COUNT(*) AS n FROM mate_pending_sends`),
  psCountByProject: tdb.prepare(`SELECT COUNT(*) AS n FROM mate_pending_sends WHERE project_id = ?`),
  psCountByReason: tdb.prepare(`SELECT reason, COUNT(*) AS n FROM mate_pending_sends GROUP BY reason`),
  psSetStatus: tdb.prepare(`UPDATE mate_pending_sends SET status = ?, processed_at = ? WHERE id = ?`),
  psSetBacklog: tdb.prepare(`UPDATE mate_pending_sends SET status = 'backlog', backlog_at = ? WHERE id = ?`),
  psSetCancelled: tdb.prepare(`UPDATE mate_pending_sends SET status = 'cancelled', cancelled_at = ?, cancel_reason = ? WHERE id = ?`),
  psFindOldestQueuedFor: tdb.prepare(`
    SELECT * FROM mate_pending_sends
    WHERE target_kind = ? AND target_id = ? AND status = 'queued'
    ORDER BY enqueued_at ASC LIMIT 1
  `),
};

// stub messageBus 收集 publish 调用
const publishedEvents = [];
const fakeBus = {
  publish: (topic, payload) => publishedEvents.push({ topic, payload }),
  subscribe: () => {},
};

const dbPath = path.resolve(__dirname, '../../server/db.js');
const busPath = path.resolve(__dirname, '../../server/messageBus.js');
require.cache[dbPath] = { exports: { stmts: fakeStmts, db: tdb, recordEvent: () => {} } };
require.cache[busPath] = { exports: fakeBus };

const QD = require('../../server/spawn/QueueDispatcher');
const PendingSends = require('../../server/spawn/PendingSends');

function reset() {
  tdb.prepare(`DELETE FROM mate_pending_sends`).run();
  publishedEvents.length = 0;
}

// 假实例(只用 .id / .displayName / .role.name)
const fakeR = { id: 'mate-R.aaa', displayName: 'mate-R.aaa', role: { name: 'mate-R' }, projectId: 1 };
const fakeH = { id: 'mate-H-1', displayName: 'mate-H-1', role: { name: 'mate-H' } };

describe('QueueDispatcher.enqueueBusy + handleUserChoice', () => {
  it('enqueueBusy creates row with status=waiting_user and emits busy_prompt', () => {
    reset();
    const id = QD.enqueueBusy({
      fromInst: fakeR, targetInst: fakeH,
      targetSpec: 'mate-H', reason: 'design needed',
      handoffText: 'task body',
      threadSlug: 't-001', projectId: 1, dispatchChain: [{role:'mate-R'}],
    });
    expect(typeof id).toBe('number');
    const row = PendingSends.getById(id);
    expect(row.status).toBe('waiting_user');
    expect(row.targetId).toBe('mate-H-1');
    expect(row.threadSlug).toBe('t-001');
    expect(row.fromInstanceId).toBe('mate-R.aaa');
    expect(row.dispatchChain).toHaveLength(1);
    expect(publishedEvents).toHaveLength(1);
    expect(publishedEvents[0].topic).toBe('dispatch.busy_prompt');
    expect(publishedEvents[0].payload.pendingSendId).toBe(id);
  });

  it("choice='wait' → status=queued + queue.added emit", async () => {
    reset();
    const id = QD.enqueueBusy({
      fromInst: fakeR, targetInst: fakeH,
      targetSpec: 'mate-H', reason: 'x', handoffText: 't',
      threadSlug: 't-002', projectId: 1,
    });
    let dispatched = false;
    const result = await QD.handleUserChoice(id, 'wait', {
      dispatchCb: async () => { dispatched = true; },
    });
    expect(result.status).toBe('queued');
    expect(result.dispatched).toBe(true);
    expect(dispatched).toBe(true);
    // [Phase 2H 改] dispatch 后 row 保留为 'processing',等 result 事件来才 remove
    //   测试这里只验证 dispatchCb 被调用 + status 翻 processing
    const row = PendingSends.getById(id);
    expect(row?.status).toBe('processing');
    const topics = publishedEvents.map(e => e.topic);
    expect(topics).toContain('dispatch.busy_prompt');
    expect(topics).toContain('queue.added');
    expect(topics).toContain('queue.claimed');
  });

  it("choice='backlog' → status=backlog + backlog.added emit", async () => {
    reset();
    const id = QD.enqueueBusy({
      fromInst: fakeR, targetInst: fakeH,
      targetSpec: 'mate-H', reason: 'x', handoffText: 't',
      threadSlug: 't-003', projectId: 1,
    });
    let dispatched = false;
    const result = await QD.handleUserChoice(id, 'backlog', {
      dispatchCb: async () => { dispatched = true; },
    });
    expect(result.status).toBe('backlog');
    expect(dispatched).toBe(false);
    expect(PendingSends.getById(id)?.status).toBe('backlog');
    const topics = publishedEvents.map(e => e.topic);
    expect(topics).toContain('backlog.added');
  });

  it("choice='cancel' → cancelled + row removed", async () => {
    reset();
    const id = QD.enqueueBusy({
      fromInst: fakeR, targetInst: fakeH,
      targetSpec: 'mate-H', reason: 'x', handoffText: 't',
      threadSlug: 't-004', projectId: 1,
    });
    const result = await QD.handleUserChoice(id, 'cancel', { dispatchCb: async () => {} });
    expect(result.status).toBe('cancelled');
    expect(PendingSends.getById(id)).toBe(null);
    const topics = publishedEvents.map(e => e.topic);
    expect(topics).toContain('queue.cancelled');
  });

  it('handleUserChoice throws for unknown choice', async () => {
    reset();
    const id = QD.enqueueBusy({
      fromInst: fakeR, targetInst: fakeH,
      targetSpec: 'mate-H', reason: 'x', handoffText: 't',
      threadSlug: 't-x', projectId: 1,
    });
    let threw = false;
    try { await QD.handleUserChoice(id, 'maybe', { dispatchCb: async () => {} }); }
    catch { threw = true; }
    expect(threw).toBe(true);
  });

  it('handleUserChoice throws if row is not waiting_user', async () => {
    reset();
    const id = QD.enqueueBusy({
      fromInst: fakeR, targetInst: fakeH,
      targetSpec: 'mate-H', reason: 'x', handoffText: 't',
      threadSlug: 't-y', projectId: 1,
    });
    PendingSends.markBacklog(id);  // 改成 backlog
    let threw = false;
    try { await QD.handleUserChoice(id, 'wait', { dispatchCb: async () => {} }); }
    catch { threw = true; }
    expect(threw).toBe(true);
  });
});

describe('QueueDispatcher.dispatchBacklog', () => {
  it('moves backlog → queued + flushes', async () => {
    reset();
    const id = QD.enqueueBusy({
      fromInst: fakeR, targetInst: fakeH,
      targetSpec: 'mate-H', reason: 'x', handoffText: 't',
      threadSlug: 't-b1', projectId: 1,
    });
    await QD.handleUserChoice(id, 'backlog', { dispatchCb: async () => {} });
    let dispatched = false;
    const flushed = await QD.dispatchBacklog(id, {
      dispatchCb: async () => { dispatched = true; },
    });
    expect(dispatched).toBe(true);
    expect(flushed?.id).toBe(id);
    // [Phase 2H 改] row 派发后留 status='processing',等 dispatch.completed 才 remove
    expect(PendingSends.getById(id)?.status).toBe('processing');
    const topics = publishedEvents.map(e => e.topic);
    expect(topics).toContain('backlog.added');
    expect(topics).toContain('backlog.dispatched');
    expect(topics).toContain('queue.claimed');
  });
});

describe('QueueDispatcher.cancelQueued', () => {
  it('cancels backlog item', () => {
    reset();
    const id = PendingSends.enqueue({
      kind: 'handoff_marker', targetKind: 'instance', targetId: 'X',
      projectId: 1, payload: { text: 'x' }, reason: 'busy',
      status: 'backlog', threadSlug: 't-c1',
    });
    QD.cancelQueued(id, 'user-rejected');
    expect(PendingSends.getById(id)).toBe(null);
    expect(publishedEvents.some(e => e.topic === 'backlog.cancelled')).toBe(true);
  });

  it('cancels queued item', () => {
    reset();
    const id = PendingSends.enqueue({
      kind: 'handoff_marker', targetKind: 'instance', targetId: 'X',
      projectId: 1, payload: { text: 'x' }, reason: 'busy',
      status: 'queued', threadSlug: 't-c2',
    });
    QD.cancelQueued(id);
    expect(PendingSends.getById(id)).toBe(null);
    expect(publishedEvents.some(e => e.topic === 'queue.cancelled')).toBe(true);
  });

  it('refuses to cancel processing', () => {
    reset();
    const id = PendingSends.enqueue({
      kind: 'handoff_marker', targetKind: 'instance', targetId: 'X',
      projectId: 1, payload: { text: 'x' }, reason: 'busy',
      status: 'processing', threadSlug: 't-c3',
    });
    let threw = false;
    try { QD.cancelQueued(id); } catch { threw = true; }
    expect(threw).toBe(true);
  });
});

describe('QueueDispatcher.onInstanceIdle', () => {
  it('flushes oldest queued targeting that instance', async () => {
    reset();
    const id1 = PendingSends.enqueue({
      kind: 'handoff_marker', targetKind: 'instance', targetId: 'mate-H-1',
      projectId: 1, payload: { text: 'first' }, reason: 'busy',
      status: 'queued', threadSlug: 't-1',
    });
    const id2 = PendingSends.enqueue({
      kind: 'handoff_marker', targetKind: 'instance', targetId: 'mate-H-1',
      projectId: 1, payload: { text: 'second' }, reason: 'busy',
      status: 'queued', threadSlug: 't-2',
    });
    let dispatchedText = null;
    const flushed = await QD.onInstanceIdle({ id: 'mate-H-1' }, {
      dispatchCb: async (row) => { dispatchedText = row.payload.text; },
    });
    expect(flushed?.id).toBe(id1);  // 最早入队的先
    expect(dispatchedText).toBe('first');
    // [Phase 2H 改] row 派发后留 'processing',第二个还在 queued
    expect(PendingSends.getById(id1)?.status).toBe('processing');
    expect(PendingSends.getById(id2)?.status).toBe('queued');
  });

  it('returns null when no queued items match', async () => {
    reset();
    const flushed = await QD.onInstanceIdle({ id: 'mate-H-2' }, { dispatchCb: async () => {} });
    expect(flushed).toBe(null);
  });
});
