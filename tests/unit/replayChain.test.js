// [需求@2026-06-16] 单测:replayChain — 老 dispatch_chain → 栈 + outcome

const { describe, it, expect } = require('../_framework');
const { replayChain } = require('../../server/threads/replayChain');
const TCS = require('../../server/threads/ThreadCallStack');

// helper: 简化构造
function handoff(fromRole, fromInst, toRole, toInst, toDisplay) {
  return {
    kind: 'handoff',
    fromRole, fromInstanceId: fromInst,
    toRole, toInstanceId: toInst,
    toDisplayName: toDisplay,
    ts: Date.now(),
  };
}
function done(fromRole, fromInst, isTerminal) {
  return { kind: 'done', fromRole, fromInstanceId: fromInst, isTerminal, ts: Date.now() };
}
function blocked(fromRole, q, severity) {
  return { kind: 'blocked', fromRole, question: q, severity, ts: Date.now() };
}
function reject(reason, bounce_to) {
  return { kind: 'reject', reason, bounce_to, ts: Date.now() };
}

describe('replayChain — empty / invalid', () => {
  it('empty chain → empty stack, no outcome', () => {
    const r = replayChain([]);
    expect(TCS.isEmpty(r.stack)).toBe(true);
    expect(r.outcome).toBe(null);
  });

  it('non-array → returns empty + warning', () => {
    const r = replayChain(null);
    expect(TCS.isEmpty(r.stack)).toBe(true);
    expect(r.warnings.length > 0).toBe(true);
  });
});

describe('replayChain — simple push/pop', () => {
  it('R → H push: stack=[R,H]', () => {
    const r = replayChain([
      handoff('mate-R', 'R-1', 'mate-H', 'H-1', 'mate-H-1'),
    ]);
    expect(TCS.depth(r.stack)).toBe(2);
    expect(r.stack.frames[0].role).toBe('R');
    expect(r.stack.frames[1].role).toBe('H');
    expect(r.outcome).toBe(null);
  });

  it('R → H → B push: stack=[R,H,B]', () => {
    const r = replayChain([
      handoff('mate-R', 'R-1', 'mate-H', 'H-1'),
      handoff('mate-H', 'H-1', 'mate-B', 'B-2', 'mate-B-2'),
    ]);
    expect(TCS.depth(r.stack)).toBe(3);
    expect(r.stack.frames[2].role).toBe('B');
    expect(r.stack.frames[2].slot).toBe(2);
  });

  it('B → H callback: pop B', () => {
    const r = replayChain([
      handoff('mate-R', 'R-1', 'mate-H', 'H-1'),
      handoff('mate-H', 'H-1', 'mate-B', 'B-2', 'mate-B-2'),
      handoff('mate-B', 'B-2', 'mate-H', 'H-1', 'mate-H-1'),
    ]);
    expect(TCS.depth(r.stack)).toBe(2);
    expect(TCS.peek(r.stack).role).toBe('H');
  });

  it('H bounce R: pop H, replace R if instance changes', () => {
    const r = replayChain([
      handoff('mate-R', 'R-1', 'mate-H', 'H-1'),
      handoff('mate-H', 'H-1', 'mate-R', 'R-2', 'mate-R-2'),
    ]);
    expect(TCS.depth(r.stack)).toBe(1);
    expect(r.stack.frames[0].role).toBe('R');
    expect(r.stack.frames[0].instanceId).toBe('R-2'); // instance 已替换
  });
});

describe('replayChain — done semantics', () => {
  it('isTerminal=true → stack empty + outcome=verified', () => {
    const r = replayChain([
      handoff('mate-R', 'R-1', 'mate-H', 'H-1'),
      done('mate-H', 'H-1', true),
    ]);
    expect(TCS.isEmpty(r.stack)).toBe(true);
    expect(r.outcome).toBe('verified');
  });

  it('isTerminal=undefined + 只剩 R → 视为 terminal', () => {
    const r = replayChain([
      handoff('mate-R', 'R-1', 'mate-H', 'H-1'),
      done('mate-H', 'H-1'), // 无 isTerminal
    ]);
    expect(TCS.isEmpty(r.stack)).toBe(true);
    expect(r.outcome).toBe('verified');
  });

  it('isTerminal=false 但栈深 → pop 一层', () => {
    const r = replayChain([
      handoff('mate-R', 'R-1', 'mate-H', 'H-1'),
      handoff('mate-H', 'H-1', 'mate-B', 'B-2', 'mate-B-2'),
      done('mate-B', 'B-2', false),
    ]);
    expect(TCS.depth(r.stack)).toBe(2);
    expect(TCS.peek(r.stack).role).toBe('H');
    expect(r.outcome).toBe(null);
  });
});

