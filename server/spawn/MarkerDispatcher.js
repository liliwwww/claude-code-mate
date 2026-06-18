// ============================================================================
// MODULE CONTRACT(架构 SSOT:docs/architecture.md §3 §4 §6)
// ----------------------------------------------------------------------------
// 层:L2 Process Control
// 责任:解析过的 marker 数组 → side effect。
//   - handoff:切 thread.stage + 拼 handoffText + 调 sendToThread + 触发 4 阶段
//     事件 + 入 HandoffTracker
//   - done:翻 thread.stage='verified' + emit thread.done
//   - blocked:写 thread.metadata.blocked + emit thread.blocked
//   - 优先级:done > blocked > handoff
// 公共 API:
//   handleMarkers(fromInst, markers, { sendToThread }) — 优先级 dispatch
//   parseMarkerTarget(target)                          — "execB-2" → {roleName, poolSlot}
// 允许依赖:./HandoffTracker / ../roles/RoleCatalog / ../threads/ThreadStore /
//   ../db / messageBus
// 禁止:
//   - 替 LLM 决策(只机械执行 marker)
//   - 持有 instances Map(只接 fromInst + 调用 sendToThread callback)
//   - 跨进程通信(只 publish bus)
// ============================================================================
//
// [arch §1.4 ✅ 2026-06-13] 从 SpawnManager 抽出。

const bus = require('../messageBus');
const { db, recordEvent, stmts } = require('../db');
const ThreadStore = require('../threads/ThreadStore');
const roleCatalog = require('../roles/RoleCatalog');
const HandoffTracker = require('./HandoffTracker');
// [Phase 3.2 @2026-06-17] 栈 SSOT — handoff/done/blocked/reject 同步更新栈
const TCS = require('../threads/ThreadCallStack');
// [需求@2026-06-19] 派工文件落盘
const DispatchLogWriter = require('../threads/DispatchLogWriter');

const STAGE_BY_TARGET_TYPE = {
  orchestrator: 'designing',
  executor: 'executing',
  validator: 'testing',
  requirements: 'discussing',
};

// [Phase 3.2 @2026-06-17] role.type → TCS RoleType 映射
const ROLE_TYPE_TO_TCS = {
  requirements: TCS.RoleType.R,
  orchestrator: TCS.RoleType.H,
  executor:     TCS.RoleType.B,
  validator:    TCS.RoleType.C,
};

// [Phase 3.6 @2026-06-19 backlog #156/#154 收尾] 栈完全从 chain 派生
//
// 原 Phase 3.2 双写栈(incremental mutator)有累积漏洞:bounce/callback/push
// 顺序组合下产生重复帧。backlog #156 案例: depth=4 出现重复 R+H。
//
// 改成:chain 是 SSOT,每次 marker 后用 replayChain 重算栈。代价 O(N) replay
// (N 通常 <100),收益是"不可能累积漏洞"——重算结果永远跟 chain 一致。
//
// 副作用:
//   - mutator 参数仍接受(兼容老调用),但实际忽略(都用 chain replay)
//   - frame.status 现在反映"chain 历史最后一刻该 frame 的状态",不反映
//     user 直接发消息后的实时 running(backlog #154 — 维持现状,跟 chain 派生
//     一致即可,UI 实时状态由 inst.status 单独显示)
function _updateStack(projectId, threadSlug, _mutatorIgnored) {
  try {
    // 1. 取最新 chain(已经被调用方 appendDispatchChain 更新过了)
    const thread = ThreadStore.get(projectId, threadSlug);
    const chain = thread?.metadata?.dispatch_chain || [];

    // 2. session_id 反查:从 chain 段里的 fromInstanceId / toInstanceId 查 role_instances
    const sessionLookup = (instId) => {
      if (!instId) return null;
      try {
        const row = db.prepare('SELECT claude_session_id FROM role_instances WHERE id = ?').get(instId);
        return row?.claude_session_id || null;
      } catch { return null; }
    };

    // 3. replay chain → derived stack
    const { replayChain } = require('../threads/replayChain');
    const { stack, outcome } = replayChain(chain, { lookupSessionId: sessionLookup });

    // 4. 保存
    TCS.save(projectId, threadSlug, stack);

    // 5. outcome 同步 threads.outcome 字段
    if (outcome) {
      try {
        db.prepare(`UPDATE threads SET outcome = ?, updated_at = ? WHERE project_id = ? AND slug = ?`)
          .run(outcome, Date.now(), projectId, threadSlug);
      } catch (e) {
        console.warn(`[MarkerDispatcher] outcome write failed: ${e.message}`);
      }
    }

    // 6. stage 派生
    try {
      const outcomeRow = db.prepare(`SELECT outcome FROM threads WHERE project_id = ? AND slug = ?`).get(projectId, threadSlug);
      const derived = TCS.deriveStage(stack, outcomeRow?.outcome || null);
      db.prepare(`UPDATE threads SET stage = ?, updated_at = ? WHERE project_id = ? AND slug = ?`)
        .run(derived, Date.now(), projectId, threadSlug);
    } catch (e) {
      console.warn(`[MarkerDispatcher] derive stage write failed: ${e.message}`);
    }
  } catch (e) {
    console.warn(`[MarkerDispatcher] stack update failed for ${threadSlug}: ${e.message}`);
  }
}

