// ============================================================================
// MODULE CONTRACT(RFC: docs/discussions/2026-06-16-stack-model-rfc.md Phase 2)
// ----------------------------------------------------------------------------
// 层:L1 Domain
// 责任:把老的 thread.metadata.dispatch_chain 重放成栈结构 + 派生 outcome。
//   纯函数,不动 DB,不改 chain。
//
// 公共 API:
//   - replayChain(chain, opts) → { stack, outcome }
//     opts.lookupSessionId(instanceId) → string|null  (可选,补 session_id)
//
// 允许依赖:./ThreadCallStack
// 禁止:
//   - 修改输入 chain
//   - 副作用
//
// [需求@2026-06-16] 算法考虑了老数据的兜底:
//   - isTerminal undefined / false 但栈只剩 R → 视为 terminal
//   - handoff push 时栈顶 instanceId 跟 fromInstanceId 不匹配 → 自愈补 push
//   - chain 末尾 outcome 取决于最终栈状态 + 最后一个 done 是否 terminal
// ============================================================================

const TCS = require('./ThreadCallStack');

// 把 role 字符串(mate-R / mate-H / mate-B / mate-C / requirements 等)归一化为 RoleType
function _inferRoleType(roleStr) {
  if (!roleStr) return null;
  const n = String(roleStr).toLowerCase();
  if (n.includes('mate-r') || n.includes('requirements')) return TCS.RoleType.R;
  if (n.includes('mate-h') || n.includes('orchestrator')) return TCS.RoleType.H;
  if (n.includes('mate-b') || n.includes('executor')) return TCS.RoleType.B;
  if (n.includes('mate-c') || n.includes('validator')) return TCS.RoleType.C;
  return null;
}

// 从 instanceId 抽 slot(老格式 mate-B-2 / mate-B.knulet 都见过)
function _inferSlot(role, instanceId, fallbackDisplayName) {
  if (role === TCS.RoleType.R) return null;
  if (role === TCS.RoleType.H) return 1;
  // B/C: 看 displayName 里有没有 -N
  const src = fallbackDisplayName || instanceId || '';
  const m = String(src).match(/[-](\d)\b/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 4) return n;
  }
  return null; // 不知道就 null,后续业务可以再补
}

/**
 * 重放 chain。
 *
 * @param chain  Array<{kind, fromRole, fromInstanceId, toRole, toInstanceId, toDisplayName, summary, isTerminal, question, reason, ts, ...}>
 * @param opts   { lookupSessionId?: (instanceId) => string|null }
 * @returns      { stack: Stack, outcome: 'verified'|'aborted'|null, warnings: string[] }
 */
