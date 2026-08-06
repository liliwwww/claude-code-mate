// ============================================================================
// MODULE CONTRACT(RFC: docs/discussions/2026-06-16-stack-model-rfc.md)
// ----------------------------------------------------------------------------
// 层:L2 Process Control
// 责任:per-project + per-role + per-slot 的资源池 + FIFO 排队
//   - SlotState: 谁占着该 slot / 等待队列
//   - acquire/release: thread 申请/释放 slot
//   - position: 查队位
//   - rebuild: mate 启动时,从所有 thread 栈重建 FIFO 队列
// 公共 API:
//   - getPool(projectId) → ProjectSlotPool
//   - rebuildFromStacks(stacks) → void(启动时扫所有 thread 栈调用)
//   - SlotState 操作:acquire / release / peek / queuePosition / list
//
// 允许依赖:./db 或纯内存(本模块默认纯内存,持久化由 ThreadCallStack 担)
// 禁止:
//   - 替 thread 决定要不要拿 slot(那是 MarkerDispatcher 调用 acquire 的事)
//   - 唤起 claude 进程(那是 SpawnManager 的事)
//   - 跟 LLM 通信
//
// [需求@2026-06-16] Phase 1 冷代码:模块完备但不接业务。
//
// 池子拓扑:
//   每个 project 有:
//     1 个 H slot (H 是 project singleton, slot 永远 = 1)
//     4 个 B slot
//     4 个 C slot
//   R 不在池里 — per-thread 独占,无 slot 概念。
// ============================================================================

const log = require('../logger');
const MOD = 'SlotPool';

// FIFO queue 工具(简单数组实现 — 队列规模 ≤ 几十 条,无性能问题)
function newQueue() { return []; }
function qEnqueue(q, item) { q.push(item); }
function qDequeue(q) { return q.shift() || null; }
function qPeek(q) { return q[0] || null; }
function qLength(q) { return q.length; }
function qPositionOf(q, predicate) {
  for (let i = 0; i < q.length; i++) {
    if (predicate(q[i])) return i + 1; // 1-based(给 UI 显示用)
  }
  return -1;
}
function qRemove(q, predicate) {
  const idx = q.findIndex(predicate);
  if (idx >= 0) return q.splice(idx, 1)[0];
  return null;
}

// ============================================================================
// SlotState — 单个 slot 的状态
// ============================================================================

/**
 * 一个 slot 的状态:
 *  - currentOwnerThread: 当前哪个 thread 的 frame 占着 slot(null = idle)
 *  - instanceId: 该 slot 此刻物理实例(也可能 null 表示尚未 lazy spawn)
 *  - queue: 等该 slot 的 thread 列表(FIFO)
 *
 * "占用"语义:某 thread 的栈上有针对该 slot 的 frame(任何 status:running/
 *  awaiting_callee/blocked/etc),只要 frame 没 pop,slot 不释放。
 */
function createSlotState() {
  return {
    currentOwnerThread: null,
    instanceId: null,
    queue: newQueue(),
  };
}

function isIdle(slot) {
  return slot.currentOwnerThread === null;
}

/**
 * 尝试 acquire。如果 idle → 立刻获得,返回 'granted';
 * 如果被占 → 排队,返回 'queued' + position。
 *
 * 返回 { result: 'granted' | 'queued', position: number | null }
 */
function acquire(slot, threadId) {
  if (!threadId) throw new Error('acquire: threadId required');
  if (isIdle(slot)) {
    slot.currentOwnerThread = threadId;
    return { result: 'granted', position: 0 };
  }
  if (slot.currentOwnerThread === threadId) {
    // 已经占着,re-acquire is no-op
    return { result: 'granted', position: 0 };
  }
  // 已被别 thread 占,入队
  // 但要去重:同 thread 不重复入队
  if (qPositionOf(slot.queue, (t) => t === threadId) > 0) {
    return { result: 'queued', position: qPositionOf(slot.queue, (t) => t === threadId) };
  }
  qEnqueue(slot.queue, threadId);
  return { result: 'queued', position: qLength(slot.queue) };
}

