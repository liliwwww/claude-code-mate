// ============================================================================
// MODULE CONTRACT(架构 SSOT:docs/architecture.md §3 §4 §6)
// ----------------------------------------------------------------------------
// 层:L2 Process Control
// 责任:派工进度状态机 — 跟踪 marker dispatch 后等待 target 变 busy 的过程,
//   触发 thread.handoff.spawning / .ready / .failed 三个事件。
// 公共 API:
//   register(instanceId, basePayload, alreadySpawning) — 派工完成后入队
//   observeStatusChange(instanceId, chgTo)             — 由 SpawnManager 在
//     status_change 监听里调,内部判断 spawning/ready/failed
//   clear(instanceId)                                  — 提前清(killed 等)
// 允许依赖:messageBus
// 禁止:
//   - 自己监听 instance event(由 SpawnManager 注入 status_change 调用)
//   - 持有 instance 引用(只存 basePayload + 状态标志)
// ============================================================================
//
// [arch §1.3 ✅ 2026-06-13] 从 SpawnManager 抽出。

const bus = require('../messageBus');

// instanceId → { handoffKey, basePayload, emittedSpawning }
const pending = new Map();

/**
 * 派工完成后入队等 ready。如果 target inst 已经 busy,不入队(调用方
 * 直接 publish handoff.ready)。
 *
 * @param {string}  instanceId
 * @param {Object}  basePayload     thread.handoff payload 副本(含 handoffKey)
 * @param {boolean} alreadySpawning 如果 inst.status === 'spawning' 时为 true,
 *                                  则不会再次 emit spawning(避免重复)
 */
function register(instanceId, basePayload, alreadySpawning = false) {
  pending.set(instanceId, {
    handoffKey: basePayload.handoffKey,
    basePayload,
    emittedSpawning: alreadySpawning,
  });
}

/**
 * status_change 钩子。SpawnManager 在 _wireListeners 里调。
 *
 * @param {string} instanceId
 * @param {string} chgTo  新 status
 */
function observeStatusChange(instanceId, chgTo) {
  const entry = pending.get(instanceId);
  if (!entry) return;

  // 第一次进 spawning → emit spawning(若派工时还没 emit 过)
  if (chgTo === 'spawning' && !entry.emittedSpawning) {
    entry.emittedSpawning = true;
    bus.publish('thread.handoff.spawning', { ...entry.basePayload });
    return;
  }
  // 进 busy → target 真正开始处理 stdin → ready,清掉
  if (chgTo === 'busy') {
    bus.publish('thread.handoff.ready', { ...entry.basePayload });
    pending.delete(instanceId);
    return;
  }
  // 进 dead → 派工失败
  if (chgTo === 'dead') {
    bus.publish('thread.handoff.failed', { ...entry.basePayload, error: 'target died before processing' });
    pending.delete(instanceId);
    return;
  }
}

function clear(instanceId) {
  pending.delete(instanceId);
}

// 单测用
function _size() { return pending.size; }
function _get(instanceId) { return pending.get(instanceId); }
function _reset() { pending.clear(); }

module.exports = { register, observeStatusChange, clear, _size, _get, _reset };