function replayChain(chain, opts = {}) {
  const lookup = opts.lookupSessionId || (() => null);
  const stack = TCS.createStack();
  const warnings = [];
  let outcome = null;
  let maxDepth = 0;

  if (!Array.isArray(chain)) {
    return { stack, outcome, warnings: ['chain is not an array'] };
  }

  // 预扫:找 chain 里见过的 R 实例 id(可能多个 — 比如 R.fkhrq2 后又 R.l1yymz)
  // 用于栈空时补 R frame 的兜底(outcome reset 后又有非 R push 时用最近的 R)
  function _findRecentRInstance(uptoIdx) {
    for (let j = uptoIdx; j >= 0; j--) {
      const s = chain[j];
      if (s?.kind !== 'handoff') continue;
      const ft = _inferRoleType(s.fromRole);
      const tt = _inferRoleType(s.toRole);
      if (ft === TCS.RoleType.R && s.fromInstanceId) return s.fromInstanceId;
      if (tt === TCS.RoleType.R && s.toInstanceId) return s.toInstanceId;
    }
    return null;
  }

  for (let i = 0; i < chain.length; i++) {
    const seg = chain[i];
    if (!seg || typeof seg !== 'object') {
      warnings.push(`seg[${i}] invalid`);
      continue;
    }

    if (seg.kind === 'handoff') {
      // 新派工活动 — 如果之前曾经 verified/aborted,现在又有动 → reset(线索重启)
      if (outcome) {
        warnings.push(`seg[${i}] new handoff after outcome=${outcome},重置(线索重新激活)`);
        outcome = null;
      }
      // outcome-reset 兜底:栈空 + push from 不是 R → 补 R 栈底(用 chain 里最近见过的 R 实例)
      const fromType = _inferRoleType(seg.fromRole);
      if (TCS.isEmpty(stack) && fromType !== TCS.RoleType.R && fromType !== null) {
        const recentR = _findRecentRInstance(i - 1);
        if (recentR) {
          const rFrame = TCS.createFrame({
            role: TCS.RoleType.R,
            instanceId: recentR,
            sessionId: lookup(recentR),
            status: TCS.FrameStatus.AWAITING_CALLEE,
            pushedAt: (seg.ts || Date.now()) - 2,
          });
          TCS.push(stack, rFrame);
          warnings.push(`seg[${i}] outcome-reset 兜底:补 push R(${recentR})为栈底`);
        }
      }
      _applyHandoff(stack, seg, lookup, warnings, i);
    } else if (seg.kind === 'done') {
      const result = _applyDone(stack, seg, warnings, i);
      if (result === 'terminal') {
        outcome = 'verified';
        // 终态 → 栈清空,后续段如果再有 handoff 就会 reset outcome
        stack.frames.length = 0;
      }
    } else if (seg.kind === 'blocked') {
      _applyBlocked(stack, seg, warnings, i);
    } else if (seg.kind === 'reject') {
      // 同 handoff,reject 后又有动 → reset
      if (outcome === 'verified') {
        warnings.push(`seg[${i}] reject after outcome=verified,重置`);
        outcome = null;
      }
      const result = _applyReject(stack, seg, warnings, i);
      if (result === 'unwound_to_empty') {
        outcome = 'aborted';
      }
    } else {
      warnings.push(`seg[${i}] unknown kind: ${seg.kind}`);
    }

    if (TCS.depth(stack) > maxDepth) maxDepth = TCS.depth(stack);
  }

  // 栈顶 frame 状态推断:replay 完后,栈非空但最后一段不是 blocked / done 的话,
  // 栈顶 frame 应该处于 awaiting 之类的"中断"状态(对应 mate 重启时刻)
  // Phase 2 这里全标 needs_kick(老 thread 都是 mate 重启过的)
  for (const f of stack.frames) {
    if (f.status === 'running') f.status = TCS.FrameStatus.NEEDS_KICK;
  }

  return { stack, outcome, warnings };
}

function _applyHandoff(stack, seg, lookup, warnings, idx) {
  const fromType = _inferRoleType(seg.fromRole);
  const toType = _inferRoleType(seg.toRole);
  if (!fromType || !toType) {
    warnings.push(`seg[${idx}] handoff: unrecognized role (from=${seg.fromRole}, to=${seg.toRole})`);
    return;
  }

  const isCallback =
    (fromType === TCS.RoleType.B || fromType === TCS.RoleType.C) &&
    toType === TCS.RoleType.H;
  const isBounce = fromType === TCS.RoleType.H && toType === TCS.RoleType.R;

  if (isCallback) {
    // B/C → H callback: pop B/C
    const popped = TCS.pop(stack);
    if (!popped) warnings.push(`seg[${idx}] callback but stack was empty`);
    return;
  }

  if (isBounce) {
    // H → R bounce: pop H,替换 R(R 实例可能换了)
    const popped = TCS.pop(stack);
    if (popped?.role !== TCS.RoleType.H) {
      warnings.push(`seg[${idx}] bounce but top wasn't H (was ${popped?.role})`);
    }
    const rFrame = TCS.createFrame({
      role: TCS.RoleType.R,
      instanceId: seg.toInstanceId || null,
      sessionId: seg.toInstanceId ? lookup(seg.toInstanceId) : null,
      boundThread: seg.toInstanceId ? null : null, // 不放,由 caller 填
      status: TCS.FrameStatus.AWAITING_CALLEE,
      pushedAt: seg.ts || Date.now(),
    });
    if (TCS.isEmpty(stack)) {
      TCS.push(stack, rFrame);
    } else {
      // 替换栈底 R(如果实例 id 变了)
      const bottom = stack.frames[0];
      if (bottom.role === TCS.RoleType.R) {
        if (bottom.instanceId !== rFrame.instanceId) {
          stack.frames[0] = rFrame;
        }
      } else {
        warnings.push(`seg[${idx}] bounce: stack bottom isn't R, pushing R anyway`);
        stack.frames.unshift(rFrame);
      }
    }
    return;
  }

  // push down: R→H 或 H→B/C
  // 自愈:栈顶 instanceId 跟 fromInstanceId 不一致 → 补 push from
  const topInstId = TCS.peek(stack)?.instanceId;
  if (TCS.isEmpty(stack) || topInstId !== seg.fromInstanceId) {
    const fromFrame = TCS.createFrame({
      role: fromType,
      slot: _inferSlot(fromType, seg.fromInstanceId),
      instanceId: seg.fromInstanceId || null,
      sessionId: seg.fromInstanceId ? lookup(seg.fromInstanceId) : null,
      status: TCS.FrameStatus.AWAITING_CALLEE,
      pushedAt: (seg.ts || Date.now()) - 1, // 比当前 seg 略早
    });
    TCS.push(stack, fromFrame);
    if (!TCS.isEmpty(stack) && topInstId !== seg.fromInstanceId && topInstId !== undefined) {
      warnings.push(`seg[${idx}] push: self-healed missing from frame (top was ${topInstId}, expected ${seg.fromInstanceId})`);
    }
  }
  const toFrame = TCS.createFrame({
    role: toType,
    slot: _inferSlot(toType, seg.toInstanceId, seg.toDisplayName),
    instanceId: seg.toInstanceId || null,
    sessionId: seg.toInstanceId ? lookup(seg.toInstanceId) : null,
    status: TCS.FrameStatus.RUNNING, // 后续可能被 done/handoff 改 / 末尾被改 needs_kick
    pushedAt: seg.ts || Date.now(),
  });
  // 之前栈顶应改成 awaiting_callee(它现在不是栈顶了)
  const prevTop = stack.frames[stack.frames.length - 1];
  if (prevTop) prevTop.status = TCS.FrameStatus.AWAITING_CALLEE;
  TCS.push(stack, toFrame);
}

