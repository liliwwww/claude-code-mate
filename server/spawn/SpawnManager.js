// ============================================================================
// MODULE CONTRACT(架构 SSOT:docs/architecture.md §3 §4 §6)
// ----------------------------------------------------------------------------
// 层:L2 Process Control
// 责任(单一职责?— **目前 9 个,见 arch-debt §1,god class 待拆**):
//   1. 实例池管理(per-(project, role) 双组,acquire / release / restoreFromDisk)
//   2. RoleInstance lifecycle wiring(event 桥接 + 持久化 + bus.publish)
//   3. marker dispatch(MarkerDetector → _performHandoff/Done/Blocked)
//   4. handoff 进度状态机(_pendingHandoffReady Map → spawning/ready/failed)
//   5. clientMessageId FIFO(乐观 UI dedup)
//   6. TTL scanner(ttl_soon/expired + stuck busy unstick + disconnected 老化)
//   7. global cap warn(_checkGlobalCap,新口径只算 idle/busy/spawning)
//   8. QuotaState wire(rate_limit_event 透传)
//   9. pending sends queue(预留,本轮未启用)
// 公共 API:单例 + spawnInstance / sendToThread / sendDirectToInstance /
//   killInstance / restoreFromDisk / startTtlScanner / stopTtlScanner / shutdown /
//   getInstance / listInstances
// 允许依赖(自下而上):config / db / messageBus / RoleInstance / streamParser /
//   roleCatalog / ThreadStore / ThreadHooks / MarkerDetector / QuotaState
//   注:ThreadHooks 当前挂 L3 system-agent,见 arch-debt §5(MarkerDetector
//   2026-06-13 已迁入 L2 spawn/,arch-debt §4 ✅)
// 禁止:
//   - 替 LLM 决策(选哪个 instance、handoff target 写啥)
//   - 写任何 file-based handoff(WORK_HANDOFF / doc/queue / doc/_dispatch)
//   - hardcode 角色名(stageByTargetType 那种 type 映射例外,因为 type 是契约)
//   - 改 stream-json raw event 字段(只读)
// ============================================================================
//
// Phase 1: minimal — explicit spawn / kill, no pool reuse, no session-TTL recycler
//   (those land in Phase 2C).
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
const config = require('../config');
const { db, recordMessage, recordEvent, stmts } = require('../db');
const ThreadStore = require('../threads/ThreadStore');
const ThreadHooks = require('../system-agent/ThreadHooks');
const MarkerDetector = require('./MarkerDetector');
const QuotaState = require('../quota/QuotaState');
const EventStore = require('../events/EventStore');
const ScanRecycler = require('./ScanRecycler');
const PoolAllocator = require('./PoolAllocator');
const HandoffTracker = require('./HandoffTracker');
const MarkerDispatcher = require('./MarkerDispatcher');

class SpawnManager {
  constructor() {
    this.instances = new Map(); // instance.id -> RoleInstance
    // [arch §1.3 ✅] handoff 进度跟踪移到 HandoffTracker 模块
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
      // [需求@2026-06-12 Phase 2E §5] 从 messages 表抓最近一次 system/init 的 model
      try {
        const lastInit = db.prepare(`
          SELECT payload_json FROM messages
          WHERE instance_id = ? AND event_type = 'system/init'
          ORDER BY ts DESC LIMIT 1
        `).get(r.id);
        if (lastInit) {
          const p = JSON.parse(lastInit.payload_json);
          inst.currentModel = p.model || null;
          inst.claudeCodeVersion = p.claude_code_version || null;
        }
      } catch {}
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

  // [arch §1.2 ✅] 已抽到 PoolAllocator.backfillFromDisk
  _backfillPoolSlots() {
    return PoolAllocator.backfillFromDisk({
      instances: this.instances, roleCatalog, stmts, db,
    });
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
    this._checkGlobalCap();  // [需求@2026-06-12 §8.10] soft cap warn

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
      // [arch §1.3 ✅] 派工 ready/spawning/failed 检测移到 HandoffTracker
      HandoffTracker.observeStatusChange(inst.id, chg.to);
    });

