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

// ============================================================================
// [需求@2026-08-07 X5] 并发/多线索场景 — 两线索并行不走串,FIFO 严格保序
// ============================================================================
describe('X5 · 两线索不同 target 并发不交叉', () => {
  it('threadA→H1 + threadB→H2 各自 flush 到正确 target', async () => {
    reset();
    const idA = PendingSends.enqueue({
      kind: 'handoff_marker', targetKind: 'instance', targetId: 'mate-H1',
      projectId: 1, payload: { text: 'from-A' }, reason: 'busy',
      status: 'queued', threadSlug: 't-A', fromInstanceId: 'mate-R.a',
    });
    const idB = PendingSends.enqueue({
      kind: 'handoff_marker', targetKind: 'instance', targetId: 'mate-H2',
      projectId: 1, payload: { text: 'from-B' }, reason: 'busy',
      status: 'queued', threadSlug: 't-B', fromInstanceId: 'mate-R.b',
    });
    const results = [];
    const cb = async (row) => { results.push({ id: row.id, threadSlug: row.threadSlug, targetId: row.targetId, text: row.payload.text }); };
    await Promise.all([
      QD.onInstanceIdle({ id: 'mate-H1' }, { dispatchCb: cb }),
      QD.onInstanceIdle({ id: 'mate-H2' }, { dispatchCb: cb }),
    ]);
    expect(results).toHaveLength(2);
    const forH1 = results.find((r) => r.targetId === 'mate-H1');
    const forH2 = results.find((r) => r.targetId === 'mate-H2');
    expect(forH1?.threadSlug).toBe('t-A');
    expect(forH1?.text).toBe('from-A');
    expect(forH1?.id).toBe(idA);
    expect(forH2?.threadSlug).toBe('t-B');
    expect(forH2?.text).toBe('from-B');
    expect(forH2?.id).toBe(idB);
  });

  it('4 线索 × 4 target 完全独立 — 全并发 flush 不错位', async () => {
    reset();
    const enqueued = [];
    for (let i = 1; i <= 4; i++) {
      const id = PendingSends.enqueue({
        kind: 'handoff_marker', targetKind: 'instance', targetId: `mate-H${i}`,
        projectId: 1, payload: { text: `text-${i}` }, reason: 'busy',
        status: 'queued', threadSlug: `t-${i}`,
      });
      enqueued.push({ id, thread: `t-${i}`, target: `mate-H${i}` });
    }
    const results = [];
    const cb = async (row) => { results.push(row); };
    await Promise.all(enqueued.map((e) =>
      QD.onInstanceIdle({ id: e.target }, { dispatchCb: cb })
    ));
    expect(results).toHaveLength(4);
    for (const r of results) {
      const mapping = enqueued.find((e) => e.target === r.targetId);
      expect(r.threadSlug).toBe(mapping.thread);
    }
  });
});

describe('X5 · 同 target 两线索 FIFO 严格保序', () => {
  it('并发 3 次 idle 触发 — dispatchCb 首个跑的一定是 enqueue 最早的', async () => {
    reset();
    const id1 = PendingSends.enqueue({
      kind: 'handoff_marker', targetKind: 'instance', targetId: 'mate-H1',
      projectId: 1, payload: { text: 'first-from-A' }, reason: 'busy',
      status: 'queued', threadSlug: 't-A',
    });
    const id2 = PendingSends.enqueue({
      kind: 'handoff_marker', targetKind: 'instance', targetId: 'mate-H1',
      projectId: 1, payload: { text: 'second-from-B' }, reason: 'busy',
      status: 'queued', threadSlug: 't-B',
    });
    const dispatched = [];
    const cb = async (row) => { dispatched.push(row.id); };
    const flushes = await Promise.all([
      QD.onInstanceIdle({ id: 'mate-H1' }, { dispatchCb: cb }),
      QD.onInstanceIdle({ id: 'mate-H1' }, { dispatchCb: cb }),
      QD.onInstanceIdle({ id: 'mate-H1' }, { dispatchCb: cb }),
    ]);
    const flushedIds = flushes.filter(Boolean).map((r) => r.id);
    expect(flushedIds).toContain(id1);
    if (flushedIds.length === 2) {
      expect(flushedIds[0]).toBe(id1);
      expect(flushedIds[1]).toBe(id2);
    }
    expect(dispatched[0]).toBe(id1);
  });
});