function _frameFromInst(inst, role) {
  return TCS.createFrame({
    role: ROLE_TYPE_TO_TCS[inst.role?.type || role?.type] || TCS.RoleType.H,
    slot: inst.poolSlot || (inst.role?.type === 'orchestrator' ? 1 : null),
    instanceId: inst.id,
    sessionId: inst.sessionId || null,
    boundThread: inst.threadSlug || null,
    status: TCS.FrameStatus.RUNNING,
  });
}

/**
 * 解析 marker target:"execB" → {roleName:'execB', poolSlot:null};
 * "execB-2" → {roleName:'execB', poolSlot:2}。
 */
function parseMarkerTarget(target) {
  const m = String(target).match(/^([a-zA-Z][a-zA-Z0-9_-]*?)-(\d+)$/);
  if (m && roleCatalog.get(m[1])) {
    return { roleName: m[1], poolSlot: parseInt(m[2], 10) };
  }
  return { roleName: target, poolSlot: null };
}

/**
 * 优先级 dispatch:done > blocked > handoff,首个出现的处理完后**静默忽略**
 * 剩余 marker(避免 done 翻 verified 后还派下一个角色 → 孤儿实例)。
 *
 * @param {RoleInstance} fromInst
 * @param {Array} markers       MarkerDetector.detect 的输出
 * @param {Object} opts
 * @param {Function} opts.sendToThread  注入 — 派工时调
 */
async function handleMarkers(fromInst, markers, { sendToThread }) {
  if (!fromInst.threadSlug) return;
  // [Phase 2H Phase 3] reject 优先级 — H 处理某条 queue 项时如果拒绝,先 emit reject 信号
  //   (注意:reject 是对**正在跑的这条 queue 项**说"我不接",而不是对未来的"过滤")
  const reject = markers.find((m) => m.kind === 'reject');
  if (reject) {
    try { _performReject(fromInst, reject.reason, reject.bounceTo, { sendToThread }); }
    catch (e) { console.warn(`[MarkerDispatcher] reject marker failed (${fromInst.id}):`, e.message); }
    return;
  }
  const done = markers.find((m) => m.kind === 'done');
  if (done) {
    try { _performDone(fromInst, done.summary, { sendToThread }); }
    catch (e) { console.warn(`[MarkerDispatcher] done marker failed (${fromInst.id}):`, e.message); }
    if (markers.length > 1) {
      console.warn(`[MarkerDispatcher] ignoring ${markers.length - 1} subsequent marker(s) after <mate:done /> from ${fromInst.id}`);
    }
    return;
  }
  const blocked = markers.find((m) => m.kind === 'blocked');
  if (blocked) {
    try { _performBlocked(fromInst, blocked.question, blocked.severity); }
    catch (e) { console.warn(`[MarkerDispatcher] blocked marker failed (${fromInst.id}):`, e.message); }
    const others = markers.filter((m) => m.kind !== 'blocked');
    if (others.length) {
      console.warn(`[MarkerDispatcher] ignoring ${others.length} non-blocked marker(s) alongside <mate:blocked /> from ${fromInst.id}`);
    }
    return;
  }
  // [Phase 4 @2026-06-17] bounce 协议 — H 弹回 R(语义上 = handoff target=mate-R)
  //   优先级在 handoff 之上,因为 bounce 是更明确的语义,如果两者并存(LLM 写错),bounce 赢。
  const bounce = markers.find((m) => m.kind === 'bounce');
  if (bounce) {
    try {
      await _performHandoff(fromInst, 'mate-R', bounce.reason, { sendToThread });
    } catch (e) {
      console.warn(`[MarkerDispatcher] bounce marker failed (${fromInst.id}):`, e.message);
    }
    if (markers.length > 1) {
      console.warn(`[MarkerDispatcher] ignoring ${markers.length - 1} subsequent marker(s) after <mate:bounce /> from ${fromInst.id}`);
    }
    return;
  }
  const handoff = markers.find((m) => m.kind === 'handoff');
  if (handoff) {
    try {
      await _performHandoff(fromInst, handoff.target, handoff.reason, { sendToThread, taskSlug: handoff.taskSlug });
    } catch (e) {
      console.warn(`[MarkerDispatcher] handoff marker failed (${fromInst.id}):`, e.message);
      // [需求@2026-06-12 Phase 2E §10] 派工失败 → 通知前端红色卡片
      bus.publish('thread.handoff.failed', {
        projectId: fromInst.projectId,
        threadSlug: fromInst.threadSlug,
        from: fromInst.role.name,
        target: handoff.target,
        reason: handoff.reason,
        error: e.message,
        handoffKey: `${fromInst.projectId}::${fromInst.threadSlug}::FAILED::${Date.now()}`,
      });
    }
  }
}