describe('replayChain — blocked semantics', () => {
  it('blocked sets top frame status + question', () => {
    const r = replayChain([
      handoff('mate-R', 'R-1', 'mate-H', 'H-1'),
      blocked('mate-H', '需求歧义?', 'high'),
    ]);
    const top = TCS.peek(r.stack);
    expect(top.status).toBe('blocked');
    expect(top.pendingQuestion).toBe('需求歧义?');
    expect(top.pendingQuestionMeta.severity).toBe('high');
  });
});

describe('replayChain — reject semantics', () => {
  it('reject pops self', () => {
    const r = replayChain([
      handoff('mate-R', 'R-1', 'mate-H', 'H-1'),
      handoff('mate-H', 'H-1', 'mate-B', 'B-2'),
      reject('B-2 hallucinated', 'mate-R'),
    ]);
    expect(TCS.depth(r.stack)).toBe(2); // pop B, stack=[R,H]
  });

  it('reject unwinding to empty → outcome=aborted', () => {
    const r = replayChain([
      handoff('mate-R', 'R-1', 'mate-H', 'H-1'),
      reject('cannot continue'),
      reject('really'), // 第二次 reject 弹 R
    ]);
    expect(TCS.isEmpty(r.stack)).toBe(true);
    expect(r.outcome).toBe('aborted');
  });
});

describe('replayChain — self-heal on push when stack missing frames', () => {
  it('chain[7-10] 4 done bug 案例: H 多次 done 后又 H→B handoff,自愈补 H', () => {
    // 复现 t-mqfgby8l-bxlt 老 chain 模式
    const r = replayChain([
      handoff('mate-R', 'R-1', 'mate-H', 'H-1'),     // [0]
      handoff('mate-H', 'H-1', 'mate-B', 'B-1'),     // [1]
      handoff('mate-B', 'B-1', 'mate-H', 'H-1'),     // [2]
      handoff('mate-H', 'H-1', 'mate-R', 'R-2'),     // [3] bounce
      handoff('mate-R', 'R-2', 'mate-H', 'H-1'),     // [4]
      handoff('mate-H', 'H-1', 'mate-B', 'B-1'),     // [5]
      handoff('mate-B', 'B-1', 'mate-H', 'H-1'),     // [6]
      done('mate-H', 'H-1'),                         // [7] isTerminal=undefined
      done('mate-H', 'H-1', false),                  // [8] 误判
      done('mate-H', 'H-1', false),                  // [9]
      done('mate-H', 'H-1', false),                  // [10]
      handoff('mate-H', 'H-1', 'mate-B', 'B-1'),     // [11] H 又活了
      handoff('mate-B', 'B-1', 'mate-H', 'H-1'),     // [12]
    ]);
    // chain[7] H done 时 stack=[R-2, H-1]; caller=R → terminal,outcome=verified,栈清空
    // [8-10] noop(栈空时 done 直接 terminal)
    // [11] H→B handoff:新活动 → outcome reset 为 null, 栈空时补 push from=H + push to=B
    // 最终:outcome=null,栈=[H, B] 或类似
    expect(r.outcome).toBe(null); // 后续 handoff 重置了 outcome
    expect(TCS.depth(r.stack) >= 1).toBe(true);
  });

  it('handoff push 栈顶不匹配时补 push from', () => {
    // 模拟"栈被 pop 多了但又来了个 handoff"
    const r = replayChain([
      handoff('mate-R', 'R-1', 'mate-H', 'H-1'),
      // 假设这里直接 H → B 但 H 实际不在栈顶(模拟数据损坏)
      // 不,正常 push H→B from=H 跟栈顶 H 匹配,不触发自愈
      // 触发自愈的场景:done 把 H 弹掉后又来 H→B
      done('mate-H', 'H-1', false),                  // pop H, stack=[R-1]
      handoff('mate-H', 'H-1', 'mate-B', 'B-1'),     // from=H 但栈顶=R,补 push H
    ]);
    // done 触发 terminal,栈空 outcome=verified
    // 然后 handoff push 重置 outcome → null, 栈补 push H + push B
    expect(r.outcome).toBe(null);
    expect(TCS.depth(r.stack) >= 1).toBe(true);
  });
});