/**
 * 释放 slot。如果有排队 thread,自动把队首转成新 owner。
 * 返回:{ released: thread | null, newOwner: thread | null }
 */
function release(slot, releasingThread) {
  if (slot.currentOwnerThread !== releasingThread) {
    // 不是 owner 想释放?(可能 cancel queued 走另一路径,见 cancel)
    return { released: null, newOwner: slot.currentOwnerThread };
  }
  const released = slot.currentOwnerThread;
  slot.currentOwnerThread = null;
  // 队首上场
  const next = qDequeue(slot.queue);
  if (next) {
    slot.currentOwnerThread = next;
    return { released, newOwner: next };
  }
  return { released, newOwner: null };
}

/**
 * 队中的 thread 主动取消(user 撤销 / thread 自己 reject)。
 * 不影响当前 owner,只清队里的等待项。
 */
function cancelQueued(slot, threadId) {
  const removed = qRemove(slot.queue, (t) => t === threadId);
  return removed !== null;
}

/**
 * 查 thread 在该 slot 的位置(0 = owner, ≥1 = queue position, null = 不存在)
 */
function positionOf(slot, threadId) {
  if (slot.currentOwnerThread === threadId) return 0;
  const p = qPositionOf(slot.queue, (t) => t === threadId);
  return p > 0 ? p : null;
}

// ============================================================================
// ProjectSlotPool — 单 project 全 role 的池子
// ============================================================================

/**
 * 一个 project 的所有池子:
 *   H: 1 个 slot
 *   B: slots {1, 2, 3, 4}
 *   C: slots {1, 2, 3, 4}
 *
 * R 不在这,per-thread。
 */
function createProjectSlotPool() {
  return {
    H: { 1: createSlotState() },
    B: { 1: createSlotState(), 2: createSlotState(), 3: createSlotState(), 4: createSlotState() },
    C: { 1: createSlotState(), 2: createSlotState(), 3: createSlotState(), 4: createSlotState() },
  };
}

/**
 * 取一个 slot. role: 'H'|'B'|'C', slotNum: 1-4 (H 必须 1).
 * 返回 SlotState 或 抛错。
 */
function getSlot(pool, role, slotNum) {
  if (!['H', 'B', 'C'].includes(role)) {
    throw new Error(`getSlot: invalid role ${role} (must be H|B|C, R is per-thread)`);
  }
  if (typeof slotNum !== 'number' || slotNum < 1 || slotNum > 4) {
    throw new Error(`getSlot: invalid slotNum ${slotNum} (1-4)`);
  }
  if (role === 'H' && slotNum !== 1) {
    throw new Error(`getSlot: H only has slot 1, got ${slotNum}`);
  }
  const map = pool[role];
  const slot = map[slotNum];
  if (!slot) throw new Error(`getSlot: slot ${role}-${slotNum} not initialized`);
  return slot;
}

/**
 * 列出该 pool 所有 slot 状态(给 dashboard / task board snapshot 用)。
 * 返回 [{ role, slotNum, idle, currentOwnerThread, queueLength, queue }]
 */
function listAllSlots(pool) {
  const out = [];
  for (const role of ['H', 'B', 'C']) {
    const map = pool[role];
    for (const slotNum of Object.keys(map).map(Number).sort()) {
      const slot = map[slotNum];
      out.push({
        role,
        slotNum,
        idle: isIdle(slot),
        currentOwnerThread: slot.currentOwnerThread,
        queueLength: qLength(slot.queue),
        queue: [...slot.queue],
      });
    }
  }
  return out;
}

// ============================================================================
// 全局 registry — 每个 project 一个 pool
// ============================================================================

const projectPools = new Map(); // projectId → ProjectSlotPool

function getPool(projectId) {
  if (!projectPools.has(projectId)) {
    projectPools.set(projectId, createProjectSlotPool());
  }
  return projectPools.get(projectId);
}

