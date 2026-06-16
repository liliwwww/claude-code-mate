// [需求@2026-06-16] 单测:ThreadCallStack — 栈数据结构 + Frame + Result + 派生 stage
//   纯函数,零 IO(load/save 用真 DB,放集成测)。

const { describe, it, expect } = require('../_framework');
const TCS = require('../../server/threads/ThreadCallStack');

describe('ThreadCallStack — Frame factory', () => {
  it('creates frame with required role', () => {
    const f = TCS.createFrame({ role: 'R' });
    expect(f.role).toBe('R');
    expect(f.slot).toBe(null);
    expect(f.status).toBe(TCS.FrameStatus.AWAITING_RESOURCE);
    expect(typeof f.pushedAt).toBe('number');
    expect(f.retryCount).toBe(0);
  });

  it('rejects invalid role', () => {
    let threw = false;
    try { TCS.createFrame({ role: 'X' }); } catch { threw = true; }
    expect(threw).toBe(true);
  });

  it('rejects invalid slot', () => {
    let threw = false;
    try { TCS.createFrame({ role: 'B', slot: 5 }); } catch { threw = true; }
    expect(threw).toBe(true);
    threw = false;
    try { TCS.createFrame({ role: 'B', slot: 0 }); } catch { threw = true; }
    expect(threw).toBe(true);
  });

  it('accepts valid slot 1-4', () => {
    for (const slot of [1, 2, 3, 4]) {
      const f = TCS.createFrame({ role: 'B', slot });
      expect(f.slot).toBe(slot);
    }
  });

  it('copies all optional fields', () => {
    const f = TCS.createFrame({
      role: 'H',
      slot: 1,
      instanceId: 'H-1',
      sessionId: 'sess-1',
      boundThread: 't-X',
      status: TCS.FrameStatus.RUNNING,
      retryCount: 2,
      pendingQuestion: 'wat',
    });
    expect(f.role).toBe('H');
    expect(f.slot).toBe(1);
    expect(f.instanceId).toBe('H-1');
    expect(f.sessionId).toBe('sess-1');
    expect(f.boundThread).toBe('t-X');
    expect(f.status).toBe('running');
    expect(f.retryCount).toBe(2);
    expect(f.pendingQuestion).toBe('wat');
  });
});

describe('ThreadCallStack — Stack basic ops', () => {
  it('empty stack', () => {
    const s = TCS.createStack();
    expect(TCS.isEmpty(s)).toBe(true);
    expect(TCS.depth(s)).toBe(0);
    expect(TCS.peek(s)).toBe(null);
    expect(TCS.peekBelow(s)).toBe(null);
  });

  it('push then peek', () => {
    const s = TCS.createStack();
    const f = TCS.createFrame({ role: 'R', instanceId: 'R-1' });
    TCS.push(s, f);
    expect(TCS.isEmpty(s)).toBe(false);
    expect(TCS.depth(s)).toBe(1);
    expect(TCS.peek(s).role).toBe('R');
    expect(TCS.peekBelow(s)).toBe(null);
  });

  it('push multiple — top + below', () => {
    const s = TCS.createStack();
    TCS.push(s, TCS.createFrame({ role: 'R' }));
    TCS.push(s, TCS.createFrame({ role: 'H', slot: 1 }));
    TCS.push(s, TCS.createFrame({ role: 'B', slot: 2 }));
    expect(TCS.depth(s)).toBe(3);
    expect(TCS.peek(s).role).toBe('B');
    expect(TCS.peekBelow(s).role).toBe('H');
  });

  it('pop reduces depth + returns top', () => {
    const s = TCS.createStack();
    TCS.push(s, TCS.createFrame({ role: 'R' }));
    TCS.push(s, TCS.createFrame({ role: 'H', slot: 1 }));
    const popped = TCS.pop(s);
    expect(popped.role).toBe('H');
    expect(TCS.depth(s)).toBe(1);
    expect(TCS.peek(s).role).toBe('R');
  });

  it('pop empty returns null', () => {
    const s = TCS.createStack();
    expect(TCS.pop(s)).toBe(null);
  });
});

describe('ThreadCallStack — Result factories', () => {
  it('done result', () => {
    const r = TCS.makeDoneResult('all done');
    expect(r.kind).toBe('done');
    expect(r.summary).toBe('all done');
  });

  it('bounce result', () => {
    const r = TCS.makeBounceResult('need user');
    expect(r.kind).toBe('bounce');
    expect(r.reason).toBe('need user');
  });

  it('reject result with default subkind', () => {
    const r = TCS.makeRejectResult('bad task');
    expect(r.kind).toBe('reject');
    expect(r.reason).toBe('bad task');
    expect(r.subkind).toBe('task_invalid');
    expect(r.retriesAttempted).toBe(0);
  });

  it('reject result with subkind + retries', () => {
    const r = TCS.makeRejectResult('OOM', TCS.RejectSubkind.CRASH, 2);
    expect(r.subkind).toBe('crash');
    expect(r.retriesAttempted).toBe(2);
  });

  it('reject result rejects invalid subkind', () => {
    let threw = false;
    try { TCS.makeRejectResult('x', 'wat'); } catch { threw = true; }
    expect(threw).toBe(true);
  });
});