describe('replayChain — running frames 末尾都标 needs_kick', () => {
  it('栈顶 running frame 末尾改成 needs_kick(mate 重启后续命)', () => {
    const r = replayChain([
      handoff('mate-R', 'R-1', 'mate-H', 'H-1'),
      handoff('mate-H', 'H-1', 'mate-B', 'B-2'),
    ]);
    // 栈 [R, H, B],B 是 running
    expect(TCS.depth(r.stack)).toBe(3);
    // R 和 H 在 push 时被改 awaiting_callee
    expect(r.stack.frames[0].status).toBe('awaiting_callee');
    expect(r.stack.frames[1].status).toBe('awaiting_callee');
    // B 是栈顶,本来 running → 末尾改 needs_kick
    expect(r.stack.frames[2].status).toBe('needs_kick');
  });

  it('blocked frame 不被改', () => {
    const r = replayChain([
      handoff('mate-R', 'R-1', 'mate-H', 'H-1'),
      blocked('mate-H', '???'),
    ]);
    expect(TCS.peek(r.stack).status).toBe('blocked');
  });
});

describe('replayChain — session_id lookup', () => {
  it('lookupSessionId 被调用并填到 frame', () => {
    const lookup = (instId) => `session-${instId}`;
    const r = replayChain([
      handoff('mate-R', 'R-1', 'mate-H', 'H-1'),
    ], { lookupSessionId: lookup });
    expect(r.stack.frames[0].sessionId).toBe('session-R-1');
    expect(r.stack.frames[1].sessionId).toBe('session-H-1');
  });

  it('无 lookup → sessionId 全 null', () => {
    const r = replayChain([
      handoff('mate-R', 'R-1', 'mate-H', 'H-1'),
    ]);
    expect(r.stack.frames[0].sessionId).toBe(null);
    expect(r.stack.frames[1].sessionId).toBe(null);
  });
});

describe('replayChain — outcome reset on new activity', () => {
  it('verified outcome 被新 handoff 重置', () => {
    const r = replayChain([
      handoff('mate-R', 'R-1', 'mate-H', 'H-1'),
      done('mate-H', 'H-1', true),                 // outcome=verified
      handoff('mate-R', 'R-1', 'mate-H', 'H-1'),   // 又活了 → reset
    ]);
    expect(r.outcome).toBe(null);
    expect(TCS.depth(r.stack)).toBe(2);
    expect(r.warnings.some((w) => w.includes('重置'))).toBe(true);
  });

  it('verified 后再 done(terminal) → 仍 verified', () => {
    const r = replayChain([
      handoff('mate-R', 'R-1', 'mate-H', 'H-1'),
      done('mate-H', 'H-1', true),                  // verified
      handoff('mate-R', 'R-1', 'mate-H', 'H-1'),    // reset
      done('mate-H', 'H-1', true),                  // 再 verified
    ]);
    expect(r.outcome).toBe('verified');
  });
});

describe('replayChain — typical happy path', () => {
  it('R → H → B → done(terminal) — 1 个工作回合', () => {
    const r = replayChain([
      handoff('mate-R', 'R-1', 'mate-H', 'H-1'),
      handoff('mate-H', 'H-1', 'mate-B', 'B-2'),
      handoff('mate-B', 'B-2', 'mate-H', 'H-1'),  // callback
      done('mate-H', 'H-1', true),                // terminal
    ]);
    expect(TCS.isEmpty(r.stack)).toBe(true);
    expect(r.outcome).toBe('verified');
  });
});