// [需求@2026-06-12 §6 + 8.3] target 可以是 "execB"(泛型)或 "execB-2"(具体 slot)
// [需求@2026-06-19] taskSlug 可选 — R 派工时给的工单代号,用于派工文件命名
async function _performHandoff(fromInst, targetSpec, reason, { sendToThread, taskSlug = null } = {}) {
  const { roleName: targetRoleName, poolSlot: targetSlot } = parseMarkerTarget(targetSpec);
  const targetRole = roleCatalog.get(targetRoleName);
  if (!targetRole) {
    console.warn(`[MarkerDispatcher] handoff target "${targetSpec}" → role "${targetRoleName}" not found in catalog`);
    return;
  }
  const project = stmts.getProject.get(fromInst.projectId);
  if (!project) return;

  // Stage progression (data-driven from target role type)
  const nextStage = STAGE_BY_TARGET_TYPE[targetRole.type] || null;
  if (nextStage) {
    try { ThreadStore.setStage(fromInst.projectId, fromInst.threadSlug, nextStage); } catch {}
  }

  // Build first message for target role: thread slug + reason + recent context summary
  const recent = db.prepare(`
    SELECT event_type, payload_json FROM messages
    WHERE project_id = ? AND thread_slug = ? AND event_type IN ('user','assistant')
    ORDER BY ts DESC LIMIT 6
  `).all(fromInst.projectId, fromInst.threadSlug);
  const ctx = recent.reverse().map((r) => {
    try {
      const p = JSON.parse(r.payload_json);
      const content = p.message?.content;
      const text = Array.isArray(content)
        ? content.filter((c) => c.type === 'text').map((c) => c.text).join('')
        : (typeof content === 'string' ? content : '');
      return `[${r.event_type}] ${text.slice(0, 500)}`;
    } catch { return ''; }
  }).filter(Boolean).join('\n\n');

  const handoffText = [
    `# Thread handoff from ${fromInst.role.name}`,
    ``,
    `**Thread:** \`${fromInst.threadSlug}\`  (project root: \`${project.root_dir}\`)`,
    `**Reason for handoff:** ${reason || '(unspecified)'}`,
    ``,
    `## Recent conversation context (last 6 messages):`,
    ``,
    ctx || '(no prior messages)',
    ``,
    `---`,
    ``,
    `Begin your role's work on this thread.`,
  ].join('\n');

  // [需求@2026-06-15 Phase 2G M1.1] 告诉 sendToThread 这是 marker 派工 — busy 时落 queue
  const inst = sendToThread({
    projectId: fromInst.projectId,
    projectRootDir: project.root_dir,
    threadSlug: fromInst.threadSlug,
    text: handoffText,
    roleType: targetRole.type,
    targetSlot,
    fromMarker: true,
    markerFromInst: fromInst,
    markerSpec: targetSpec,
    markerReason: reason,
  });

  // [需求@2026-06-15 Phase 2G M1.1] queue 路径:不发 thread.handoff(它意味着真派出去了)
  //   只发 dispatch.busy_prompt(已在 QueueDispatcher.enqueueBusy 里 emit)。
  //   user 三选一后续才会 emit queue.added / queue.claimed 等。
  if (inst._queuedPendingSendId) {
    const pid = inst._queuedPendingSendId;
    delete inst._queuedPendingSendId;
    recordEvent('thread.handoff.queued', {
      from: fromInst.role.name, target: targetSpec, resolvedRole: targetRoleName,
      resolvedSlot: targetSlot, reason,
      fromInstanceId: fromInst.id, toInstanceId: inst.id,
      pendingSendId: pid,
    }, { projectId: fromInst.projectId, threadSlug: fromInst.threadSlug });
    return;
  }

  // [Phase 3.2 @2026-06-17] 栈双写 — handoff = push/pop/bounce 三种语义
  //   - B/C → H = callback: pop B/C(子工返回)
  //   - H → R = bounce: pop H + 替换栈底 R
  //   - 其它 push down (R→H 或 H→B/C): push to-frame
  _updateStack(fromInst.projectId, fromInst.threadSlug, (stack) => {
    const fromTcsType = ROLE_TYPE_TO_TCS[fromInst.role?.type];
    const toTcsType = ROLE_TYPE_TO_TCS[targetRole?.type];
    const isCallback = (fromTcsType === TCS.RoleType.B || fromTcsType === TCS.RoleType.C)
                       && toTcsType === TCS.RoleType.H;
    const isBounce = fromTcsType === TCS.RoleType.H && toTcsType === TCS.RoleType.R;
    if (isCallback) {
      TCS.pop(stack); // B/C 弹栈
    } else if (isBounce) {
      TCS.pop(stack); // 弹 H
      // 替换栈底 R(可能 R 实例 id 变了)
      const newR = TCS.createFrame({
        role: TCS.RoleType.R,
        instanceId: inst.id,
        sessionId: inst.sessionId || null,
        boundThread: fromInst.threadSlug,
        status: TCS.FrameStatus.RUNNING,
      });
      if (TCS.isEmpty(stack)) TCS.push(stack, newR);
      else stack.frames[0] = newR;
    } else {
      // push down
      // 栈空就先 push from(自愈)
      const topInstId = TCS.peek(stack)?.instanceId;
      if (TCS.isEmpty(stack) || topInstId !== fromInst.id) {
        TCS.push(stack, _frameFromInst(fromInst));
      }
      // push to
      TCS.push(stack, _frameFromInst(inst, targetRole));
    }
  });

  // [需求@2026-06-15 Phase 2G M1.2] dispatch_chain 追加段
  try {
    const updated = ThreadStore.appendDispatchChain(fromInst.projectId, fromInst.threadSlug, {
      kind: 'handoff',
      fromRole: fromInst.role.name,
      fromInstanceId: fromInst.id,
      toRole: targetRoleName,
      toInstanceId: inst.id,
      toDisplayName: inst.displayName,
      targetSpec,
      reason: reason || '',
    });
    bus.publish('dispatch.chain_updated', {
      projectId: fromInst.projectId,
      threadSlug: fromInst.threadSlug,
      chain: updated?.metadata?.dispatch_chain || [],
    });
  } catch (e) {
    console.warn(`[MarkerDispatcher] dispatch_chain append failed: ${e.message}`);
  }

  recordEvent('thread.handoff', {
    from: fromInst.role.name, target: targetSpec, resolvedRole: targetRoleName,
    resolvedSlot: targetSlot, reason,
    fromInstanceId: fromInst.id, toInstanceId: inst.id,
  }, { projectId: fromInst.projectId, threadSlug: fromInst.threadSlug });

  // [需求@2026-06-19] 派工文件落盘 — push down 写新文件, callback 追加 section
  try {
    const fromTcs = ROLE_TYPE_TO_TCS[fromInst.role?.type];
    const toTcs = ROLE_TYPE_TO_TCS[targetRole?.type];
    const isCallback = (fromTcs === TCS.RoleType.B || fromTcs === TCS.RoleType.C)
                       && toTcs === TCS.RoleType.H;
    const isBounceBack = fromTcs === TCS.RoleType.H && toTcs === TCS.RoleType.R;

    if (isCallback) {
      // B/C → H callback:追加 callback section 到上一个 push 文件
      DispatchLogWriter.onCallback({
        projectId: fromInst.projectId,
        projectRootDir: project.root_dir,
        threadSlug: fromInst.threadSlug,
        fromInst,
        summary: reason || '',
      });
    } else {
      // push down (R→H, H→B/C) 或 bounce back (H→R):写新派工文件
      DispatchLogWriter.onPushDispatch({
        projectId: fromInst.projectId,
        projectRootDir: project.root_dir,
        threadSlug: fromInst.threadSlug,
        fromInst,
        toInst: inst,
        reason: reason || '',
        taskSlug,
        recentContext: ctx,
      });
    }
  } catch (e) {
    console.warn(`[MarkerDispatcher] dispatch log write failed: ${e.message}`);
  }

  // [需求@2026-06-12 Phase 2E §10] 派工进度三阶段
  const handoffKey = `${fromInst.projectId}::${fromInst.threadSlug}::${inst.id}::${Date.now()}`;
  const basePayload = {
    projectId: fromInst.projectId,
    threadSlug: fromInst.threadSlug,
    from: fromInst.role.name,
    target: targetSpec,
    reason,
    handoffKey,
    toInstanceId: inst.id,
    toDisplayName: inst.displayName,
  };
  bus.publish('thread.handoff', basePayload);

  // 派工瞬间 target inst 可能已是 busy(idle → sendUserText → busy 同步翻),也可能仍 spawning
  if (inst.status === 'busy') {
    setImmediate(() => bus.publish('thread.handoff.ready', { ...basePayload }));
  } else {
    if (inst.status === 'spawning') {
      setImmediate(() => bus.publish('thread.handoff.spawning', { ...basePayload }));
    }
    HandoffTracker.register(inst.id, basePayload, inst.status === 'spawning');
  }
}