    inst.on('event', ({ eventType, raw }) => {
      // [需求@2026-06-12 Phase 2E §6 §7] rate_limit_event → QuotaState
      //   claude 在每条 user 消息处理时会推送 5h + 7d 双轨,QuotaState 维护全局状态
      if (eventType === 'rate_limit_event') {
        try { QuotaState.ingest(raw); } catch (e) { console.warn(`[SpawnManager] QuotaState.ingest failed: ${e.message}`); }
      }

      const direction =
        eventType === 'user' ? 'user_to_role' :
        eventType === 'assistant' ? 'role_to_user' :
        'system';

      // For high-frequency partial deltas, skip persistence (only final assistant + result)
      const skip = eventType === 'stream_event';
      // [需求@2026-06-12 §9] mateTerm 直连模式:消息挂 instance,不挂 thread。
      //   `inst._directMode` 在 sendDirectToInstance 时置 true,result 事件后清除。
      const isDirect = !!inst._directMode;
      // [需求@2026-06-12 Phase 2E §12] user-direction event 拿出 FIFO 队首的 clientMessageId
      let attachClientId = null;
      if (eventType === 'user' && inst._pendingClientIds?.length) {
        attachClientId = inst._pendingClientIds.shift();
      }
      let serverMessageId = null;
      if (!skip) {
        try {
          serverMessageId = recordMessage({
            projectId: inst.projectId,
            // 直连时 thread_slug = NULL(避免污染 thread 历史)
            threadSlug: isDirect ? null : inst.threadSlug,
            instanceId: inst.id,
            roleName: inst.role.name,
            direction,
            claudeSessionId: inst.sessionId,
            ts: Date.now(),
            eventType,
            payload: raw,
            directTarget: isDirect ? inst.id : null,
          });
        } catch (e) {
          console.warn(`[SpawnManager] recordMessage failed for ${inst.id}: ${e.message}`);
        }
      }

      // [需求@2026-06-12 §6.2 Gap 1] 在 thread.metadata 暂存 _current_role_type
      //   让 ThreadHooks 知道是哪个角色 type 在说话(用于 last_questioner_role_type)
      // 直连模式不写 thread metadata(没有 thread 可写)
      if (!isDirect && inst.threadSlug && eventType === 'assistant') {
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
        // 直连模式:threadSlug 标 null,前端按 instanceId 分流
        threadSlug: isDirect ? null : inst.threadSlug,
        roleName: inst.role.name,
        eventType,
        raw,
        ts: Date.now(),
        // [需求@2026-06-12 §9] mateTerm 直连事件标志
        directTarget: isDirect ? inst.id : null,
        // [需求@2026-06-12 Phase 2E §12] 乐观 UI dedup keys
        clientMessageId: attachClientId,
        serverMessageId,
      });

      // [需求@2026-06-10 §1.4, §1.6] result 事件 = 一轮结束,触发 ThreadHooks
      //   异步 fire-and-forget,不阻塞 event 派发
      // [bug@2026-06-10] streamParser 把 result/success 拼成 eventType='result/success'(含 subtype),
      //   不是 'result'。判断要 startsWith,不是 ===。
      // [需求@2026-06-12 §9] 直连模式:不跑 ThreadHooks,不跑 _handleMarkers — 因为没 thread 可挂。
      //   marker 由前端在 assistant 文本里识别后**灰色提示**显示,不触发 side effect。
      if (eventType.startsWith('result') && raw.is_error !== true) {
        if (!isDirect && inst.threadSlug) {
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
        // result 后清除直连标志(若有);下一轮 user 再发才会再置位
        if (isDirect) inst._directMode = false;
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

  // [arch §1.4 ✅] marker 处理移到 MarkerDispatcher。
  //   SpawnManager 只注入 sendToThread callback,实现都在 MarkerDispatcher。
  async _handleMarkers(inst, markers) {
    return MarkerDispatcher.handleMarkers(inst, markers, {
      sendToThread: (args) => this.sendToThread(args),
    });
  }

  // [需求@2026-06-10] Phase 2B 线索为主视图:sendToThread 是 user 跟系统的主入口。
  // [需求@2026-06-12 §8.3] Phase 2D 拆 2 条路径:
  //   - role.type === 'requirements'(R):per-thread,durable 1:1 绑定(原逻辑)
  //   - 其它(orchestrator/executor/validator/advisor):pooled,slot 化复用
  //
  //   targetSlot:可选,marker `target="execB-2"` 解析后传进来。
  //   targetInstance:可选(§9 mateTerm 干预模式),user 直接指定具体 instance.id 时由 caller 注入;
  //     从中推导 roleType + targetSlot,覆盖默认 last_questioner 路由。
  sendToThread({ projectId, projectRootDir, threadSlug, text, roleType = 'requirements', targetSlot = null, targetInstance = null, clientMessageId = null }) {
    if (!projectId) throw new Error('sendToThread requires projectId');
    if (!projectRootDir) throw new Error('sendToThread requires projectRootDir');
    if (!threadSlug) throw new Error('sendToThread requires threadSlug');
    if (!text) throw new Error('sendToThread requires text');

    const thread = ThreadStore.get(projectId, threadSlug);
    if (!thread) throw new Error(`thread "${threadSlug}" not found in project ${projectId}`);

    // [需求@2026-06-12 §9.2] mateTerm 干预模式:指定 instance 时覆盖 roleType + targetSlot
    if (targetInstance) {
      const tgt = this.instances.get(targetInstance);
      if (!tgt) throw new Error(`targetInstance ${targetInstance} not found`);
      if (tgt.projectId !== projectId) {
        throw new Error(`targetInstance ${targetInstance} belongs to a different project`);
      }
      roleType = tgt.role.type;
      if (tgt.poolSlot != null) targetSlot = tgt.poolSlot;
    }

    const role = roleCatalog.list().find((r) => r.type === roleType);
    if (!role) throw new Error(`no role found of type ${roleType}`);

    if (role.type === 'requirements') {
      return this._sendToPerThreadRole({ projectId, projectRootDir, threadSlug, text, role, roleType, clientMessageId });
    }
    return this._sendToPooledRole({ projectId, projectRootDir, threadSlug, text, role, roleType, targetSlot, clientMessageId });
  }

  // [需求@2026-06-12 §9 mateTerm] 直连模式 — user 直接对某个实例说话。
  //   - 不挂 thread(messages.direct_target = inst.id,thread_slug = NULL)
  //   - 不加 [Thread: xxx] task tag
  //   - 不触发 marker side effect(_handleMarkers / ThreadHooks 都跳过)
  //   - busy / spawning 实例拒绝(409 by caller)
  sendDirectToInstance(instanceId, text, { clientMessageId = null } = {}) {
    if (!instanceId) throw new Error('sendDirectToInstance requires instanceId');
    if (!text || typeof text !== 'string') throw new Error('sendDirectToInstance requires text');
    const inst = this.instances.get(instanceId);
    if (!inst) throw new Error(`instance ${instanceId} not found`);
    if (inst.status === 'dead') throw new Error(`instance ${instanceId} is dead`);
    if (inst.status === 'busy') throw new Error(`instance ${instanceId} is busy`);
    if (inst.status === 'spawning') throw new Error(`instance ${instanceId} is still spawning`);

    inst._directMode = true;  // event handler 看到这个就走直连持久化 + 跳 marker 派工
    // [需求@2026-06-12 Phase 2E §12] enqueue clientMessageId
    this._enqueueClientId(inst, clientMessageId);
    try {
      inst.sendUserText(text);
    } catch (e) {
      inst._directMode = false;
      throw e;
    }
    recordEvent('instance.direct_message', { text: text.slice(0, 200) },
                { projectId: inst.projectId, instanceId: inst.id });
    bus.publish('instance.direct_message', {
      instanceId: inst.id,
      projectId: inst.projectId,
      roleName: inst.role.name,
      text,
      ts: Date.now(),
    });
    return inst;
  }

  // R 走原 per-thread 路径
  _sendToPerThreadRole({ projectId, projectRootDir, threadSlug, text, role, roleType, clientMessageId = null }) {
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
      this._enqueueClientId(inst, clientMessageId);
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
      this._enqueueClientId(inst, clientMessageId);
      inst.sendUserText(text);
      ThreadStore.touch(projectId, threadSlug, roleType);
      return inst;
    }

    this._enqueueClientId(inst, clientMessageId);
    inst.sendUserText(text);
    ThreadStore.touch(projectId, threadSlug, roleType);
    this._clearPendingQuestion(projectId, threadSlug);
    return inst;
  }

  // [需求@2026-06-12 Phase 2E §12] FIFO 队列存等待匹配的 clientMessageId
  //   每次 sendUserText 前 enqueue,inst.on('event') 看到 eventType='user' 时 dequeue,
  //   把 clientMessageId attach 到 bus event payload。前端按 clientMessageId 去重 echo。
  _enqueueClientId(inst, clientMessageId) {
    if (!clientMessageId) return;
    if (!inst._pendingClientIds) inst._pendingClientIds = [];
    inst._pendingClientIds.push(clientMessageId);
  }

  // [需求@2026-06-12 §8.3] Pooled 角色派工
  //   1. acquire 一个 instance(指定 slot 或任意 idle 或新分配)
  //   2. 设 inst.threadSlug = currentTask
  //   3. 加 [Thread: <slug>] task tag 前缀
  //   4. [§8.5] H 还要前置 task board snapshot(活跃线索 + 池子状态 + 最近决策)
  //   5. 派工(idle → sendUserText / disconnected → resurrect / 新 → spawn with pending)
  //   6. 绑定到 thread.metadata + touch
  _sendToPooledRole({ projectId, projectRootDir, threadSlug, text, role, roleType, targetSlot, clientMessageId = null }) {
    const inst = this._acquirePoolInstance({ projectId, projectRootDir, role, requestedSlot: targetSlot, threadSlug });
    if (!inst) throw new Error(`could not acquire pool instance for ${role.name}`);

    // Bind current task — inst.threadSlug = current task being processed
    inst.threadSlug = threadSlug;

    // [需求@2026-06-12 §6 边界标记] task tag — 让 claude 知道当前 scope,但**不要它忘记过去**
    // [需求@2026-06-12 §1.7 §8.5] H 加 task board snapshot — 它需要全局视野做决策
    let finalText = text;
    if (role.type === 'orchestrator') {
      finalText = this._buildTaskBoardSnapshot(projectId, threadSlug) + text;
    }
    const taggedText = `[Thread: ${threadSlug}]\n\n${finalText}`;
    // [需求@2026-06-12 Phase 2E §12] enqueue clientMessageId 等 echo back 时 attach
    this._enqueueClientId(inst, clientMessageId);

    // Dispatch by status
    // [bug@2026-06-12] 派工沉默根因:_createPoolInstance 只分配 slot 不调 spawn(),
    //   新建实例 RoleInstance ctor 默认 status='spawning'。原代码在 'spawning' 分支只 queue
    //   _pendingUserText 不 spawn,认为"已经在 spawn 中"。结果 child 永远没启动,
    //   stdin 写入也丢失,user 沉默。
    //   修复:'spawning' 分支检查 inst._child;若 null 表示"还没真 spawn,只是 ctor 默认态",
    //   先设 pending 再 spawn(顺序确保 spawn 时 _pendingUserText 已有,suppressGreeting 路径会 flush)。
    if (inst.status === 'idle' || inst.status === 'busy') {
      // Phase 2D §8.5 will add queueing for busy; for now just send (claude will process in order)
      inst.sendUserText(taggedText);
    } else if (inst.status === 'disconnected') {
      inst.sendUserText(taggedText); // lazy resurrect via Phase 1 mechanism
    } else if (inst.status === 'spawning') {
      inst._pendingUserText = taggedText;
      if (!inst._child) {
        // _createPoolInstance 创建后 ctor 默认 'spawning' 但还没真 spawn — 现在补
        inst.spawn({ suppressGreeting: true });
      }
      // 否则真的在 spawn 中,pending 会在 init 完成时 flush
    } else {
      // Defensive fallback(理论上 ctor 把 status 限定在 spawning/disconnected,这里走不到)
      inst._pendingUserText = taggedText;
      inst.spawn({ suppressGreeting: true });
    }

    this._persistInstanceUpsert(inst);
    ThreadStore.bindInstance(projectId, threadSlug, roleType, inst.id);
    ThreadStore.touch(projectId, threadSlug, roleType);
    this._clearPendingQuestion(projectId, threadSlug);
    return inst;
  }

  // [arch §1.2 ✅] 池子 acquire / find / create 都已抽到 PoolAllocator。
  //   SpawnManager 这里仅做 wiring(注入 instances Map + 三个 wire callback)。
  _acquirePoolInstance({ projectId, projectRootDir, role, requestedSlot, threadSlug }) {
    return PoolAllocator.acquire({
      instances: this.instances,
      projectId, projectRootDir, role, requestedSlot, threadSlug,
      createPoolInstance: (args) => this._createPoolInstance(args),
    });
  }

  _findPoolInstance(projectId, roleName, slot) {
    return PoolAllocator.findPoolInstance(this.instances, projectId, roleName, slot);
  }

  _findNextFreePoolSlot(projectId, roleName, maxSlot) {
    return PoolAllocator.findNextFreePoolSlot(this.instances, projectId, roleName, maxSlot);
  }

  _createPoolInstance({ projectId, projectRootDir, role, poolSlot, threadSlug }) {
    return PoolAllocator.create({
      instances: this.instances,
      projectId, projectRootDir, role, poolSlot, threadSlug,
      checkGlobalCap: () => this._checkGlobalCap(),
      wireListeners: (inst) => this._wireListeners(inst),
      persistInstance: (inst) => this._persistInstanceUpsert(inst),
    });
  }

  // [arch §1.4 ✅] parseMarkerTarget 已抽到 MarkerDispatcher

  // [需求@2026-06-12 §1.7 §8.5] 给 H 注入的 task board snapshot
  //   每次 H 激活时拼一份当前 project 的全局视图:
  //   - 活跃线索(stage != closed) + 谁绑了谁
  //   - 池子状态(每个池化 instance:status + current/last task + 上次活动时间)
  //   - 最近 5 个 thread.handoff 决策(H 复盘自己派工历史)
  //   - 当前激活 thread 用 ← this activation 标记
  _buildTaskBoardSnapshot(projectId, currentThreadSlug) {
    const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const lines = [`[Mate task board · ${ts}]`, ''];

    // Active threads
    lines.push('## Active threads');
    try {
      const threads = db.prepare(`
        SELECT slug, title, stage, metadata_json FROM threads
        WHERE project_id = ? AND stage != 'closed'
        ORDER BY updated_at DESC LIMIT 10
      `).all(projectId);
      if (threads.length === 0) {
        lines.push('(none)');
      } else {
        for (const t of threads) {
          const meta = JSON.parse(t.metadata_json || '{}');
          const roles = meta.current_role_instances || {};
          const boundInfo = [];
          for (const [type, id] of Object.entries(roles)) {
            if (!id) continue;
            const inst = this.instances.get(id);
            if (inst) boundInfo.push(`${inst.displayName}(${inst.status})`);
          }
          const marker = t.slug === currentThreadSlug ? '  ← this activation' : '';
          lines.push(`- \`${t.slug}\`  ${t.stage}  ${boundInfo.join(', ') || '—'}${marker}`);
        }
      }
    } catch (e) {
      lines.push(`(error loading threads: ${e.message})`);
    }

    // Pool state — sorted by role then slot
    lines.push('', '## Pool state');
    const pooled = [...this.instances.values()].filter(
      (i) => i.projectId === projectId && i.poolSlot != null && i.status !== 'dead'
    ).sort((a, b) => {
      if (a.role.name !== b.role.name) return a.role.name.localeCompare(b.role.name);
      return a.poolSlot - b.poolSlot;
    });
    if (pooled.length === 0) {
      lines.push('(pool empty — first task will allocate slot 1)');
    } else {
      for (const inst of pooled) {
        const status = inst.status;
        const task = inst.threadSlug || '(none)';
        if (status === 'busy') {
          lines.push(`- ${inst.displayName}  busy  current: \`${task}\``);
        } else {
          const ago = inst.lastActiveAt ? this._relativeTime(inst.lastActiveAt) : '';
          lines.push(`- ${inst.displayName}  ${status}  last: \`${task}\` ${ago}`);
        }
      }
    }

    // Recent decisions (last 5 thread.handoff events)
    // [arch §3+§6 ✅] 走 EventStore.listRecentHandoffsForProject
    lines.push('', '## Recent dispatch decisions (last 5)');
    try {
      const events = EventStore.listRecentHandoffsForProject(projectId, 5);
      if (events.length === 0) {
        lines.push('(no handoffs yet)');
      } else {
        for (const e of events) {
          let payload = {};
          try { payload = JSON.parse(e.payload_json || '{}'); } catch {}
          const tt = new Date(e.ts).toISOString().slice(11, 16);
          const target = payload.target || payload.resolvedRole || '?';
          const reason = (payload.reason || '').slice(0, 50);
          lines.push(`- ${tt}  \`${e.thread_slug}\`  ${payload.from || '?'} → ${target}  "${reason}"`);
        }
      }
    } catch (e) {
      lines.push(`(error loading events: ${e.message})`);
    }

    lines.push('', '---', '');
    return lines.join('\n');
  }

  _relativeTime(ts) {
    const diff = Date.now() - ts;
    if (diff < 60_000) return '(just now)';
    if (diff < 3_600_000) return `(${Math.floor(diff / 60_000)}m ago)`;
    if (diff < 86_400_000) return `(${Math.floor(diff / 3_600_000)}h ago)`;
    return `(${Math.floor(diff / 86_400_000)}d ago)`;
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
    this.stopTtlScanner();
    const live = [...this.instances.values()].filter((i) => i.status !== 'dead');
    console.log(`[SpawnManager] shutting down ${live.length} live instances`);
    await Promise.all(live.map((i) => i.kill().catch((e) => console.warn('kill err:', e))));
  }

  // [需求@2026-06-12 §8.10 + Phase 2E §13] 全局软上限 cap_warn
  //   **新口径**:只算 idle/busy/spawning 真活实例(disconnected 不算 — 它们没 child,资源消耗 0)。
  //   这同时修了 §13 的 bug:历史 disconnected 累积导致 cap 永远红条 + cap 形同虚设。
  _checkGlobalCap() {
    const ACTIVE = new Set(['idle', 'busy', 'spawning']);
    const alive = [...this.instances.values()].filter((i) => ACTIVE.has(i.status)).length;
    const cap = config.globalMaxClaudeProcesses;
    if (alive >= cap) {
      bus.publish('system.cap_warn', { alive, cap, ts: Date.now() });
      try {
        recordEvent('system.cap_warn', { alive, cap });
      } catch {}
      console.warn(`[SpawnManager] global cap soft-exceeded: ${alive}/${cap}`);
    }
  }

  // [arch §1.1 ✅ 2026-06-13] TTL scanner 实现已抽到 ScanRecycler 模块。
  //   SpawnManager 仅做 wiring:注入 instances Map / db.stmts / recordEvent 闭包。
  startTtlScanner() {
    ScanRecycler.start({
      instances: this.instances,
      getStmts: () => stmts,
      getRecordEvent: () => recordEvent,
    });
  }

  stopTtlScanner() {
    ScanRecycler.stop();
  }

  // 单测兼容入口 — 老 spawnManagerScan.test.js 调 _runTtlScan
  _runTtlScan() {
    ScanRecycler.runOnce({
      instances: this.instances,
      getStmts: () => stmts,
      getRecordEvent: () => recordEvent,
    });
  }
}

module.exports = new SpawnManager();
