// Manages the pool of RoleInstances. Phase 1: minimal — explicit spawn / kill,
// no pool reuse, no session-TTL recycler (those land in Phase 2C).
// However, the seams are here so Phase 2 just adds policy on top.
//
// [需求@2026-06-10] 重启数据不丢 — restoreFromDisk() 在 boot 时从 SQLite 重水化
//   非 dead 实例为 disconnected 状态,user 视角"对话还在,随时可继续"。
//
// [需求@2026-06-10] Phase 2A 改 per-project 池(user Q3):
//   spawnInstance / listInstances / acquire 都按 (projectId, roleName) 二元组绑定;
//   全局 cap 在 config.globalMaxClaudeProcesses 控制(Phase 2D 实施)。

const { RoleInstance } = require('./RoleInstance');
const roleCatalog = require('../roles/RoleCatalog');
const bus = require('../messageBus');
const { db, recordMessage, recordEvent, stmts } = require('../db');
const ThreadStore = require('../threads/ThreadStore');
const ThreadHooks = require('../system-agent/ThreadHooks');
const MarkerDetector = require('../system-agent/MarkerDetector');

class SpawnManager {
  constructor() {
    this.instances = new Map(); // instance.id -> RoleInstance
  }

  // [需求@2026-06-10] lazy resurrection: on boot, restore non-dead instances
  // from SQLite as `disconnected` RoleInstance objects.
  // [需求@2026-06-12 §8.3] 同时 backfill pool_slot for legacy 实例
  restoreFromDisk() {
    const rows = db.prepare(`
      SELECT id, project_id, role_name, claude_session_id, status, bound_thread_slug,
             created_at, last_active_at, pool_slot
      FROM role_instances
      WHERE status != 'dead'
    `).all();

    let restored = 0, skipped = 0;
    for (const r of rows) {
      const role = roleCatalog.get(r.role_name);
      if (!role) {
        console.warn(`[SpawnManager] restore skipped ${r.id}: unknown role ${r.role_name}`);
        skipped++;
        continue;
      }
      if (!r.claude_session_id) {
        stmts.setInstanceDied.run(Date.now(), r.id);
        skipped++;
        continue;
      }
      // [需求@2026-06-10] 恢复时拿到 project_id,从 projects 表查 root_dir
      const proj = db.prepare(`SELECT id, root_dir FROM projects WHERE id = ?`).get(r.project_id);
      if (!proj) {
        console.warn(`[SpawnManager] restore skipped ${r.id}: project ${r.project_id} not found`);
        stmts.setInstanceDied.run(Date.now(), r.id);
        skipped++;
        continue;
      }
      const inst = new RoleInstance({
        role,
        restoreState: {
          id: r.id,
          projectId: r.project_id,
          projectRootDir: proj.root_dir,
          sessionId: r.claude_session_id,
          threadSlug: r.bound_thread_slug,
          poolSlot: r.pool_slot,
          createdAt: r.created_at,
          lastActiveAt: r.last_active_at,
        },
      });
      this._wireListeners(inst);
      this.instances.set(inst.id, inst);
      try {
        stmts.setInstanceStatus.run('disconnected', Date.now(), inst.id);
      } catch {}
      restored++;
    }

    // [需求@2026-06-12 §8.3] backfill pool_slot for legacy non-R 实例
    const backfilled = this._backfillPoolSlots();
    console.log(`[SpawnManager] restored ${restored} disconnected, skipped ${skipped}, backfilled ${backfilled} pool slots`);
    return { restored, skipped, backfilled };
  }