function clearPool(projectId) {
  projectPools.delete(projectId);
}

function clearAllPools() {
  projectPools.clear();
}

// ============================================================================
// Rebuild from stacks — mate 启动时调用
//
// 输入:[{projectId, threadId, stack}, ...]
// 行为:
//   - 扫每条 thread 的栈,把 池化 role frame(H/B/C)按 status 分类:
//     - status='running' → slot.currentOwnerThread = threadId(独占)
//     - status='awaiting_resource' → 入 FIFO queue(按 pushedAt 排序保 FIFO)
//   - 同一 slot 不能同时被 ≥2 个 thread 占 running(数据矛盾,告警)
// ============================================================================

function rebuildFromStacks(stackEntries) {
  // 收集 (projectId, role, slotNum, threadId, status, pushedAt, instanceId) 元组
  const entries = [];
  for (const { projectId, threadId, stack } of stackEntries) {
    if (!stack || !Array.isArray(stack.frames)) continue;
    for (const frame of stack.frames) {
      if (frame.role === 'R') continue; // R 不在池
      if (!frame.slot) continue;
      entries.push({
        projectId,
        threadId,
        role: frame.role,
        slotNum: frame.slot,
        status: frame.status,
        pushedAt: frame.pushedAt || 0,
        instanceId: frame.instanceId,
      });
    }
  }

  // 分组:每个 (projectId, role, slotNum) 一份
  const slotEntries = new Map(); // "p|role|slot" → entries[]
  for (const e of entries) {
    const k = `${e.projectId}|${e.role}|${e.slotNum}`;
    if (!slotEntries.has(k)) slotEntries.set(k, []);
    slotEntries.get(k).push(e);
  }

  // 重建每个 slot 的状态
  for (const [k, slotEntryList] of slotEntries) {
    const [pidStr, role, slotNumStr] = k.split('|');
    const projectId = Number(pidStr);
    const slotNum = Number(slotNumStr);
    const pool = getPool(projectId);
    const slot = getSlot(pool, role, slotNum);

    // 按状态分类
    const runningOrActive = slotEntryList.filter((e) =>
      e.status === 'running' ||
      e.status === 'awaiting_callee' ||
      e.status === 'blocked' ||
      e.status === 'needs_kick'
    );
    const queued = slotEntryList.filter((e) => e.status === 'awaiting_resource');

    // 检查:同 slot 最多一个 owner
    if (runningOrActive.length > 1) {
      log.warn({ module: MOD, event: 'rebuild_inconsistency', poolKey: k, activeCount: runningOrActive.length, threadIds: runningOrActive.map((e) => e.threadId) });
      // 取第一个当 owner,其余忽略(数据已经坏,只能粗暴恢复)
    }
    if (runningOrActive.length >= 1) {
      const owner = runningOrActive[0];
      slot.currentOwnerThread = owner.threadId;
      slot.instanceId = owner.instanceId; // 可能 null(重启遗留)
    }
    // 队列按 pushedAt FIFO
    queued.sort((a, b) => a.pushedAt - b.pushedAt);
    for (const q of queued) {
      qEnqueue(slot.queue, q.threadId);
    }
  }
}

// ============================================================================
// Snapshot — dashboard / task board 用
// ============================================================================

function snapshotProject(projectId) {
  if (!projectPools.has(projectId)) return null;
  return listAllSlots(projectPools.get(projectId));
}

function snapshotAll() {
  const out = {};
  for (const [pid, pool] of projectPools) {
    out[pid] = listAllSlots(pool);
  }
  return out;
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  // 工厂
  createSlotState,
  createProjectSlotPool,

  // SlotState 操作
  acquire,
  release,
  cancelQueued,
  positionOf,
  isIdle,

  // ProjectPool 操作
  getSlot,
  listAllSlots,

  // 全局 registry
  getPool,
  clearPool,
  clearAllPools,

  // 启动/快照
  rebuildFromStacks,
  snapshotProject,
  snapshotAll,
};
