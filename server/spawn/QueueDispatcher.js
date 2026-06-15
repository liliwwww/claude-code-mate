// ============================================================================
// MODULE CONTRACT(架构 SSOT:docs/discussions/2026-06-15-queue-arch.md)
// ----------------------------------------------------------------------------
// 层:L3 Business Logic(Phase 2G)
// 责任:派工排队的状态机 — busy 时不直发 stdin,落 PendingSends,user
//   通过 dispatch.busy_prompt 选 wait / backlog / cancel。idle 时自动 flush。
// 公共 API:
//   enqueueBusy({fromInst, targetInst, targetSpec, reason, handoffText,
//                threadSlug, dispatchChain, projectId})
//     → busy_prompt:emit WS dispatch.busy_prompt,等 user 决定;返回 pendingSendId
//   handleUserChoice(id, choice, { dispatchCb })
//     → 'wait' → status='queued',尝试立即 flush(以防 target 此刻已 idle)
//       'backlog' → status='backlog',停留等 user 手动 dispatch
//       'cancel' → status='cancelled' + 删行
//   onInstanceIdle(inst, { dispatchCb })
//     → inst 翻 idle 时调,flush 第一条 queued 任务
//   cancelQueued(id, reason?)
//     → 取消 queued / backlog / waiting_user(processing 不能 cancel,用 ■停止)
//   dispatchBacklog(id, { dispatchCb })
//     → backlog → queued + flush
// 允许依赖:./PendingSends / messageBus
// 禁止:
//   - 直接写 child stdin(那是 RoleInstance.sendUserText 的活;通过 dispatchCb 注入)
//   - 替 marker 决策(只搬运 marker 数据)
// ============================================================================

const bus = require('../messageBus');
const PendingSends = require('./PendingSends');

/**
 * marker handoff 目标 busy 时调用 — 落 DB + 推 busy_prompt。
 *
 * @param {RoleInstance} fromInst              派工源(R 或 H 等)
 * @param {RoleInstance} targetInst            派工目标(当前 busy 的实例)
 * @param {string} targetSpec                  marker target 原文,如 "mate-B" 或 "mate-B-2"
 * @param {string} reason                      marker reason 文本
 * @param {string} handoffText                 准备写给 target 的完整 user message
 * @param {string} threadSlug
 * @param {Array}  dispatchChain               当前线索的 dispatch_chain 快照(可空)
 * @param {number} projectId
 * @returns {number} pendingSendId
 */
function enqueueBusy({ fromInst, targetInst, targetSpec, reason, handoffText, threadSlug, dispatchChain, projectId }) {
  const id = PendingSends.enqueue({
    kind: 'handoff_marker',
    targetKind: 'instance',
    targetId: targetInst.id,
    projectId,
    payload: {
      text: handoffText,
      marker: { kind: 'handoff', target: targetSpec, reason },
      fromInstanceId: fromInst.id,
      fromDisplayName: fromInst.displayName,
      fromRoleName: fromInst.role?.name,
      toRoleName: targetInst.role?.name,
      toDisplayName: targetInst.displayName,
    },
    reason: 'busy',
    status: 'waiting_user',
    dispatchChain,
    threadSlug,
    fromInstanceId: fromInst.id,
  });

  bus.publish('dispatch.busy_prompt', {
    pendingSendId: id,
    fromInstanceId: fromInst.id,
    fromDisplayName: fromInst.displayName,
    fromRoleName: fromInst.role?.name,
    toInstanceId: targetInst.id,
    toDisplayName: targetInst.displayName,
    toRoleName: targetInst.role?.name,
    targetSpec,
    reason,
    threadSlug,
    projectId,
  });
  return id;
}

/**
 * user 在 busy_prompt 选了 wait / backlog / cancel
 *
 * @param {number} id
 * @param {'wait' | 'backlog' | 'cancel'} choice
 * @param {Object} opts
 * @param {Function} opts.dispatchCb  (pendingRow) => Promise — 真正发送 stdin 的回调;
 *                                    由 SpawnManager 注入
 * @returns {Promise<{ status: string, dispatched?: boolean, pendingSendId: number }>}
 */
