// [需求@2026-06-16] 单测:SlotPool — per-slot FIFO + acquire/release + 重建

const { describe, it, expect } = require('../_framework');
const SP = require('../../server/spawn/SlotPool');

describe('SlotPool — SlotState basic acquire/release', () => {
  it('acquire idle slot -> granted', () => {
    const slot = SP.createSlotState();
    const r = SP.acquire(slot, 't-X');
    expect(r.result).toBe('granted');
    expect(r.position).toBe(0);
    expect(SP.isIdle(slot)).toBe(false);
    expect(SP.positionOf(slot, 't-X')).toBe(0);
  });

  it('acquire busy slot -> queued', () => {
    const slot = SP.createSlotState();
    SP.acquire(slot, 't-X');
    const r = SP.acquire(slot, 't-Y');
    expect(r.result).toBe('queued');
    expect(r.position).toBe(1);
    expect(SP.positionOf(slot, 't-Y')).toBe(1);
  });

  it('multiple queued — FIFO order preserved', () => {
    const slot = SP.createSlotState();
    SP.acquire(slot, 't-X');
    SP.acquire(slot, 't-Y');
    SP.acquire(slot, 't-Z');
    expect(SP.positionOf(slot, 't-Y')).toBe(1);
    expect(SP.positionOf(slot, 't-Z')).toBe(2);
  });

  it('same thread re-acquire (own slot) -> granted no-op', () => {
    const slot = SP.createSlotState();
    SP.acquire(slot, 't-X');
    const r = SP.acquire(slot, 't-X');
    expect(r.result).toBe('granted');
    expect(SP.positionOf(slot, 't-X')).toBe(0);
  });

  it('same thread re-acquire (queued) -> still queued same position', () => {
    const slot = SP.createSlotState();
    SP.acquire(slot, 't-X');
    SP.acquire(slot, 't-Y');
    const r = SP.acquire(slot, 't-Y'); // 第二次 acquire,不该重复入队
    expect(r.result).toBe('queued');
    expect(r.position).toBe(1);
  });

  it('release with no queue', () => {
    const slot = SP.createSlotState();
    SP.acquire(slot, 't-X');
    const r = SP.release(slot, 't-X');
    expect(r.released).toBe('t-X');
    expect(r.newOwner).toBe(null);
    expect(SP.isIdle(slot)).toBe(true);
  });

  it('release with queued -> auto promote', () => {
    const slot = SP.createSlotState();
    SP.acquire(slot, 't-X');
    SP.acquire(slot, 't-Y');
    SP.acquire(slot, 't-Z');
    const r = SP.release(slot, 't-X');
    expect(r.released).toBe('t-X');
    expect(r.newOwner).toBe('t-Y');
    expect(SP.positionOf(slot, 't-Y')).toBe(0);
    expect(SP.positionOf(slot, 't-Z')).toBe(1);
  });

  it('release by non-owner is no-op', () => {
    const slot = SP.createSlotState();
    SP.acquire(slot, 't-X');
    SP.acquire(slot, 't-Y');
    const r = SP.release(slot, 't-Y'); // t-Y queued, not owner
    expect(r.released).toBe(null);
    expect(r.newOwner).toBe('t-X');
  });

  it('cancelQueued removes from queue', () => {
    const slot = SP.createSlotState();
    SP.acquire(slot, 't-X');
    SP.acquire(slot, 't-Y');
    SP.acquire(slot, 't-Z');
    const ok = SP.cancelQueued(slot, 't-Y');
    expect(ok).toBe(true);
    expect(SP.positionOf(slot, 't-Y')).toBe(null);
    expect(SP.positionOf(slot, 't-Z')).toBe(1);
  });

  it('cancelQueued non-existent returns false', () => {
    const slot = SP.createSlotState();
    expect(SP.cancelQueued(slot, 't-X')).toBe(false);
  });
});

describe('SlotPool — ProjectSlotPool structure', () => {
  it('createProjectSlotPool has H/B/C slots', () => {
    const pool = SP.createProjectSlotPool();
    expect(typeof pool.H).toBe('object');
    expect(typeof pool.B).toBe('object');
    expect(typeof pool.C).toBe('object');
    expect(Object.keys(pool.B).length).toBe(4);
    expect(Object.keys(pool.C).length).toBe(4);
    expect(Object.keys(pool.H).length).toBe(1);
  });

  it('getSlot validates inputs', () => {
    const pool = SP.createProjectSlotPool();
    let threw;
    threw = false; try { SP.getSlot(pool, 'R', 1); } catch { threw = true; }
    expect(threw).toBe(true);
    threw = false; try { SP.getSlot(pool, 'H', 2); } catch { threw = true; }
    expect(threw).toBe(true);
    threw = false; try { SP.getSlot(pool, 'B', 5); } catch { threw = true; }
    expect(threw).toBe(true);
    threw = false; try { SP.getSlot(pool, 'B', 0); } catch { threw = true; }
    expect(threw).toBe(true);
  });

  it('getSlot returns valid SlotStates', () => {
    const pool = SP.createProjectSlotPool();
    expect(SP.isIdle(SP.getSlot(pool, 'H', 1))).toBe(true);
    expect(SP.isIdle(SP.getSlot(pool, 'B', 3))).toBe(true);
    expect(SP.isIdle(SP.getSlot(pool, 'C', 4))).toBe(true);
  });

  it('listAllSlots returns 9 entries (1 H + 4 B + 4 C)', () => {
    const pool = SP.createProjectSlotPool();
    const list = SP.listAllSlots(pool);
    expect(list.length).toBe(9);
    expect(list.filter((s) => s.role === 'H').length).toBe(1);
    expect(list.filter((s) => s.role === 'B').length).toBe(4);
    expect(list.filter((s) => s.role === 'C').length).toBe(4);
  });
});

