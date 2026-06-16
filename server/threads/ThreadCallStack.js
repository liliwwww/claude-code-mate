// ============================================================================
// MODULE CONTRACT(RFC: docs/discussions/2026-06-16-stack-model-rfc.md)
// ----------------------------------------------------------------------------
// 层:L1 Domain
// 责任:per-thread call stack 数据结构 + 持久化(到 threads.call_stack_json)
//   - Stack / Frame 纯数据类(无副作用)
//   - push/pop/peek/isEmpty 基本操作
//   - 4 种 Result 类型(Done/Bounce/Reject + 还有 transient Cancel 给 user 撤销)
//   - load/save 跟 DB 关联(单 thread 维度)
// 公共 API:
//   - createFrame(opts) → Frame
//   - createStack() → Stack
//   - load(projectId, threadSlug) → Stack
//   - save(projectId, threadSlug, stack) → void
//   - FrameStatus / RoleType 枚举常量
//   - Result classes
// 允许依赖:./db(L0)
// 禁止:
//   - 业务决策(push 谁 / pop 后给谁,那是 MarkerDispatcher 的事)
//   - 资源池调度(那是 SlotPool 的事)
//   - 跨进程通信
//
// [需求@2026-06-16] Phase 1 冷代码:模块完备但不接业务,业务层 Phase 3 切 SSOT。
// ============================================================================

const { db } = require('../db');

// ============================================================================
// 枚举常量
// ============================================================================

const RoleType = Object.freeze({
  R: 'R',
  H: 'H',
  B: 'B',
  C: 'C',
});

const FrameStatus = Object.freeze({
  RUNNING:           'running',           // LLM 正跑这帧
  AWAITING_CALLEE:   'awaiting_callee',   // 下方 frame 在跑,我等返回
  AWAITING_RESOURCE: 'awaiting_resource', // 我被 push 但 slot/H 还没拿到
  BLOCKED:           'blocked',           // 等 user 输入
  NEEDS_KICK:        'needs_kick',        // mate 重启遗留,等 user 触发
  DONE:              'done',              // transient,即将 pop
});

const ResultKind = Object.freeze({
  DONE:   'done',
  BOUNCE: 'bounce',
  REJECT: 'reject',
});

const RejectSubkind = Object.freeze({
  TASK_INVALID: 'task_invalid',
  CRASH:        'crash',
  TIMEOUT:      'timeout',
  CONFLICT:     'conflict',
  HANG:         'hang',
});

// ============================================================================
// Frame 数据类
// ============================================================================

/**
 * 创建一个 frame。所有字段都可选,缺省按下面默认值。
 * 不要直接 new Frame —— 用这个工厂。
 */
function createFrame({
  role,
  slot = null,
  instanceId = null,
  sessionId = null,
  boundThread = null,
  status = FrameStatus.AWAITING_RESOURCE,
  pushedAt = null,
  lastActivityAt = null,
  retryCount = 0,
  pendingQuestion = null,
  pendingQuestionMeta = null,
}) {
  if (!role || !Object.values(RoleType).includes(role)) {
    throw new Error(`createFrame: invalid role ${role}`);
  }
  if (slot !== null && (typeof slot !== 'number' || slot < 1 || slot > 4)) {
    throw new Error(`createFrame: slot must be 1-4 or null, got ${slot}`);
  }
  return {
    role,
    slot,
    instanceId,
    sessionId,
    boundThread,
    status,
    pushedAt: pushedAt ?? Date.now(),
    lastActivityAt: lastActivityAt ?? Date.now(),
    retryCount,
    pendingQuestion,
    pendingQuestionMeta,
  };
}

// ============================================================================
// Stack 操作(都返回新 stack,immutable 风格便于 reasoning)
// 但内部数组为简洁可变 — 由调用者保证序列化前不 mutate
// ============================================================================

function createStack() {
  return { frames: [] };
}

function isEmpty(stack) {
  return stack.frames.length === 0;
}

function depth(stack) {
  return stack.frames.length;
}