async function handleUserChoice(id, choice, { dispatchCb }) {
  const row = PendingSends.getById(id);
  if (!row) throw new Error(`pending send ${id} not found`);
  if (row.status !== 'waiting_user') {
    throw new Error(`pending send ${id} is not waiting_user (status=${row.status})`);
  }

  if (choice === 'wait') {
    PendingSends.markQueued(id);
    bus.publish('queue.added', {
      pendingSendId: id,
      threadSlug: row.threadSlug,
      toInstanceId: row.targetId,
      fromInstanceId: row.fromInstanceId,
      projectId: row.projectId,
    });
    // user 决策瞬间 target 可能已 idle,试一下立即 flush
    const flushed = await _tryFlushFor(row.targetKind, row.targetId, { dispatchCb });
    return { status: 'queued', dispatched: !!flushed, pendingSendId: id };
  }

  if (choice === 'backlog') {
    PendingSends.markBacklog(id);
    bus.publish('backlog.added', {
      pendingSendId: id,
      threadSlug: row.threadSlug,
      toInstanceId: row.targetId,
      fromInstanceId: row.fromInstanceId,
      projectId: row.projectId,
    });
    return { status: 'backlog', pendingSendId: id };
  }

  if (choice === 'cancel') {
    PendingSends.markCancelled(id, 'user-rejected-at-busy-prompt');
    bus.publish('queue.cancelled', {
      pendingSendId: id,
      threadSlug: row.threadSlug,
      projectId: row.projectId,
    });
    PendingSends.remove(id);
    return { status: 'cancelled', pendingSendId: id };
  }

  throw new Error(`unknown choice "${choice}" (expected wait | backlog | cancel)`);
}

/**
 * 实例翻 idle 时调 — flush 队列里指向该实例的第一条任务
 * 由 SpawnManager._wireListeners 在 status_change to='idle' 时调
 */
async function onInstanceIdle(inst, { dispatchCb }) {
  return _tryFlushFor('instance', inst.id, { dispatchCb });
}

/**
 * 内部:找匹配的最早 queued 项目 → markProcessing → dispatchCb → 完成后删行
 */
async function _tryFlushFor(targetKind, targetId, { dispatchCb }) {
  const next = PendingSends.findOldestQueuedFor(targetKind, targetId);
  if (!next) return null;

  PendingSends.markProcessing(next.id);
  bus.publish('queue.claimed', {
    pendingSendId: next.id,
    threadSlug: next.threadSlug,
    toInstanceId: next.targetId,
    fromInstanceId: next.fromInstanceId,
    projectId: next.projectId,
  });

  try {
    await dispatchCb(next);
  } catch (e) {
    console.error(`[QueueDispatcher] flush failed for ${next.id}:`, e.message);
    PendingSends.markCancelled(next.id, `flush-error: ${e.message}`);
    bus.publish('queue.cancelled', {
      pendingSendId: next.id,
      threadSlug: next.threadSlug,
      error: e.message,
      projectId: next.projectId,
    });
    PendingSends.remove(next.id);
    return null;
  }

  // 成功派发,行不再需要
  PendingSends.remove(next.id);
  return next;
}

/**
 * 取消 queued / backlog / waiting_user 项。
 * 'processing' 不能 cancel(应走 §18 ■停止)。
 */
function cancelQueued(id, reason = 'user-cancel') {
  const row = PendingSends.getById(id);
  if (!row) throw new Error(`pending send ${id} not found`);
  if (!['queued', 'backlog', 'waiting_user'].includes(row.status)) {
    throw new Error(`cannot cancel pending send in status "${row.status}"(use stop endpoint for processing)`);
  }
  PendingSends.markCancelled(id, reason);
  const topic = row.status === 'backlog' ? 'backlog.cancelled' : 'queue.cancelled';
  bus.publish(topic, {
    pendingSendId: id,
    threadSlug: row.threadSlug,
    projectId: row.projectId,
  });
  PendingSends.remove(id);
  return true;
}

/**
 * backlog → queued + 尝试立即 flush
 */
async function dispatchBacklog(id, { dispatchCb }) {
  const row = PendingSends.getById(id);
  if (!row) throw new Error(`pending send ${id} not found`);
  if (row.status !== 'backlog') {
    throw new Error(`pending send ${id} is not in backlog (status=${row.status})`);
  }
  PendingSends.markQueued(id);
  bus.publish('backlog.dispatched', {
    pendingSendId: id,
    threadSlug: row.threadSlug,
    toInstanceId: row.targetId,
    projectId: row.projectId,
  });
  return _tryFlushFor(row.targetKind, row.targetId, { dispatchCb });
}

module.exports = {
  enqueueBusy,
  handleUserChoice,
  onInstanceIdle,
  cancelQueued,
  dispatchBacklog,
};