describe('SlotPool — Global registry', () => {
  it('getPool creates lazily', () => {
    SP.clearAllPools();
    const p1 = SP.getPool(1);
    const p1b = SP.getPool(1);
    expect(p1).toBe(p1b);
    const p2 = SP.getPool(2);
    expect(p1 === p2).toBe(false);
  });

  it('snapshotProject returns null for unknown', () => {
    SP.clearAllPools();
    expect(SP.snapshotProject(99)).toBe(null);
  });

  it('snapshotProject for known pool', () => {
    SP.clearAllPools();
    const pool = SP.getPool(1);
    SP.acquire(SP.getSlot(pool, 'B', 2), 't-X');
    const snap = SP.snapshotProject(1);
    expect(snap === null).toBe(false);
    const b2 = snap.find((s) => s.role === 'B' && s.slotNum === 2);
    expect(b2.idle).toBe(false);
    expect(b2.currentOwnerThread).toBe('t-X');
  });
});

describe('SlotPool — rebuildFromStacks', () => {
  it('rebuilds owner from running frame', () => {
    SP.clearAllPools();
    SP.rebuildFromStacks([
      {
        projectId: 1,
        threadId: 't-X',
        stack: {
          frames: [
            { role: 'R', slot: null, status: 'awaiting_callee', pushedAt: 100 },
            { role: 'H', slot: 1, status: 'running', pushedAt: 200, instanceId: 'H-1' },
          ],
        },
      },
    ]);
    const pool = SP.getPool(1);
    const h = SP.getSlot(pool, 'H', 1);
    expect(SP.isIdle(h)).toBe(false);
    expect(h.currentOwnerThread).toBe('t-X');
    expect(h.instanceId).toBe('H-1');
  });

  it('rebuilds FIFO queue from awaiting_resource frames (sorted by pushedAt)', () => {
    SP.clearAllPools();
    SP.rebuildFromStacks([
      {
        projectId: 1,
        threadId: 't-X',
        stack: {
          frames: [
            { role: 'R', slot: null, status: 'awaiting_callee', pushedAt: 100 },
            { role: 'H', slot: 1, status: 'running', pushedAt: 200, instanceId: 'H-1' },
          ],
        },
      },
      {
        projectId: 1,
        threadId: 't-Y',
        stack: {
          frames: [
            { role: 'R', slot: null, status: 'awaiting_callee', pushedAt: 300 },
            { role: 'H', slot: 1, status: 'awaiting_resource', pushedAt: 500 },
          ],
        },
      },
      {
        projectId: 1,
        threadId: 't-Z',
        stack: {
          frames: [
            { role: 'R', slot: null, status: 'awaiting_callee', pushedAt: 400 },
            { role: 'H', slot: 1, status: 'awaiting_resource', pushedAt: 600 },
          ],
        },
      },
    ]);
    const pool = SP.getPool(1);
    const h = SP.getSlot(pool, 'H', 1);
    expect(h.currentOwnerThread).toBe('t-X');
    expect(SP.positionOf(h, 't-Y')).toBe(1); // earlier pushedAt = head
    expect(SP.positionOf(h, 't-Z')).toBe(2);
  });

  it('R frames are ignored (R not in pool)', () => {
    SP.clearAllPools();
    SP.rebuildFromStacks([
      {
        projectId: 1,
        threadId: 't-X',
        stack: {
          frames: [
            { role: 'R', slot: null, status: 'running', pushedAt: 100, instanceId: 'R-X' },
          ],
        },
      },
    ]);
    const pool = SP.getPool(1);
    expect(SP.isIdle(SP.getSlot(pool, 'H', 1))).toBe(true);
    expect(SP.isIdle(SP.getSlot(pool, 'B', 1))).toBe(true);
  });

  it('blocked / awaiting_callee / needs_kick frames also own slot', () => {
    SP.clearAllPools();
    SP.rebuildFromStacks([
      {
        projectId: 1,
        threadId: 't-A',
        stack: { frames: [{ role: 'B', slot: 1, status: 'blocked', pushedAt: 100 }] },
      },
      {
        projectId: 1,
        threadId: 't-B',
        stack: { frames: [{ role: 'B', slot: 2, status: 'awaiting_callee', pushedAt: 100 }] },
      },
      {
        projectId: 1,
        threadId: 't-C',
        stack: { frames: [{ role: 'B', slot: 3, status: 'needs_kick', pushedAt: 100 }] },
      },
    ]);
    const pool = SP.getPool(1);
    expect(SP.getSlot(pool, 'B', 1).currentOwnerThread).toBe('t-A');
    expect(SP.getSlot(pool, 'B', 2).currentOwnerThread).toBe('t-B');
    expect(SP.getSlot(pool, 'B', 3).currentOwnerThread).toBe('t-C');
  });

  it('clearAllPools resets', () => {
    SP.clearAllPools();
    SP.getPool(1);
    SP.getPool(2);
    SP.clearAllPools();
    expect(SP.snapshotProject(1)).toBe(null);
    expect(SP.snapshotProject(2)).toBe(null);
  });
});