// [需求@2026-06-16 Phase 2I] done 语义重写 — 不再单方面 verified,实现真 call stack pop:
//   1. 在 dispatch_chain 倒推 fromInst 的 caller(谁派的这一层)
//   2. 如果 caller 不存在(stack 底) OR caller 是 R(role.type='requirements'):
//      - 这是 stack 底层的 done → thread 真 verified
//      - 如果有 R caller,把 summary 当 user_to_role 注入给 R,让 R 跟 user 对接
//   3. 如果 caller 是 H 或其他池化角色:
//      - pop 一层,summary 当 user_to_role 注入给 caller,让 caller 继续(很可能 H 收到 B 的 callback)
//      - thread 不翻 verified,留在 executing 等 R 最终拍板
function _performDone(fromInst, summary, { sendToThread }) {
  const projectId = fromInst.projectId;
  const threadSlug = fromInst.threadSlug;
  // 取 chain + 倒推 caller
  const thread = ThreadStore.get(projectId, threadSlug);
  const chain = thread?.metadata?.dispatch_chain || [];

  function _inferRoleType(name) {
    if (!name) return null;
    const n = String(name).toLowerCase();
    if (n.includes('mate-r') || n.includes('requirements')) return 'requirements';
    if (n.includes('mate-h') || n.includes('orchestrator')) return 'orchestrator';
    if (n.includes('mate-b') || n.includes('executor')) return 'executor';
    if (n.includes('mate-c') || n.includes('validator')) return 'validator';
    return null;
  }

  // [Phase 3.1 @2026-06-17] caller 查找优先用栈派生(thread.call_stack_json),
  //   栈空/缺失/找不到 fromInst 时 fallback 老算法(反向扫 chain 跳 callback)
  //   栈视图下:fromInst 在栈某层,下一层就是 caller frame。
  //   这是把 770ec88 修的反向扫漏洞彻底封死的最终解 — RFC 栈模型 SSOT。
  let callerInstId = null;
  let callerRoleType = null;
  let usedStackLookup = false;
  try {
    const stackJson = thread?.call_stack_json;
    if (stackJson) {
      const stack = JSON.parse(stackJson);
      const frames = Array.isArray(stack?.frames) ? stack.frames : [];
      // 找 fromInst.id 所在位置(从顶往下扫,优先栈顶 — 最近一次 push)
      let idx = -1;
      for (let i = frames.length - 1; i >= 0; i--) {
        if (frames[i].instanceId === fromInst.id) { idx = i; break; }
      }
      if (idx > 0) {
        const callerFrame = frames[idx - 1];
        // 把 frame.role(R/H/B/C)翻成 callerRoleType 字符串 mate-X
        const roleMap = { R: 'mate-R', H: 'mate-H', B: 'mate-B', C: 'mate-C' };
        callerInstId = callerFrame.instanceId;
        callerRoleType = roleMap[callerFrame.role] || null;
        usedStackLookup = true;
      } else if (idx === 0) {
        // fromInst 是栈底(通常是 R 自己),没 caller
        usedStackLookup = true;  // 也算"用栈成功",caller = null = terminal
      }
    }
  } catch (e) {
    console.warn(`[MarkerDispatcher] stack-lookup caller failed: ${e.message}, fallback to chain reverse-scan`);
  }

  // Fallback: 反向扫 chain 跳 callback(770ec88 算法)
  if (!usedStackLookup) {
    for (let i = chain.length - 1; i >= 0; i--) {
      const seg = chain[i];
      if (seg.kind !== 'handoff') continue;
      if (seg.toInstanceId !== fromInst.id) continue;
      const fromType = _inferRoleType(seg.fromRole);
      const toType = _inferRoleType(seg.toRole);
      const isCallback = (fromType === 'executor' || fromType === 'validator') && toType === 'orchestrator';
      if (isCallback) continue;
      callerInstId = seg.fromInstanceId;
      callerRoleType = seg.fromRole || null;
      break;
    }
  }

  // 判 terminal — caller 是 R 或没 caller
  const isTerminalDoneEarly = !callerInstId || callerRoleType === 'mate-R' || callerRoleType === 'requirements';

  // [Phase 3.2 @2026-06-17] 栈双写 — done = pop frame
  //   terminal: 整栈清空 + outcome=verified
  //   非 terminal: 弹自己一层
  _updateStack(projectId, threadSlug, (stack) => {
    if (isTerminalDoneEarly) {
      stack.frames.length = 0;
      // outcome 设栈外字段(threads.outcome 列)— 用 ThreadStore 同步落
    } else {
      // pop self(找到自己再弹)
      const idx = stack.frames.findIndex((f) => f.instanceId === fromInst.id);
      if (idx >= 0) {
        stack.frames.splice(idx); // 从 idx 起全弹(包括自己)
      } else {
        TCS.pop(stack); // 没找到 fallback 弹栈顶
      }
    }
  });

  // append done segment to chain(无论 pop 还是 terminal)
  try {
    const updated = ThreadStore.appendDispatchChain(projectId, threadSlug, {
      kind: 'done',
      fromRole: fromInst.role.name,
      fromInstanceId: fromInst.id,
      summary: summary || '',
      callerInstanceId: callerInstId,
      isTerminal: isTerminalDoneEarly,
    });
    bus.publish('dispatch.chain_updated', {
      projectId, threadSlug,
      chain: updated?.metadata?.dispatch_chain || [],
    });
  } catch (e) {
    console.warn(`[MarkerDispatcher] dispatch_chain done append failed: ${e.message}`);
  }

  recordEvent('thread.done', { summary, fromInstanceId: fromInst.id, callerInstanceId: callerInstId },
    { projectId, threadSlug });

  // [需求@2026-06-19] 派工文件追加 Done section
  try {
    const project = stmts.getProject.get(projectId);
    if (project) {
      DispatchLogWriter.onDone({
        projectId,
        projectRootDir: project.root_dir,
        threadSlug,
        fromInst,
        summary: summary || '',
        isTerminal: isTerminalDoneEarly,
      });
    }
  } catch (e) {
    console.warn(`[MarkerDispatcher] dispatch log onDone failed: ${e.message}`);
  }

  // 判 terminal 还是 pop:
  // - 没 caller(stack 底层 R 自己 done)→ terminal
  // - caller role 是 requirements(R)→ terminal,且要给 R 注入 summary 让它告诉 user
  // - 其它(caller 是 H 或 B/C)→ pop,自动注入 callback message 给 caller
  const isTerminalDone = isTerminalDoneEarly;

  if (isTerminalDone) {
    // R 在 stack 底 emit done(或者根本没 caller)= 真 verified
    try { ThreadStore.setStage(projectId, threadSlug, 'verified'); } catch (e) {
      console.warn(`[MarkerDispatcher] setStage verified failed:`, e.message);
    }
    // [Phase 3.2 @2026-06-17] outcome 字段也写(栈空 + verified)
    try {
      db.prepare(`UPDATE threads SET outcome = 'verified', updated_at = ? WHERE project_id = ? AND slug = ?`)
        .run(Date.now(), projectId, threadSlug);
    } catch (e) { console.warn(`[MarkerDispatcher] outcome write failed: ${e.message}`); }
    // 如果 caller 是 R,把 summary 也送给 R 让它跟 user 翻译(可选,R 可能没 instance 在)
    if (callerInstId && callerRoleType === 'requirements' && sendToThread) {
      try {
        const project = require('../db').stmts.getProject.get(projectId);
        if (project) {
          sendToThread({
            projectId, projectRootDir: project.root_dir, threadSlug,
            text: `[<delegate ${fromInst.displayName} done>] ${summary || '(no summary)'}\n\nYour delegated task chain finished. Above is the summary returned by ${fromInst.role.name}. Translate this result to the user and confirm whether they're satisfied — if so, emit <mate:done summary="...for user..." /> to close the thread.`,
            roleType: 'requirements',
            fromMarker: true,
            markerFromInst: fromInst,
            markerSpec: 'mate-R',
            markerReason: 'callback-after-delegate-done',
          });
        }
      } catch (e) {
        console.warn(`[MarkerDispatcher] terminal-done R-notify failed:`, e.message);
      }
    }
    bus.publish('thread.done', {
      projectId, threadSlug, summary,
      isTerminal: true,
      thread: ThreadStore.get(projectId, threadSlug),
    });
    return;
  }

  // POP — caller 是 H 或其他池化角色,送 summary 给 caller 让它继续
  if (sendToThread) {
    try {
      const project = require('../db').stmts.getProject.get(projectId);
      if (project) {
        // [bug@2026-06-16] callback 派回 caller 的 roleType 必须按 callerRoleType 推断
        //   原来硬编码 'orchestrator' 两边一样,导致 caller 是 B 时也送给 H 自己 → 死循环
        const callerRoleTypeNorm = _inferRoleType(callerRoleType) || 'orchestrator';
        sendToThread({
          projectId, projectRootDir: project.root_dir, threadSlug,
          text: `[<callback from ${fromInst.displayName}>] ${summary || '(no summary)'}\n\nYour delegated sub-work returned with the above summary. Per the H Verification Protocol, you MUST verify the claim before accepting:\n- Use Read / Grep / Bash to spot-check the key claims\n- If verified ✅ → emit <mate:done summary="..." /> with evidence pointers (pop to caller)\n- If partial ⚠️ → handoff back to ${fromInst.displayName} with specifics of what's missing\n- If failed ❌ (hallucination) → handoff back to redo, or <mate:reject reason="..." bounce_to="mate-R" />`,
          roleType: callerRoleTypeNorm,
          fromMarker: true,
          markerFromInst: fromInst,
          markerSpec: callerInstId,
          markerReason: 'callback-from-delegate',
        });
        bus.publish('dispatch.popped', {
          projectId, threadSlug,
          fromInstanceId: fromInst.id,
          fromDisplayName: fromInst.displayName,
          fromRoleType: fromInst.role.type,
          toInstanceId: callerInstId,
          summary,
          ts: Date.now(),
        });
      }
    } catch (e) {
      console.warn(`[MarkerDispatcher] pop callback to ${callerInstId} failed:`, e.message);
    }
  }
}