describe('X5 · forceDispatch(UI1)跳队隔离', () => {
  it('4 条 queued,forceDispatch 第 3 条 — 只 flush 那一条,其他保持 queued', async () => {
    reset();
    const ids = [];
    for (let i = 0; i < 4; i++) {
      ids.push(PendingSends.enqueue({
        kind: 'handoff_marker', targetKind: 'instance', targetId: 'mate-H1',
        projectId: 1, payload: { text: 'x' + i }, reason: 'busy',
        status: 'queued', threadSlug: `t-${i}`,
      }));
    }
    let flushed = null;
    await QD.forceDispatch(ids[2], {
      dispatchCb: async (row) => { flushed = row; },
    });
    expect(flushed?.id).toBe(ids[2]);
    expect(flushed?.payload?.text).toBe('x2');
    expect(PendingSends.getById(ids[0])?.status).toBe('queued');
    expect(PendingSends.getById(ids[1])?.status).toBe('queued');
    expect(PendingSends.getById(ids[2])?.status).toBe('processing');
    expect(PendingSends.getById(ids[3])?.status).toBe('queued');
    const claimed = publishedEvents.find((e) => e.topic === 'queue.claimed' && e.payload.pendingSendId === ids[2]);
    expect(claimed?.payload?.forced).toBe(true);
  });

  it('forceDispatch 非 queued 状态应拒绝', async () => {
    reset();
    const id = PendingSends.enqueue({
      kind: 'handoff_marker', targetKind: 'instance', targetId: 'mate-H1',
      projectId: 1, payload: { text: 'x' }, reason: 'busy',
      status: 'queued', threadSlug: 't-x',
    });
    PendingSends.markBacklog(id);
    let threw = false;
    try {
      await QD.forceDispatch(id, { dispatchCb: async () => {} });
    } catch (e) {
      threw = true;
      expect(e.message).toContain('not in queued');
    }
    expect(threw).toBe(true);
  });
});

describe('X5 · 并发 flush 同 target 不重派', () => {
  it('1 条 queued 到 X5-only-target,3 个 concurrent flusher 抢 — dispatchCb 只跑 1 次', async () => {
    reset();
    // 用独特 target id,避免跟同文件里其它 test 的残留 target 冲突
    //   (跨文件 require.cache 覆盖导致 PendingSends 可能 bind 到别的 tdb,reset() 未必清干净)
    const TARGET = 'mate-H-x5-race-' + Date.now();
    // 保险清除:该 target 若有残留(极小概率),PendingSends.remove 一次
    for (const r of PendingSends.listByStatus('queued')) {
      if (r.targetId === TARGET) PendingSends.remove(r.id);
    }
    const id = PendingSends.enqueue({
      kind: 'handoff_marker', targetKind: 'instance', targetId: TARGET,
      projectId: 1, payload: { text: 'only-one' }, reason: 'busy',
      status: 'queued', threadSlug: 't-x5-race',
    });
    let dispatchCalls = 0;
    const cb = async () => { dispatchCalls++; };
    await Promise.all([
      QD.onInstanceIdle({ id: TARGET }, { dispatchCb: cb }),
      QD.onInstanceIdle({ id: TARGET }, { dispatchCb: cb }),
      QD.onInstanceIdle({ id: TARGET }, { dispatchCb: cb }),
    ]);
    // 关键 invariant:markProcessing 是 better-sqlite3 sync,后续 flusher findOldest
    //   filter WHERE status='queued' 应该返 null,不该重派同一条
    expect(dispatchCalls).toBe(1);
    expect(PendingSends.getById(id)?.status).toBe('processing');
  });
});