describe('ThreadCallStack — deriveStage', () => {
  it('outcome=verified overrides stack', () => {
    const s = TCS.createStack();
    TCS.push(s, TCS.createFrame({ role: 'B', slot: 1 }));
    expect(TCS.deriveStage(s, 'verified')).toBe('verified');
  });

  it('outcome=aborted overrides stack', () => {
    const s = TCS.createStack();
    expect(TCS.deriveStage(s, 'aborted')).toBe('aborted');
  });

  it('empty stack -> discussing', () => {
    expect(TCS.deriveStage(TCS.createStack())).toBe('discussing');
  });

  it('top R -> discussing', () => {
    const s = TCS.createStack();
    TCS.push(s, TCS.createFrame({ role: 'R' }));
    expect(TCS.deriveStage(s)).toBe('discussing');
  });

  it('top H -> designing', () => {
    const s = TCS.createStack();
    TCS.push(s, TCS.createFrame({ role: 'R' }));
    TCS.push(s, TCS.createFrame({ role: 'H', slot: 1 }));
    expect(TCS.deriveStage(s)).toBe('designing');
  });

  it('top B -> executing', () => {
    const s = TCS.createStack();
    TCS.push(s, TCS.createFrame({ role: 'B', slot: 2 }));
    expect(TCS.deriveStage(s)).toBe('executing');
  });

  it('top C -> testing', () => {
    const s = TCS.createStack();
    TCS.push(s, TCS.createFrame({ role: 'C', slot: 1 }));
    expect(TCS.deriveStage(s)).toBe('testing');
  });
});

describe('ThreadCallStack — transitionStatus', () => {
  it('transitions valid statuses', () => {
    const f = TCS.createFrame({ role: 'H', slot: 1 });
    TCS.transitionStatus(f, TCS.FrameStatus.RUNNING);
    expect(f.status).toBe('running');
    TCS.transitionStatus(f, TCS.FrameStatus.BLOCKED);
    expect(f.status).toBe('blocked');
  });

  it('rejects invalid status string', () => {
    const f = TCS.createFrame({ role: 'H', slot: 1 });
    let threw = false;
    try { TCS.transitionStatus(f, 'wat'); } catch { threw = true; }
    expect(threw).toBe(true);
  });

  it('updates lastActivityAt', () => {
    const f = TCS.createFrame({ role: 'H', slot: 1 });
    const before = f.lastActivityAt;
    // 强制延时(避免同 ms 相等):busy loop 几 ms
    const t0 = Date.now();
    while (Date.now() - t0 < 5) { /* spin */ }
    TCS.transitionStatus(f, TCS.FrameStatus.RUNNING);
    expect(f.lastActivityAt > before).toBe(true);
  });
});

describe('ThreadCallStack — typical lifecycle', () => {
  it('R → H → B → pop B → pop H → empty', () => {
    const s = TCS.createStack();
    // R push
    TCS.push(s, TCS.createFrame({ role: 'R', instanceId: 'R-1', sessionId: 'r1', status: TCS.FrameStatus.AWAITING_CALLEE }));
    // H push
    TCS.push(s, TCS.createFrame({ role: 'H', slot: 1, instanceId: 'H-1', sessionId: 'h1', status: TCS.FrameStatus.AWAITING_CALLEE }));
    // B push
    TCS.push(s, TCS.createFrame({ role: 'B', slot: 2, instanceId: 'B-2', sessionId: 'b2', status: TCS.FrameStatus.RUNNING }));
    expect(TCS.depth(s)).toBe(3);
    expect(TCS.deriveStage(s)).toBe('executing');

    // B done → pop
    const popB = TCS.pop(s);
    expect(popB.role).toBe('B');
    expect(TCS.deriveStage(s)).toBe('designing');

    // H done → pop
    const popH = TCS.pop(s);
    expect(popH.role).toBe('H');
    expect(TCS.deriveStage(s)).toBe('discussing');

    // R done → pop → empty
    const popR = TCS.pop(s);
    expect(popR.role).toBe('R');
    expect(TCS.isEmpty(s)).toBe(true);
    expect(TCS.deriveStage(s, 'verified')).toBe('verified');
  });
});
