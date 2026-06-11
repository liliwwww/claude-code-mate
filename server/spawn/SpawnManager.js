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
  restoreFromDisk() {
    const rows = db.prepare(`
      SELECT id, project_id, role_name, claude_session_id, status, bound_thread_slug,
             created_at, last_active_at
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
    console.log(`[SpawnManager] restored ${restored} disconnected instance(s), skipped ${skipped}`);
    return { restored, skipped };
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
  async _handleMarkers(inst, markers) {
    if (!inst.threadSlug) return;
    for (const m of markers) {
      try {
        if (m.kind === 'handoff') {
          await this._performHandoff(inst, m.target, m.reason);
        } else if (m.kind === 'done') {
          this._performDone(inst, m.summary);
        } else if (m.kind === 'blocked') {
          this._performBlocked(inst, m.question, m.severity);
        }
      } catch (e) {
        console.warn(`[SpawnManager] marker ${m.kind} failed (${inst.id}):`, e.message);
      }
    }
  }

  async _performHandoff(fromInst, targetRoleName, reason) {
    const targetRole = roleCatalog.get(targetRoleName);
    if (!targetRole) {
      console.warn(`[SpawnManager] handoff target "${targetRoleName}" not found in catalog`);
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
    });

    recordEvent('thread.handoff', {
      from: fromInst.role.name, target: targetRoleName, reason,
      fromInstanceId: fromInst.id, toInstanceId: inst.id,
    }, { projectId: fromInst.projectId, threadSlug: fromInst.threadSlug });
    bus.publish('thread.handoff', {
      projectId: fromInst.projectId,
      threadSlug: fromInst.threadSlug,
      from: fromInst.role.name,
      target: targetRoleName,
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

  // [需求@2026-06-10] Phase 2B 线索为主视图:
  //   sendToThread 是 user 跟系统打交道的主入口。它做 3 件事:
  //   1) 找到线索当前绑定的角色实例(默认 requirements / R 类型)
  //   2) 如果没绑定或绑定已死,**懒 spawn** 一个新实例,把 user 消息作为首条 stdin(无 greeting 浪费)
  //   3) 否则直接 sendUserText
  //
  // roleType 默认 'requirements'(R);Phase 2C+ 智能路由会决定真实 target。
  sendToThread({ projectId, projectRootDir, threadSlug, text, roleType = 'requirements' }) {
    if (!projectId) throw new Error('sendToThread requires projectId');
    if (!projectRootDir) throw new Error('sendToThread requires projectRootDir');
    if (!threadSlug) throw new Error('sendToThread requires threadSlug');
    if (!text) throw new Error('sendToThread requires text');

    const thread = ThreadStore.get(projectId, threadSlug);
    if (!thread) throw new Error(`thread "${threadSlug}" not found in project ${projectId}`);

    // Find role definition for this type (roleCatalog.list() returns an Array of RoleDefinition)
    const role = roleCatalog.list().find((r) => r.type === roleType);
    if (!role) throw new Error(`no role found of type ${roleType}`);

    // Look up bound instance
    const boundId = thread.metadata?.current_role_instances?.[roleType];
    let inst = boundId ? this.instances.get(boundId) : null;

    // [需求@2026-06-10] 懒 spawn — 没绑定或已死 = 起新的;用 user 文本作首条 stdin
    if (!inst || inst.status === 'dead') {
      // [bug@2026-06-10] parallelism 只算活实例,disconnected 不算
      const alive = this._countAliveInstances(projectId, role.name);
      if (alive >= role.parallelismLimit) {
        throw new Error(`role ${role.name} in this project at parallelism limit (${role.parallelismLimit})`);
      }
      inst = new RoleInstance({
        role,
        projectId,
        projectRootDir,
        threadSlug,
      });
      // Stash the user text as pending — spawn() will flush it as first stdin (probe 02)
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

    // Disconnected → sendUserText triggers lazy resurrection (Phase 1 mechanism)
    if (inst.status === 'disconnected') {
      inst.threadSlug = threadSlug; // ensure binding sticks
      inst.sendUserText(text);
      ThreadStore.touch(projectId, threadSlug, roleType);
      return inst;
    }

    // Alive — just send
    inst.sendUserText(text);
    ThreadStore.touch(projectId, threadSlug, roleType);
    // [需求@2026-06-11 §4] user 一发新消息就清除黄灯(她回答了 pending question)
    this._clearPendingQuestion(projectId, threadSlug);
    return inst;
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