function _applyDone(stack, seg, warnings, idx) {
  // 判 terminal:
  //  - seg.isTerminal === true → 明确 terminal
  //  - 栈空 → 直接 terminal
  //  - 栈顶的 caller(栈倒数第二)是 R 或 栈深=1(无 caller) → 推断 terminal
  //    (老数据 isTerminal=false 但 caller 实际是 R 的 bug 案例兜底)
  if (TCS.isEmpty(stack)) return 'terminal';
  if (seg.isTerminal === true) return 'terminal';

  // caller 是栈顶下面那一帧
  const caller = TCS.peekBelow(stack);
  const callerIsR = !caller || caller.role === TCS.RoleType.R;
  if (callerIsR) {
    return 'terminal';
  }

  // pop 一层
  const popped = TCS.pop(stack);
  if (!popped) {
    warnings.push(`seg[${idx}] done but stack already empty`);
  }
  return 'popped';
}

function _applyBlocked(stack, seg, warnings, idx) {
  const top = TCS.peek(stack);
  if (!top) {
    warnings.push(`seg[${idx}] blocked but stack empty`);
    return;
  }
  top.status = TCS.FrameStatus.BLOCKED;
  top.pendingQuestion = seg.question || null;
  if (seg.severity) {
    top.pendingQuestionMeta = { severity: seg.severity };
  }
}

function _applyReject(stack, seg, warnings, idx) {
  // 老协议 reject 带 bounce_to (mate-R) — 在栈模型里就是 pop self
  // 如果 bounce_to=mate-R 且 caller 不是 R,理论上要继续 unwind
  // 但 chain 里 reject 通常出现在 R/H 决策点,简化处理:只 pop 一次
  const popped = TCS.pop(stack);
  if (!popped) {
    warnings.push(`seg[${idx}] reject but stack empty`);
  }
  // 如果 bounce_to=mate-R 显示要弹到 R,但栈非空且栈顶不是 R,可能需要继续 unwind
  // 这里简化:如果 bounce_to=mate-R 且栈非空但栈顶不是 R,只标 warning 不强弹
  if (seg.bounce_to === 'mate-R' && !TCS.isEmpty(stack) && TCS.peek(stack).role !== TCS.RoleType.R) {
    warnings.push(`seg[${idx}] reject bounce_to=mate-R but unwound stack top is ${TCS.peek(stack).role}`);
  }
  if (TCS.isEmpty(stack)) {
    return 'unwound_to_empty';
  }
  return 'popped';
}

module.exports = {
  replayChain,
  // 暴露 helper 供测试
  _inferRoleType,
  _inferSlot,
};