function _performBlocked(fromInst, question, severity) {
  const thread = ThreadStore.get(fromInst.projectId, fromInst.threadSlug);
  if (!thread) return;
  const meta = thread.metadata || {};
  meta.blocked = {
    question,
    severity: severity || 'mid',
    ts: Date.now(),
    raisedBy: fromInst.role.name,
  };
  // [bug@2026-06-17] 直接在 marker 处设路由字段 — 不等 SystemAgent.generateReplyTemplate
  //   (SystemAgent 是 LLM 调用,mock/快速场景下不走;且 blocked marker 本身就是
  //   "明确的 user 问题",不需要 LLM 再判一次)
  meta.has_pending_question = true;
  meta.last_questioner_role_type = fromInst.role?.type || null;
  try {
    db.prepare(`UPDATE threads SET metadata_json = ?, updated_at = ? WHERE project_id = ? AND slug = ?`)
      .run(JSON.stringify(meta), Date.now(), fromInst.projectId, fromInst.threadSlug);
  } catch (e) {
    console.warn(`[MarkerDispatcher] blocked metadata persist failed:`, e.message);
    return;
  }
  // [Phase 3.2 @2026-06-17] 栈双写 — blocked = 栈顶 frame 状态 blocked + pending_question
  _updateStack(fromInst.projectId, fromInst.threadSlug, (stack) => {
    // 找到 fromInst 那一帧(应该是栈顶),设 blocked
    const idx = stack.frames.findIndex((f) => f.instanceId === fromInst.id);
    const frame = idx >= 0 ? stack.frames[idx] : TCS.peek(stack);
    if (frame) {
      frame.status = TCS.FrameStatus.BLOCKED;
      frame.pendingQuestion = question || null;
      frame.pendingQuestionMeta = { severity: severity || 'mid' };
    }
  });
  // [Phase 2G M1.2] append blocked segment to chain
  try {
    const updated = ThreadStore.appendDispatchChain(fromInst.projectId, fromInst.threadSlug, {
      kind: 'blocked',
      fromRole: fromInst.role.name,
      fromInstanceId: fromInst.id,
      question: (question || '').slice(0, 120),
      severity: severity || 'mid',
    });
    bus.publish('dispatch.chain_updated', {
      projectId: fromInst.projectId,
      threadSlug: fromInst.threadSlug,
      chain: updated?.metadata?.dispatch_chain || [],
    });
  } catch (e) {
    console.warn(`[MarkerDispatcher] dispatch_chain blocked append failed: ${e.message}`);
  }
  recordEvent('thread.blocked', { question, severity, fromInstanceId: fromInst.id },
    { projectId: fromInst.projectId, threadSlug: fromInst.threadSlug });
  // [需求@2026-06-19] 派工文件追加 Blocked section
  try {
    const project = stmts.getProject.get(fromInst.projectId);
    if (project) {
      DispatchLogWriter.onBlocked({
        projectId: fromInst.projectId,
        projectRootDir: project.root_dir,
        threadSlug: fromInst.threadSlug,
        fromInst, question, severity,
      });
    }
  } catch (e) {
    console.warn(`[MarkerDispatcher] dispatch log onBlocked failed: ${e.message}`);
  }
  bus.publish('thread.blocked', {
    projectId: fromInst.projectId,
    threadSlug: fromInst.threadSlug,
    question,
    severity: severity || 'mid',
    raisedBy: fromInst.role.name,
    thread: ThreadStore.get(fromInst.projectId, fromInst.threadSlug),
  });
}

