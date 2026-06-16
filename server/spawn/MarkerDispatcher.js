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

const STAGE_BY_TARGET_TYPE = {
  orchestrator: 'designing',
  executor: 'executing',
  validator: 'testing',
  requirements: 'discussing',
};

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
    try { _performReject(fromInst, reject.reason, reject.bounceTo); }
    catch (e) { console.warn(`[MarkerDispatcher] reject marker failed (${fromInst.id}):`, e.message); }
    return;
  }
  const done = markers.find((m) => m.kind === 'done');
  if (done) {
    try { _performDone(fromInst, done.summary); }
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
  const handoff = markers.find((m) => m.kind === 'handoff');
  if (handoff) {
    try {
      await _performHandoff(fromInst, handoff.target, handoff.reason, { sendToThread });
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
async function _performHandoff(fromInst, targetSpec, reason, { sendToThread }) {
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

function _performDone(fromInst, summary) {
  try {
    ThreadStore.setStage(fromInst.projectId, fromInst.threadSlug, 'verified');
  } catch (e) {
    console.warn(`[MarkerDispatcher] setStage verified failed:`, e.message);
  }
  // [Phase 2G M1.2] append done segment to chain
  try {
    const updated = ThreadStore.appendDispatchChain(fromInst.projectId, fromInst.threadSlug, {
      kind: 'done',
      fromRole: fromInst.role.name,
      fromInstanceId: fromInst.id,
      summary: summary || '',
    });
    bus.publish('dispatch.chain_updated', {
      projectId: fromInst.projectId,
      threadSlug: fromInst.threadSlug,
      chain: updated?.metadata?.dispatch_chain || [],
    });
  } catch (e) {
    console.warn(`[MarkerDispatcher] dispatch_chain done append failed: ${e.message}`);
  }
  recordEvent('thread.done', { summary, fromInstanceId: fromInst.id },
    { projectId: fromInst.projectId, threadSlug: fromInst.threadSlug });
  bus.publish('thread.done', {
    projectId: fromInst.projectId,
    threadSlug: fromInst.threadSlug,
    summary,
    thread: ThreadStore.get(fromInst.projectId, fromInst.threadSlug),
  });
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
  try {
    db.prepare(`UPDATE threads SET metadata_json = ?, updated_at = ? WHERE project_id = ? AND slug = ?`)
      .run(JSON.stringify(meta), Date.now(), fromInst.projectId, fromInst.threadSlug);
  } catch (e) {
    console.warn(`[MarkerDispatcher] blocked metadata persist failed:`, e.message);
    return;
  }
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
function _performReject(fromInst, reason, bounceTo) {
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
}

module.exports = { handleMarkers, parseMarkerTarget };