function peek(stack) {
  return stack.frames.length ? stack.frames[stack.frames.length - 1] : null;
}

function peekBelow(stack) {
  return stack.frames.length >= 2 ? stack.frames[stack.frames.length - 2] : null;
}

function push(stack, frame) {
  stack.frames.push(frame);
  return stack;
}

function pop(stack) {
  return stack.frames.pop() || null;
}

/**
 * frame.status 转移 — 防止业务直接改 status 改错。
 * 返回 true 表示转移合法。
 */
function transitionStatus(frame, newStatus) {
  const valid = Object.values(FrameStatus);
  if (!valid.includes(newStatus)) {
    throw new Error(`transitionStatus: invalid status ${newStatus}`);
  }
  // Phase 1 暂不强约束转移(因为业务还没接),写个白名单后面用
  frame.status = newStatus;
  frame.lastActivityAt = Date.now();
  return true;
}

// ============================================================================
// Result 类型(frame pop 时携带的返回值)
// ============================================================================

function makeDoneResult(summary) {
  return { kind: ResultKind.DONE, summary: String(summary || '') };
}

function makeBounceResult(reason) {
  return { kind: ResultKind.BOUNCE, reason: String(reason || '') };
}

function makeRejectResult(reason, subkind = RejectSubkind.TASK_INVALID, retriesAttempted = 0) {
  if (!Object.values(RejectSubkind).includes(subkind)) {
    throw new Error(`makeRejectResult: invalid subkind ${subkind}`);
  }
  return {
    kind: ResultKind.REJECT,
    reason: String(reason || ''),
    subkind,
    retriesAttempted,
  };
}

// ============================================================================
// 持久化(DB load/save) — lazy stmt 创建,模块加载不动 db
// (考虑到 require.cache mock 模式,把 prepare 延迟到首次调用)
// ============================================================================

let _stmtLoad = null;
let _stmtSave = null;
function _ensureStmts() {
  if (!_stmtLoad) {
    _stmtLoad = db.prepare(`SELECT call_stack_json FROM threads WHERE project_id = ? AND slug = ?`);
    _stmtSave = db.prepare(`UPDATE threads SET call_stack_json = ?, updated_at = ? WHERE project_id = ? AND slug = ?`);
  }
}

function load(projectId, threadSlug) {
  _ensureStmts();
  const row = _stmtLoad.get(projectId, threadSlug);
  if (!row) return null;
  if (!row.call_stack_json) return createStack();
  try {
    const parsed = JSON.parse(row.call_stack_json);
    if (!parsed || !Array.isArray(parsed.frames)) return createStack();
    return parsed;
  } catch {
    return createStack();
  }
}

function save(projectId, threadSlug, stack) {
  if (!stack || !Array.isArray(stack.frames)) {
    throw new Error('save: invalid stack');
  }
  _ensureStmts();
  const json = JSON.stringify({ frames: stack.frames });
  _stmtSave.run(json, Date.now(), projectId, threadSlug);
}

/**
 * 派生 thread.stage(SSOT 切换后用):看栈顶 frame 的 role
 */
function deriveStage(stack, outcome = null) {
  if (outcome === 'verified') return 'verified';
  if (outcome === 'aborted')  return 'aborted';
  if (isEmpty(stack)) return 'discussing';
  const top = peek(stack);
  const stageMap = {
    [RoleType.R]: 'discussing',
    [RoleType.H]: 'designing',
    [RoleType.B]: 'executing',
    [RoleType.C]: 'testing',
  };
  return stageMap[top.role] || 'discussing';
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  // 枚举
  RoleType,
  FrameStatus,
  ResultKind,
  RejectSubkind,

  // 工厂
  createFrame,
  createStack,

  // 栈操作
  isEmpty,
  depth,
  peek,
  peekBelow,
  push,
  pop,
  transitionStatus,

  // Result
  makeDoneResult,
  makeBounceResult,
  makeRejectResult,

  // 持久化
  load,
  save,

  // 派生
  deriveStage,
};