// [需求@2026-06-16 Phase 2H Phase 3] H 拒绝某条 queue item
//   语义:H 看了 task board snapshot + 新派工内容,判断"跟现有 chain 冲突",emit reject
//   行为:
//     1. emit dispatch.rejected event(细粒度日志 + UI 显)
//     2. dispatch_chain append { kind: 'reject', reason }
//     3. 不真正 dispatch 给 bounce_to(留 user 处理) — 只记录"H 拒了"+ reason
function _performReject(fromInst, reason, bounceTo, { sendToThread } = {}) {
  // [Phase 3.2 @2026-06-17] 栈双写 — reject = pop self
  _updateStack(fromInst.projectId, fromInst.threadSlug, (stack) => {
    const idx = stack.frames.findIndex((f) => f.instanceId === fromInst.id);
    if (idx >= 0) {
      stack.frames.splice(idx);
    } else {
      TCS.pop(stack);
    }
    if (TCS.isEmpty(stack)) {
      // 整栈被弹空 → outcome=aborted
      try {
        db.prepare(`UPDATE threads SET outcome = 'aborted', updated_at = ? WHERE project_id = ? AND slug = ?`)
          .run(Date.now(), fromInst.projectId, fromInst.threadSlug);
      } catch {}
    }
  });

  // chain append
  try {
    const updated = ThreadStore.appendDispatchChain(fromInst.projectId, fromInst.threadSlug, {
      kind: 'reject',
      fromRole: fromInst.role.name,
      fromInstanceId: fromInst.id,
      reason: (reason || '').slice(0, 200),
      bounceTo: bounceTo || null,
    });
    bus.publish('dispatch.chain_updated', {
      projectId: fromInst.projectId,
      threadSlug: fromInst.threadSlug,
      chain: updated?.metadata?.dispatch_chain || [],
    });
  } catch (e) {
    console.warn(`[MarkerDispatcher] reject chain append failed: ${e.message}`);
  }

  recordEvent('dispatch.rejected', {
    fromInstanceId: fromInst.id,
    fromRoleType: fromInst.role?.type,
    fromDisplayName: fromInst.displayName,
    reason,
    bounceTo,
  }, { projectId: fromInst.projectId, threadSlug: fromInst.threadSlug });

  // [需求@2026-06-19] 派工文件追加 Reject section
  try {
    const project = stmts.getProject.get(fromInst.projectId);
    if (project) {
      DispatchLogWriter.onReject({
        projectId: fromInst.projectId,
        projectRootDir: project.root_dir,
        threadSlug: fromInst.threadSlug,
        fromInst, reason,
      });
    }
  } catch (e) {
    console.warn(`[MarkerDispatcher] dispatch log onReject failed: ${e.message}`);
  }

  bus.publish('dispatch.rejected', {
    pendingSendId: fromInst._currentPendingSend?.id || null,
    projectId: fromInst.projectId,
    threadSlug: fromInst.threadSlug,
    fromInstanceId: fromInst.id,
    fromRoleType: fromInst.role?.type,
    fromDisplayName: fromInst.displayName,
    reason,
    bounceTo,
    ts: Date.now(),
  });

  // [Phase 2I] bounce_to 真路由 — 如果 H reject + bounce_to="mate-R",
  //   把 "rejection notice" 送给 R 让 R 跟 user 讨论 re-plan
  if (bounceTo && sendToThread) {
    try {
      const bounceRole = bounceTo.replace(/^mate-/, '').toLowerCase();
      const roleTypeMap = { r: 'requirements', h: 'orchestrator', b: 'executor', c: 'validator' };
      const targetRoleType = roleTypeMap[bounceRole.charAt(0)] || 'requirements';
      const project = require('../db').stmts.getProject.get(fromInst.projectId);
      if (project) {
        sendToThread({
          projectId: fromInst.projectId,
          projectRootDir: project.root_dir,
          threadSlug: fromInst.threadSlug,
          text: `[<rejection from ${fromInst.displayName}>] Reason: ${reason || '(unspecified)'}\n\nH rejected the previous task chain. You're being asked to re-plan or escalate to user. Discuss with the user what to do next, then issue a fresh handoff if needed.`,
          roleType: targetRoleType,
          fromMarker: true,
          markerFromInst: fromInst,
          markerSpec: bounceTo,
          markerReason: `bounce-back-from-reject`,
        });
      }
    } catch (e) {
      console.warn(`[MarkerDispatcher] reject bounce_to ${bounceTo} routing failed:`, e.message);
    }
  }
}

module.exports = { handleMarkers, parseMarkerTarget };