  // [需求@2026-06-12 §8.3] legacy 实例无 pool_slot 时按 createdAt 顺序分配 1..N。
  //   只动 pooled 角色(非 requirements)。超过 pool 上限的 excess 实例标 dead。
  _backfillPoolSlots() {
    const groups = new Map(); // `${projectId}|${roleName}` → [insts sorted createdAt]
    for (const inst of this.instances.values()) {
      if (inst.role.type === 'requirements') continue;  // R 不池化
      if (inst.poolSlot != null) continue;  // 已有 slot
      const key = `${inst.projectId}|${inst.role.name}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(inst);
    }

    let backfilled = 0;
    for (const [key, insts] of groups) {
      insts.sort((a, b) => a.createdAt - b.createdAt);
      const [projectIdStr, roleName] = key.split('|');
      const projectId = parseInt(projectIdStr, 10);
      const role = roleCatalog.get(roleName);
      if (!role) continue;

      // Slots already used by other non-dead instances in this (project, role)
      const used = new Set();
      for (const i of this.instances.values()) {
        if (i.projectId === projectId && i.role.name === roleName && i.poolSlot != null && i.status !== 'dead') {
          used.add(i.poolSlot);
        }
      }

      for (const inst of insts) {
        let assigned = null;
        for (let s = 1; s <= role.parallelismLimit; s++) {
          if (!used.has(s)) { assigned = s; used.add(s); break; }
        }
        if (assigned != null) {
          inst.poolSlot = assigned;
          try {
            db.prepare(`UPDATE role_instances SET pool_slot = ? WHERE id = ?`).run(assigned, inst.id);
            backfilled++;
          } catch (e) {
            console.warn(`[SpawnManager] backfill pool_slot for ${inst.id} failed:`, e.message);
          }
        } else {
          // Pool 满了,这条 excess 实例标 dead(从 in-memory pool 也清掉)
          console.warn(`[SpawnManager] excess ${roleName} instance ${inst.id} — no free slot (pool ${role.parallelismLimit} full), marking dead`);
          inst._setStatus('dead');
          inst.diedAt = Date.now();
          try { stmts.setInstanceDied.run(Date.now(), inst.id); } catch {}
          this.instances.delete(inst.id);
        }
      }
    }
    return backfilled;
  }

  // [需求@2026-06-10] spawn per-project — parallelism limit is per (project, role) tuple.
  // [bug@2026-06-10] parallelism 只算"真正活着的"实例(spawning/idle/busy),
  //   不算 disconnected(它们没 child process,只是历史占位,激活时才占用槽位)。
  spawnInstance({ projectId, projectRootDir, roleName, threadSlug = null, customGreeting = null }) {
    if (!projectId) throw new Error('spawnInstance requires projectId');
    if (!projectRootDir) throw new Error('spawnInstance requires projectRootDir');
    const role = roleCatalog.get(roleName);
    if (!role) throw new Error(`Unknown role: ${roleName}`);

    const alive = this._countAliveInstances(projectId, roleName);
    if (alive >= role.parallelismLimit) {
      throw new Error(`Role ${roleName} in this project at parallelism limit (${role.parallelismLimit})`);
    }

    const inst = new RoleInstance({ role, projectId, projectRootDir, threadSlug, customGreeting });
    this.instances.set(inst.id, inst);

    this._wireListeners(inst);
    inst.spawn();
    this._persistInstanceUpsert(inst);
    bus.publish('instance.spawned', inst.snapshot());
    recordEvent('instance.spawn', inst.snapshot(), { projectId, instanceId: inst.id, threadSlug });
    return inst;
  }

  _wireListeners(inst) {
    inst.on('status_change', (chg) => {
      this._persistInstanceUpsert(inst);
      bus.publish('instance.status_change', { instance: inst.snapshot(), ...chg });
    });

    inst.on('event', ({ eventType, raw }) => {
      const direction =
        eventType === 'user' ? 'user_to_role' :
        eventType === 'assistant' ? 'role_to_user' :
        'system';

      // For high-frequency partial deltas, skip persistence (only final assistant + result)
      const skip = eventType === 'stream_event';
      if (!skip) {
        try {
          // [需求@2026-06-10] 每条 message 持久化必须带 projectId
          recordMessage({
            projectId: inst.projectId,
            threadSlug: inst.threadSlug,
            instanceId: inst.id,
            roleName: inst.role.name,
            direction,
            claudeSessionId: inst.sessionId,
            ts: Date.now(),
            eventType,
            payload: raw,
          });
        } catch (e) {
          console.warn(`[SpawnManager] recordMessage failed for ${inst.id}: ${e.message}`);
        }
      }

      // [需求@2026-06-12 §6.2 Gap 1] 在 thread.metadata 暂存 _current_role_type
      //   让 ThreadHooks 知道是哪个角色 type 在说话(用于 last_questioner_role_type)
      if (inst.threadSlug && eventType === 'assistant') {
        try {
          const cur = ThreadStore.get(inst.projectId, inst.threadSlug);
          if (cur) {
            const meta = { ...cur.metadata, _current_role_type: inst.role.type };
            db.prepare(`UPDATE threads SET metadata_json = ? WHERE project_id = ? AND slug = ?`)
              .run(JSON.stringify(meta), inst.projectId, inst.threadSlug);
          }
        } catch {}
      }

      bus.publish('instance.event', {
        instanceId: inst.id,
        projectId: inst.projectId,
        threadSlug: inst.threadSlug,
        roleName: inst.role.name,
        eventType,
        raw,
        ts: Date.now(),
      });

      // [需求@2026-06-10 §1.4, §1.6] result 事件 = 一轮结束,触发 ThreadHooks
      //   异步 fire-and-forget,不阻塞 event 派发
      // [bug@2026-06-10] streamParser 把 result/success 拼成 eventType='result/success'(含 subtype),
      //   不是 'result'。判断要 startsWith,不是 ===。
      if (eventType.startsWith('result') && inst.threadSlug && raw.is_error !== true) {
        setImmediate(() => {
          ThreadHooks.onResultEvent({
            projectId: inst.projectId,
            threadSlug: inst.threadSlug,
            instanceId: inst.id,
          }).catch((e) => console.warn(`[SpawnManager] ThreadHooks error:`, e.message));
        });

        // [需求@2026-06-10 §6.1-6.4] 自动状态机:detect mate markers,自动 handoff 下一角色
        const assistantText = raw.result || '';
        const markers = MarkerDetector.detect(assistantText);
        if (markers.length) {
          setImmediate(() => this._handleMarkers(inst, markers));
        }
      }
    });

    inst.on('stderr', (s) => {
      bus.publish('instance.stderr', { instanceId: inst.id, text: s });
    });

    inst.on('exited', ({ code, signal, error }) => {
      try { stmts.setInstanceDied.run(Date.now(), inst.id); } catch {}
      bus.publish('instance.exited', {
        instance: inst.snapshot(), code, signal, error: error || null,
      });
      recordEvent('instance.die', { code, signal, error: error || null }, { instanceId: inst.id });
    });
  }

  _persistInstanceUpsert(inst) {
    try {
      stmts.upsertInstance.run({
        id: inst.id,
        project_id: inst.projectId,
        role_name: inst.role.name,
        pid: inst.pid,
        claude_session_id: inst.sessionId,
        status: inst.status,
        bound_thread_slug: inst.threadSlug,
        spawn_args_json: JSON.stringify(inst._spawnArgs || []),
        created_at: inst.createdAt,
        last_active_at: inst.lastActiveAt,
        pool_slot: inst.poolSlot,
      });
    } catch (e) {
      console.warn(`[SpawnManager] upsertInstance failed for ${inst.id}: ${e.message}`);
    }
  }

  async killInstance(id) {
    const inst = this.instances.get(id);
    if (!inst) throw new Error(`Unknown instance: ${id}`);
    const level = await inst.kill();
    return { id, level };
  }

  getInstance(id) {
    return this.instances.get(id) || null;
  }

  // [需求@2026-06-10] listInstances 按 project 过滤;不传 projectId 返回全部(供监控视图用)
  // [需求@2026-06-11 §2] 加 includeDead 选项 — 终端管理 modal 想看 dead 实例
  listInstances(projectId = null, { includeDead = false } = {}) {
    let all = [...this.instances.values()];
    if (!includeDead) all = all.filter((i) => i.status !== 'dead');
    const scoped = projectId ? all.filter((i) => i.projectId === projectId) : all;
    return scoped.map((i) => i.snapshot());
  }

  // [bug@2026-06-10] parallelism 计算 helper:只算 spawning/idle/busy,不算 disconnected/dead
  _countAliveInstances(projectId, roleName) {
    const ALIVE = new Set(['spawning', 'idle', 'busy', 'awaiting_verify', 'blocked']);
    return [...this.instances.values()].filter(
      (i) => i.projectId === projectId && i.role.name === roleName && ALIVE.has(i.status)
    ).length;
  }

  // [需求@2026-06-10 §6] 自动状态机:处理 R/H/B/C 输出的 mate marker
  //   - handoff target=<role>: 切换到下一角色 + 推进 stage + 自动 spawn
  //   - done: 标记线索 verified(H 自验通过 = 流程到头 = IDLE,user 体验回归)
  //   - blocked: 标记线索为 blocked 状态,前端黄灯闪烁
  //   marker 由 SpawnManager._wireListeners 在 result event 时通过 MarkerDetector 提取
  // [需求@2026-06-12 §6.1 + 8.3] Marker 优先级:done > blocked > handoff
  //   首个出现的高优先级 marker 处理完后,**静默忽略**剩余 marker(避免 done 翻 verified 后还派下一个角色,产生孤儿实例)。
  async _handleMarkers(inst, markers) {
    if (!inst.threadSlug) return;
    const done = markers.find((m) => m.kind === 'done');
    if (done) {
      try { this._performDone(inst, done.summary); }
      catch (e) { console.warn(`[SpawnManager] done marker failed (${inst.id}):`, e.message); }
      if (markers.length > 1) {
        console.warn(`[SpawnManager] ignoring ${markers.length - 1} subsequent marker(s) after <mate:done /> from ${inst.id}`);
      }
      return;
    }
    const blocked = markers.find((m) => m.kind === 'blocked');
    if (blocked) {
      try { this._performBlocked(inst, blocked.question, blocked.severity); }
      catch (e) { console.warn(`[SpawnManager] blocked marker failed (${inst.id}):`, e.message); }
      const others = markers.filter((m) => m.kind !== 'blocked');
      if (others.length) {
        console.warn(`[SpawnManager] ignoring ${others.length} non-blocked marker(s) alongside <mate:blocked /> from ${inst.id}`);
      }
      return;
    }
    const handoff = markers.find((m) => m.kind === 'handoff');
    if (handoff) {
      try { await this._performHandoff(inst, handoff.target, handoff.reason); }
      catch (e) { console.warn(`[SpawnManager] handoff marker failed (${inst.id}):`, e.message); }
    }
  }

  // [需求@2026-06-12 §6 + 8.3] target 可以是 "execB"(泛型)或 "execB-2"(具体 slot)
  async _performHandoff(fromInst, targetSpec, reason) {
    const { roleName: targetRoleName, poolSlot: targetSlot } = this._parseMarkerTarget(targetSpec);
    const targetRole = roleCatalog.get(targetRoleName);
    if (!targetRole) {
      console.warn(`[SpawnManager] handoff target "${targetSpec}" → role "${targetRoleName}" not found in catalog`);
      return;
    }
    const project = stmts.getProject.get(fromInst.projectId);
    if (!project) return;

    // Stage progression (data-driven from target role type)
    const stageByTargetType = {
      orchestrator: 'designing',
      executor: 'executing',
      validator: 'testing',
      requirements: 'discussing',
    };
    const nextStage = stageByTargetType[targetRole.type] || null;
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

    // Spawn or reuse target role for this thread
    const inst = this.sendToThread({
      projectId: fromInst.projectId,
      projectRootDir: project.root_dir,
      threadSlug: fromInst.threadSlug,
      text: handoffText,
      roleType: targetRole.type,
      targetSlot,
    });

    recordEvent('thread.handoff', {
      from: fromInst.role.name, target: targetSpec, resolvedRole: targetRoleName,
      resolvedSlot: targetSlot, reason,
      fromInstanceId: fromInst.id, toInstanceId: inst.id,
    }, { projectId: fromInst.projectId, threadSlug: fromInst.threadSlug });
    bus.publish('thread.handoff', {
      projectId: fromInst.projectId,
      threadSlug: fromInst.threadSlug,
      from: fromInst.role.name,
      target: targetSpec,
      reason,
    });
  }

  _performDone(fromInst, summary) {
    try {
      ThreadStore.setStage(fromInst.projectId, fromInst.threadSlug, 'verified');
    } catch (e) {
      console.warn(`[SpawnManager] setStage verified failed:`, e.message);
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

  _performBlocked(fromInst, question, severity) {
    // Mark thread metadata with blocked info (the UI uses this for the yellow blink light)
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
      console.warn(`[SpawnManager] blocked metadata persist failed:`, e.message);
      return;
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

  // [需求@2026-06-10] Phase 2B 线索为主视图:sendToThread 是 user 跟系统的主入口。
  // [需求@2026-06-12 §8.3] Phase 2D 拆 2 条路径:
  //   - role.type === 'requirements'(R):per-thread,durable 1:1 绑定(原逻辑)
  //   - 其它(orchestrator/executor/validator/advisor):pooled,slot 化复用
  //
  //   targetSlot:可选,marker `target="execB-2"` 解析后传进来。
  sendToThread({ projectId, projectRootDir, threadSlug, text, roleType = 'requirements', targetSlot = null }) {
    if (!projectId) throw new Error('sendToThread requires projectId');
    if (!projectRootDir) throw new Error('sendToThread requires projectRootDir');
    if (!threadSlug) throw new Error('sendToThread requires threadSlug');
    if (!text) throw new Error('sendToThread requires text');

    const thread = ThreadStore.get(projectId, threadSlug);
    if (!thread) throw new Error(`thread "${threadSlug}" not found in project ${projectId}`);

    const role = roleCatalog.list().find((r) => r.type === roleType);
    if (!role) throw new Error(`no role found of type ${roleType}`);

    if (role.type === 'requirements') {
      return this._sendToPerThreadRole({ projectId, projectRootDir, threadSlug, text, role, roleType });
    }
    return this._sendToPooledRole({ projectId, projectRootDir, threadSlug, text, role, roleType, targetSlot });
  }

  // R 走原 per-thread 路径
  _sendToPerThreadRole({ projectId, projectRootDir, threadSlug, text, role, roleType }) {
    const thread = ThreadStore.get(projectId, threadSlug);
    const boundId = thread.metadata?.current_role_instances?.[roleType];
    let inst = boundId ? this.instances.get(boundId) : null;

    if (!inst || inst.status === 'dead') {
      const alive = this._countAliveInstances(projectId, role.name);
      if (alive >= role.parallelismLimit) {
        throw new Error(`role ${role.name} in this project at parallelism limit (${role.parallelismLimit})`);
      }
      inst = new RoleInstance({ role, projectId, projectRootDir, threadSlug, poolSlot: null });
      inst._pendingUserText = text;
      this.instances.set(inst.id, inst);
      this._wireListeners(inst);
      inst.spawn({ suppressGreeting: true });
      this._persistInstanceUpsert(inst);
      ThreadStore.bindInstance(projectId, threadSlug, roleType, inst.id);
      bus.publish('instance.spawned', inst.snapshot());
      recordEvent('thread.bind', { threadSlug, roleType, instanceId: inst.id },
                  { projectId, threadSlug, instanceId: inst.id });
      return inst;
    }

    if (inst.status === 'disconnected') {
      inst.threadSlug = threadSlug;
      inst.sendUserText(text);
      ThreadStore.touch(projectId, threadSlug, roleType);
      return inst;
    }

    inst.sendUserText(text);
    ThreadStore.touch(projectId, threadSlug, roleType);
    this._clearPendingQuestion(projectId, threadSlug);
    return inst;
  }

  // [需求@2026-06-12 §8.3] Pooled 角色派工
  //   1. acquire 一个 instance(指定 slot 或任意 idle 或新分配)
  //   2. 设 inst.threadSlug = currentTask
  //   3. 加 [Thread: <slug>] task tag 前缀
  //   4. 派工(idle → sendUserText / disconnected → resurrect / 新 → spawn with pending)
  //   5. 绑定到 thread.metadata + touch
  _sendToPooledRole({ projectId, projectRootDir, threadSlug, text, role, roleType, targetSlot }) {
    const inst = this._acquirePoolInstance({ projectId, projectRootDir, role, requestedSlot: targetSlot, threadSlug });
    if (!inst) throw new Error(`could not acquire pool instance for ${role.name}`);

    // Bind current task — inst.threadSlug = current task being processed
    inst.threadSlug = threadSlug;

    // [需求@2026-06-12 §6 边界标记] task tag — 让 claude 知道当前 scope,但**不要它忘记过去**
    const taggedText = `[Thread: ${threadSlug}]\n\n${text}`;

    // Dispatch by status
    if (inst.status === 'idle' || inst.status === 'busy') {
      // Phase 2D §8.5 will add queueing for busy; for now just send (claude will process in order)
      inst.sendUserText(taggedText);
    } else if (inst.status === 'disconnected') {
      inst.sendUserText(taggedText); // lazy resurrect via Phase 1 mechanism
    } else if (inst.status === 'spawning') {
      // Was already mid-spawn — append to pending
      inst._pendingUserText = taggedText;
    } else {
      // Fresh, not yet spawned
      inst._pendingUserText = taggedText;
      inst.spawn({ suppressGreeting: true });
    }

    this._persistInstanceUpsert(inst);
    ThreadStore.bindInstance(projectId, threadSlug, roleType, inst.id);
    ThreadStore.touch(projectId, threadSlug, roleType);
    this._clearPendingQuestion(projectId, threadSlug);
    return inst;
  }

  // [需求@2026-06-12 §8.3] 池子 acquire 逻辑
  _acquirePoolInstance({ projectId, projectRootDir, role, requestedSlot, threadSlug }) {
    // 指定 slot
    if (requestedSlot != null) {
      if (requestedSlot < 1 || requestedSlot > role.parallelismLimit) {
        throw new Error(`slot ${requestedSlot} out of range 1..${role.parallelismLimit} for ${role.name}`);
      }
      const existing = this._findPoolInstance(projectId, role.name, requestedSlot);
      if (existing) return existing;
      return this._createPoolInstance({ projectId, projectRootDir, role, poolSlot: requestedSlot, threadSlug });
    }

    // 泛型:优先用现有 idle → disconnected(lazy resurrect) → 新分配 slot → 任意 busy(由 §8.5 queue)
    const idle = [...this.instances.values()].find(
      (i) => i.projectId === projectId && i.role.name === role.name && i.status === 'idle' && i.poolSlot != null
    );
    if (idle) return idle;

    const disconnected = [...this.instances.values()].find(
      (i) => i.projectId === projectId && i.role.name === role.name && i.status === 'disconnected' && i.poolSlot != null
    );
    if (disconnected) return disconnected;

    const freeSlot = this._findNextFreePoolSlot(projectId, role.name, role.parallelismLimit);
    if (freeSlot != null) {
      return this._createPoolInstance({ projectId, projectRootDir, role, poolSlot: freeSlot, threadSlug });
    }

    // Pool 满 — 返回任意 busy(caller / queue 后续处理)
    const anyBusy = [...this.instances.values()].find(
      (i) => i.projectId === projectId && i.role.name === role.name && i.status === 'busy'
    );
    return anyBusy || null;
  }

  _findPoolInstance(projectId, roleName, slot) {
    return [...this.instances.values()].find(
      (i) => i.projectId === projectId && i.role.name === roleName && i.poolSlot === slot && i.status !== 'dead'
    );
  }

  _findNextFreePoolSlot(projectId, roleName, maxSlot) {
    const used = new Set();
    for (const i of this.instances.values()) {
      if (i.projectId === projectId && i.role.name === roleName && i.poolSlot != null && i.status !== 'dead') {
        used.add(i.poolSlot);
      }
    }
    for (let s = 1; s <= maxSlot; s++) if (!used.has(s)) return s;
    return null;
  }

  _createPoolInstance({ projectId, projectRootDir, role, poolSlot, threadSlug }) {
    const inst = new RoleInstance({
      role, projectId, projectRootDir, threadSlug, poolSlot,
    });
    this.instances.set(inst.id, inst);
    this._wireListeners(inst);
    this._persistInstanceUpsert(inst);
    bus.publish('instance.spawned', inst.snapshot());
    recordEvent('pool.allocated', { roleName: role.name, poolSlot, instanceId: inst.id },
                { projectId, threadSlug, instanceId: inst.id });
    return inst;
  }

  // [需求@2026-06-12 §6 + 8.3] Parse marker target:
  //   "execB" → { roleName: 'execB', poolSlot: null }
  //   "execB-2" → { roleName: 'execB', poolSlot: 2 }
  _parseMarkerTarget(target) {
    const m = String(target).match(/^([a-zA-Z][a-zA-Z0-9_-]*?)-(\d+)$/);
    if (m && roleCatalog.get(m[1])) {
      return { roleName: m[1], poolSlot: parseInt(m[2], 10) };
    }
    return { roleName: target, poolSlot: null };
  }

  // [需求@2026-06-11 §4] 清除 thread.metadata.has_pending_question(user 已回答 → 黄灯熄)
  _clearPendingQuestion(projectId, threadSlug) {
    try {
      const thread = ThreadStore.get(projectId, threadSlug);
      if (!thread || !thread.metadata?.has_pending_question) return;
      const meta = { ...thread.metadata };
      delete meta.has_pending_question;
      delete meta.pending_questions;
      delete meta.pending_questions_at;
      db.prepare(`UPDATE threads SET metadata_json = ?, updated_at = ? WHERE project_id = ? AND slug = ?`)
        .run(JSON.stringify(meta), Date.now(), projectId, threadSlug);
      bus.publish('thread.metadata_updated', {
        projectId, threadSlug, thread: ThreadStore.get(projectId, threadSlug),
      });
    } catch (e) {
      console.warn(`[SpawnManager] _clearPendingQuestion failed: ${e.message}`);
    }
  }

  async shutdown() {
    const live = [...this.instances.values()].filter((i) => i.status !== 'dead');
    console.log(`[SpawnManager] shutting down ${live.length} live instances`);
    await Promise.all(live.map((i) => i.kill().catch((e) => console.warn('kill err:', e))));
  }
}

module.exports = new SpawnManager();
