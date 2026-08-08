// ============================================================================
// MODULE CONTRACT(架构 SSOT:docs/architecture.md §3 §4 §6)
// ----------------------------------------------------------------------------
// 层:L4 API Surface
// 责任:REST 路由 + 请求验证 + 调 L1/L2/L3 完成业务
// 公共 API:buildRouter() → express.Router
// 允许依赖:所有 L1/L2/L3 + db / config
// 禁止:
//   - 内部状态(stateless;状态全在 L1/L2/L3)
//   - 直接读 stream(经 SpawnManager)
//   - 业务判断(只编排)
// ============================================================================
//
// REST endpoints. Phase 2A: project-aware.
//
// [需求@2026-06-10] 多 project 支持:list/spawn/etc 都按 ?projectId=N 隔离。
// projectId 验证 + active project state 由前端通过 localStorage 维护,后端 stateless。

const express = require('express');
const roleCatalog = require('../roles/RoleCatalog');
const spawnManager = require('../spawn/SpawnManager');
const log = require('../logger');
const MOD = 'http';
const ProjectStore = require('../projects/ProjectStore');
const ThreadStore = require('../threads/ThreadStore');
const envCheck = require('../system-agent/envCheck');
const QuotaState = require('../quota/QuotaState');
const PendingSends = require('../spawn/PendingSends');
const EventStore = require('../events/EventStore');
const config = require('../config');
const { db } = require('../db');

function requireProjectId(req, res, next) {
  const idStr = req.query.projectId || req.body?.projectId;
  const id = parseInt(idStr, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'projectId required' });
  const proj = ProjectStore.get(id);
  if (!proj) return res.status(404).json({ error: `project ${id} not found` });
  if (proj.archived_at) return res.status(410).json({ error: `project ${id} is archived` });
  req.project = proj;
  next();
}

function buildRouter() {
  const r = express.Router();

  // [需求@2026-06-17 E2E] 测试专用 API,只在 MATE_MOCK_TERMS=1 时启用
  try {
    const { mountTestApi } = require('./testApi');
    mountTestApi(r, { spawnManager });
  } catch (e) {
    // testApi 可选 — 不存在不影响生产
    if (process.env.MATE_MOCK_TERMS === '1') {
      log.error({ module: MOD, event: 'test_api_mount_failed', error: e.message });
    }
  }

  // ---------------- Runtime snapshot (Phase 2E §14 chip) ----------------
  // [需求@2026-06-12 Phase 2E §14] chip + popover 数据源
  //   GET /api/runtime/snapshot?projectId=N  →  {
  //     project: { id, name },
  //     instances: { idle: [], busy: [], spawning: [], disconnected: [] }(每个含
  //                  displayName, roleName, roleType, poolSlot, threadSlug,
  //                  currentModel, lastActiveAt, currentActivity)
  //     pending:   { total, byReason: { busy: N, quota_pause: N }, byTarget: [...] }
  //     quota:     QuotaState.snapshot()
  //     cap:       { alive, cap, atCap } 新口径(只算 idle+busy+spawning)
  //   }
  r.get('/runtime/snapshot', (req, res) => {
    const idStr = req.query.projectId;
    const projectId = idStr ? parseInt(idStr, 10) : null;
    let project = null;
    if (projectId) {
      project = ProjectStore.get(projectId);
      if (!project) return res.status(404).json({ error: `project ${projectId} not found` });
    }

    const ACTIVE = new Set(['idle', 'busy', 'spawning']);
    const all = spawnManager.listInstances(projectId, { includeDead: false });
    // 按 project 过滤(projectId null 时 = 全局)
    const scoped = projectId ? all.filter((i) => i.projectId === projectId) : all;

    // 分组
    const groups = { idle: [], busy: [], spawning: [], disconnected: [] };
    for (const i of scoped) {
      const g = groups[i.status];
      if (!g) continue;
      // currentActivity:最近一条 assistant 的 tool_use 或文本(只对 busy/idle 有意义)
      let currentActivity = null;
      if (i.status === 'busy' || i.status === 'idle') {
        try {
          const row = db.prepare(`
            SELECT payload_json, ts FROM messages
            WHERE instance_id = ? AND event_type = 'assistant'
            ORDER BY ts DESC LIMIT 1
          `).get(i.id);
          if (row) {
            const p = JSON.parse(row.payload_json);
            const content = p.message?.content || [];
            const tools = content.filter((c) => c.type === 'tool_use');
            const texts = content.filter((c) => c.type === 'text');
            if (tools.length) currentActivity = `🔧 ${tools[0].name}`;
            else if (texts.length) {
              // [bug@2026-06-13] texts 是 {type:'text', text:'...'} 对象数组,直接 .join 会得 "[object Object]"
              //   症状:chip/popover 显 "近活: [object Object]"
              //   修:.map(t => t.text || '') 先抽 text 字段再 join
              const t = texts.map((tt) => tt.text || '').join(' ').trim();
              currentActivity = t.length > 80 ? t.slice(0, 80) + '…' : t;
            }
          }
        } catch {}
      }
      g.push({
        id: i.id,
        // [bug@2026-06-19] 漏了 projectId 字段 → 前端按 project scope 过滤时全空,
        //   症状:dashboard 状态图选某 project,H/B/C 全不显(R 因 1472-1476
        //   特殊总显逻辑勉强活)。snapshot 已含,这里 push 时忘抄。
        projectId: i.projectId,
        displayName: i.displayName || i.id,
        roleName: i.roleName,
        roleType: i.roleType,
        status: i.status,  // [bug@2026-06-13] popover 按 status 分 live/disc 必需
        poolSlot: i.poolSlot,
        threadSlug: i.threadSlug,
        currentModel: i.currentModel,
        claudeCodeVersion: i.claudeCodeVersion,
        lastActiveAt: i.lastActiveAt,
        currentActivity,
        pid: i.pid,
        sessionId: i.sessionId,
      });
    }

    // pending 计数
    // [需求@2026-06-27 #169] byTarget 加可读字段(displayName / threadTitle / reason 等),
    //   user 在 chip popover 才能看出"哪个终端/哪条线索在排队"
    const byReason = PendingSends.countByReason();
    const pendingRows = (projectId ? PendingSends.listByProject(projectId) : PendingSends.listAll());
    const pendingByTarget = pendingRows
      .reduce((acc, p) => {
        const key = `${p.targetKind}:${p.targetId}`;
        if (!acc[key]) acc[key] = {
          targetKind: p.targetKind,
          targetId: p.targetId,
          n: 0,
          latestEnqueuedAt: 0,
          reasons: new Set(),
          kinds: new Set(),
          threadSlugs: new Set(),
          fromInstanceIds: new Set(),
        };
        acc[key].n++;
        if (p.enqueuedAt > acc[key].latestEnqueuedAt) acc[key].latestEnqueuedAt = p.enqueuedAt;
        if (p.reason) acc[key].reasons.add(p.reason);
        if (p.kind) acc[key].kinds.add(p.kind);
        if (p.threadSlug) acc[key].threadSlugs.add(p.threadSlug);
        if (p.fromInstanceId) acc[key].fromInstanceIds.add(p.fromInstanceId);
        return acc;
      }, {});
    // 解析 displayName 和 threadTitle(只查涉及的 instance / thread,避免全表扫)
    const allInstanceIds = new Set();
    const allThreadSlugs = new Set();
    Object.values(pendingByTarget).forEach((it) => {
      if (it.targetKind === 'instance') allInstanceIds.add(it.targetId);
      it.fromInstanceIds.forEach((id) => allInstanceIds.add(id));
      it.threadSlugs.forEach((s) => allThreadSlugs.add(s));
      if (it.targetKind === 'thread') allThreadSlugs.add(it.targetId);
    });
    const instanceById = {};
    for (const id of allInstanceIds) {
      const inst = spawnManager.instances.get(id);
      if (inst) instanceById[id] = { displayName: inst.displayName || id, roleName: inst.roleName, status: inst.status };
    }
    const threadBySlug = {};
    for (const slug of allThreadSlugs) {
      try {
        const t = db.prepare(`SELECT slug, title, stage FROM threads WHERE slug = ?`).get(slug);
        if (t) threadBySlug[slug] = { title: t.title || slug, stage: t.stage };
      } catch {}
    }
    const byTarget = Object.values(pendingByTarget).map((it) => ({
      targetKind: it.targetKind,
      targetId: it.targetId,
      n: it.n,
      latestEnqueuedAt: it.latestEnqueuedAt,
      reasons: [...it.reasons],
      kinds: [...it.kinds],
      threadSlugs: [...it.threadSlugs],
      // 新增可读字段
      targetDisplay: it.targetKind === 'instance'
        ? (instanceById[it.targetId]?.displayName || it.targetId)
        : (threadBySlug[it.targetId]?.title || it.targetId),
      targetRoleName: instanceById[it.targetId]?.roleName || null,
      targetStatus: instanceById[it.targetId]?.status || null,
      threadTitle: it.threadSlugs.size === 1
        ? (threadBySlug[[...it.threadSlugs][0]]?.title || null)
        : null,
      fromInstances: [...it.fromInstanceIds].map((id) => ({
        id,
        displayName: instanceById[id]?.displayName || id,
      })),
    }));
    const pending = {
      total: projectId ? PendingSends.countByProject(projectId) : PendingSends.count(),
      byReason,
      byTarget,
    };

    // cap 新口径(§13 修复:不算 disconnected)
    const aliveCount = groups.idle.length + groups.busy.length + groups.spawning.length;
    const cap = config.globalMaxClaudeProcesses;
    const capInfo = { alive: aliveCount, cap, atCap: aliveCount >= cap };

    res.json({
      project: project ? { id: project.id, name: project.name } : null,
      counts: {
        idle: groups.idle.length,
        busy: groups.busy.length,
        spawning: groups.spawning.length,
        disconnected: groups.disconnected.length,
      },
      instances: groups,
      pending,
      quota: QuotaState.snapshot(),
      cap: capInfo,
      ts: Date.now(),
    });
  });

  // [需求@2026-06-12 Phase 2E §6] user 点 banner × 手动 abort quota PAUSED
  r.post('/runtime/quota/override', (req, res) => {
    const { type } = req.body || {};  // 可选,不传则同时 override 5h + 7d
    try {
      QuotaState.manualOverride(type || null);
      res.json({ ok: true, quota: QuotaState.snapshot() });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ---------------- Environment check (Phase 2C.2) ----------------
  // [需求@2026-06-10 §2.1] 手动触发,失败不阻塞
  r.post('/system/healthcheck', async (req, res) => {
    try {
      const result = await envCheck.runAllChecks();
      res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ---------------- Projects ----------------
  r.get('/projects', (req, res) => {
    res.json(ProjectStore.list());
  });

  r.post('/projects', (req, res) => {
    const { name, rootDir, settings } = req.body || {};
    try {
      const p = ProjectStore.create({ name, rootDir, settings });
      res.status(201).json(p);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  r.delete('/projects/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
      const p = ProjectStore.archive(id);
      res.json(p);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  r.get('/projects/inspect', (req, res) => {
    const { path: dirPath } = req.query;
    if (!dirPath) return res.status(400).json({ error: 'path query param required' });
    res.json(ProjectStore.inspectDir(dirPath));
  });

  // ---------------- Roles (project-independent — mate's global catalog) ----------------
  r.get('/roles', (req, res) => {
    res.json(roleCatalog.list().map((role) => ({
      name: role.name,
      type: role.type,
      parallelismLimit: role.parallelismLimit,
      isCentral: role.isCentral,
      sessionTtlHours: role.sessionTtlHours,
      displayColor: role.displayColor,
      allowedTools: role.allowedTools,
      skillCommand: role.skillCommand,
    })));
  });

  // [需求@2026-07-02] 重读 roles/*.md — 改了 frontmatter (allowed_tools /
  //   allow_rules / prompt body 等) 不用重启 mate 即可生效,下次 spawn 用新版。
  //   已 spawn 的 disconnected/idle 实例:reset 或 restart 时也会用新 role。
  //   busy 实例:当前 turn 跑完前不受影响(child 进程是启动时定住的 flag)。
  r.post('/roles/reload', (req, res) => {
    try {
      const before = roleCatalog.list().map((r) => ({
        name: r.name,
        allowedTools: r.allowedTools,
      }));
      roleCatalog.load();
      const after = roleCatalog.list().map((r) => ({
        name: r.name,
        allowedTools: r.allowedTools,
      }));
      res.json({ ok: true, count: after.length, before, after });
    } catch (e) {
      log.error({ module: MOD, event: 'roles_reload_failed', error: e?.message || String(e) });
      res.status(500).json({ error: e.message });
    }
  });

  r.get('/instances', requireProjectId, (req, res) => {
    res.json(spawnManager.listInstances(req.project.id));
  });

  // [需求@2026-06-11 §2] 终端管理 modal:跨 project 列所有实例(可含 dead)
  // [需求@2026-06-12 §8.6] ?details=1 加 latestActivity + memory 状况(给仪表盘 tab 1 用)
  r.get('/instances/all', (req, res) => {
    const includeDead = req.query.includeDead === '1' || req.query.includeDead === 'true';
    const wantDetails = req.query.details === '1' || req.query.details === 'true';
    const insts = spawnManager.listInstances(null, { includeDead });
    // ProjectStore.list() filters out is_system; need listAllProjects to include System
    const projects = (require('../db').stmts.listAllProjects.all());
    const projById = new Map(projects.map((p) => [p.id, p]));

    let detailsByInstance = null;
    if (wantDetails) {
      const fs = require('node:fs');
      const path = require('node:path');
      const os = require('node:os');
      const { db } = require('../db');

      const encodeCwd = (cwd) => cwd.replace(/:/g, '--').replace(/[\\/]/g, '-');
      const memoryRoot = path.join(os.homedir(), '.claude', 'projects');

      detailsByInstance = {};
      for (const i of insts) {
        // latestActivity: latest assistant text or tool_use from messages table
        const latestRow = db.prepare(`
          SELECT event_type, payload_json, ts FROM messages
          WHERE instance_id = ? AND event_type IN ('assistant')
          ORDER BY ts DESC LIMIT 1
        `).get(i.id);
        let latestActivity = '(no recent activity)';
        let latestActivityTs = null;
        if (latestRow) {
          try {
            const p = JSON.parse(latestRow.payload_json);
            const content = p.message?.content || [];
            const textParts = content.filter((c) => c.type === 'text').map((c) => c.text);
            const toolUses = content.filter((c) => c.type === 'tool_use');
            if (toolUses.length) {
              latestActivity = `🔧 ${toolUses[0].name}`;
            } else if (textParts.length) {
              const t = textParts.join(' ').trim();
              latestActivity = t.length > 60 ? t.slice(0, 60) + '…' : t;
            }
            latestActivityTs = latestRow.ts;
          } catch {}
        }

        // memory: count .md files + latest mtime in ~/.claude/projects/<encoded-cwd>/memory/
        const proj = projById.get(i.projectId);
        let memory = { fileCount: 0, latestMtime: null };
        if (proj?.root_dir) {
          const memDir = path.join(memoryRoot, encodeCwd(proj.root_dir), 'memory');
          try {
            const files = fs.readdirSync(memDir).filter((f) => f.endsWith('.md'));
            memory.fileCount = files.length;
            let mt = 0;
            for (const f of files) {
              const st = fs.statSync(path.join(memDir, f));
              if (st.mtimeMs > mt) mt = st.mtimeMs;
            }
            memory.latestMtime = mt || null;
          } catch {}
        }

        detailsByInstance[i.id] = { latestActivity, latestActivityTs, memory };
      }
    }

    res.json(insts.map((i) => ({
      ...i,
      projectName: projById.get(i.projectId)?.name || '(unknown)',
      ...(detailsByInstance ? detailsByInstance[i.id] : {}),
    })));
  });

  r.post('/instances', requireProjectId, (req, res) => {
    const { roleName, customGreeting } = req.body || {};
    if (!roleName) return res.status(400).json({ error: 'roleName required' });
    try {
      const inst = spawnManager.spawnInstance({
        projectId: req.project.id,
        projectRootDir: req.project.root_dir,
        roleName,
        customGreeting,
      });
      res.status(201).json(inst.snapshot());
    } catch (e) {
      res.status(409).json({ error: e.message });
    }
  });

  r.delete('/instances/:id', async (req, res) => {
    try {
      const out = await spawnManager.killInstance(req.params.id);
      res.json(out);
    } catch (e) {
      res.status(404).json({ error: e.message });
    }
  });

  r.post('/instances/:id/message', (req, res) => {
    const { text } = req.body || {};
    if (typeof text !== 'string' || !text.length) return res.status(400).json({ error: 'text required' });
    const inst = spawnManager.getInstance(req.params.id);
    if (!inst) return res.status(404).json({ error: 'instance not found' });
    try {
      inst.sendUserText(text);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // [需求@2026-07-20 #176 Layer 3] 通用系统注入 —
  //   user 只跟 R 对话,想给 H / B / C 说话没通道。给任何 inst 直接注入伪 user 消息,
  //   包 <system:mate-{label}> 前缀 + "非 user 输入" 明确警告(参考 #175 R-notify 措辞)。
  //   Body: { text, label?='operator' }
  //         label ∈ 'system' | 'operator' | 'retry' | 'handoff'(仅影响 XML 标签名)
  //   路由:inst 绑 thread → sendToThread(targetInstance=id);未绑 → sendDirectToInstance
  r.post('/instances/:id/inject', (req, res) => {
    const { text, label = 'operator' } = req.body || {};
    if (typeof text !== 'string' || !text.length) return res.status(400).json({ error: 'text required' });
    if (!/^[a-z_-]{1,20}$/i.test(label)) return res.status(400).json({ error: 'label must match /^[a-z_-]{1,20}$/i' });
    const inst = spawnManager.getInstance(req.params.id);
    if (!inst) return res.status(404).json({ error: 'instance not found' });
    if (inst.status === 'dead') return res.status(409).json({ error: 'instance is dead' });

    const tag = `system:mate-${label}`;
    const wrapped = `<${tag}>
${text}

**这是 mate 系统注入,不是 user 输入。你可以直接决策 / 执行 / handoff,不必回复"收到"或等 user 确认。**
</${tag}>`;

    try {
      let result;
      if (inst.threadSlug) {
        // 通过 sendToThread,targetInstance 锁定本 inst,markers 会正常被处理
        const project = ProjectStore.get(inst.projectId);
        if (!project) return res.status(500).json({ error: `project ${inst.projectId} not found` });
        result = spawnManager.sendToThread({
          projectId: inst.projectId,
          projectRootDir: project.root_dir,
          threadSlug: inst.threadSlug,
          text: wrapped,
          targetInstance: inst.id,
          fromMarker: false,
        });
      } else {
        result = spawnManager.sendDirectToInstance(inst.id, wrapped);
      }
      if (result?.deferred) {
        return res.json({ ok: true, deferred: true, pendingSendId: result.pendingSendId, reason: 'quota_pause', label });
      }
      res.json({
        ok: true,
        injectedTo: inst.id,
        displayName: inst.displayName,
        label,
        threadSlug: inst.threadSlug || null,
        preview: text.slice(0, 200),
      });
    } catch (e) {
      const code = /not found/i.test(e.message) ? 404
                 : /busy|spawning|dead/i.test(e.message) ? 409 : 400;
      res.status(code).json({ error: e.message });
    }
  });

  // [需求@2026-06-16] Reset Terminal — user 主动给 instance 清账
  //   行为:kill child + 丢 session_id + 翻 disconnected;下次 user 发消息 fresh spawn
  //   适用:claude 累积了错误判断 / context 太满 / 想换思路
  //   保留:~/.claude memory(跨 session)+ thread metadata + DB messages 历史
  //   busy/spawning 拒(让 user 先 stop)
  r.post('/instances/:id/reset', async (req, res) => {
    const inst = spawnManager.getInstance(req.params.id);
    if (!inst) return res.status(404).json({ error: 'instance not found' });
    try {
      const r2 = await inst.resetSession();
      res.json({ ...r2, instanceId: req.params.id, hint: '下次发消息时 lazy resurrect,起全新 session(memory 保留)' });
    } catch (e) {
      const code = /busy|spawning|dead/.test(e.message) ? 409 : 400;
      res.status(code).json({ error: e.message });
    }
  });

  // [需求@2026-06-15] 切 model — claude headless 不接 /model slash,只能 kill+respawn
  //   - 设 inst.preferredModel(in-memory)
  //   - 如果有 child:graceful kill(stdin.end + 2s grace + SIGTERM)→ exit handler 看 _softKillForRestart 翻 disconnected
  //   - 下次 user send 时 lazy resurrect 用 preferredModel + 全新 session
  //   - busy/spawning 拒绝(409),让 user 自己 stop 后再切
  //   - mate 重启 preferredModel 失效(永久改要走 roles/<name>.md frontmatter)
  r.post('/instances/:id/switch-model', async (req, res) => {
    const { model } = req.body || {};
    if (typeof model !== 'string' || !model.trim()) {
      return res.status(400).json({ error: 'model required (e.g. claude-haiku-4-5)' });
    }
    const inst = spawnManager.getInstance(req.params.id);
    if (!inst) return res.status(404).json({ error: 'instance not found' });
    try {
      const r = await inst.switchModel(model.trim());
      res.json({ ...r, instanceId: req.params.id, hint: '下次发消息时 lazy resurrect,起新 session + 新 model' });
    } catch (e) {
      // busy/spawning/dead 拒
      const code = /busy|spawning|dead/.test(e.message) ? 409 : 400;
      res.status(code).json({ error: e.message });
    }
  });

  // [需求@2026-06-14 D] 系统监控 — 给具体 instance 发 slash / skill 指令
  //   (/clear, /resume, /help 等 — 或自由文本)
  //   语义上同 /message,但语义清晰、便于审计;走 sendUserText,绕过 thread 路由。
  //   busy 实例也允许 — 这本身就是干预手段(claude 排队处理)。
  r.post('/instances/:id/slash', (req, res) => {
    const { command } = req.body || {};
    if (typeof command !== 'string' || !command.trim()) {
      return res.status(400).json({ error: 'command required' });
    }
    const inst = spawnManager.getInstance(req.params.id);
    if (!inst) return res.status(404).json({ error: 'instance not found' });
    try {
      inst.sendUserText(command.trim());
      res.json({ ok: true, sent: command.trim(), instanceId: req.params.id });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // [需求@2026-06-12 §9 mateTerm] 直连模式 — user 直接对 instance 说话,无 thread。
  //   marker 不触发后端 side effect(显示给前端做灰色提示);消息持久化挂 instance (direct_target)。
  r.post('/instances/:id/direct-message', (req, res) => {
    const { text, clientMessageId } = req.body || {};
    if (typeof text !== 'string' || !text.length) return res.status(400).json({ error: 'text required' });
    try {
      const result = spawnManager.sendDirectToInstance(req.params.id, text, { clientMessageId });
      // [bug@2026-06-29 #170] paused 时返 {deferred:true},不是 RoleInstance
      if (result?.deferred) {
        return res.json({ ok: true, deferred: true, pendingSendId: result.pendingSendId, reason: 'quota_pause', mode: 'direct', clientMessageId });
      }
      res.json({ ok: true, instance: result.snapshot(), mode: 'direct', clientMessageId });
    } catch (e) {
      const code = /not found/i.test(e.message) ? 404
                 : /busy|spawning|dead/i.test(e.message) ? 409 : 400;
      res.status(code).json({ error: e.message });
    }
  });

  // [需求@2026-06-12 §9 + Phase 2E §8] 直连历史:按 direct_target = instance.id 拉
  //   按 (ts ASC, id ASC) 排序:防止同毫秒事件顺序不确定(§8 mateTerm 顺序倒置 bug)
  r.get('/instances/:id/direct-history', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
    const rows = db.prepare(`
      SELECT id, instance_id, role_name, direction, claude_session_id, ts, event_type, payload_json, direct_target
      FROM messages
      WHERE direct_target = ?
      ORDER BY ts ASC, id ASC
      LIMIT ?
    `).all(req.params.id, limit);
    res.json(rows.map((m) => ({
      id: m.id,
      instanceId: m.instance_id,
      roleName: m.role_name,
      direction: m.direction,
      claudeSessionId: m.claude_session_id,
      ts: m.ts,
      eventType: m.event_type,
      payload: JSON.parse(m.payload_json),
      directTarget: m.direct_target,
    })));
  });

  // [需求@2026-06-16] 实例视角全量历史 — 拉该 claude 进程所有 user/assistant 事件
  //   不分 thread / 不分 direct,纯进程视角:H 喂给它的 user msg + 它的 assistant 输出 + tool_use 等
  //   服务于 dashboard 对话控制 tab 的"看实时流"需求
  r.get('/instances/:id/all-history', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
    // 反序拿最近 N 条,再正序输出(避免漏最新)
    const rows = db.prepare(`
      SELECT id, instance_id, role_name, direction, claude_session_id, ts, event_type, payload_json, direct_target, thread_slug
      FROM messages
      WHERE instance_id = ?
      ORDER BY ts DESC, id DESC
      LIMIT ?
    `).all(req.params.id, limit);
    rows.reverse();
    res.json(rows.map((m) => ({
      id: m.id,
      instanceId: m.instance_id,
      roleName: m.role_name,
      direction: m.direction,
      claudeSessionId: m.claude_session_id,
      ts: m.ts,
      eventType: m.event_type,
      payload: JSON.parse(m.payload_json),
      directTarget: m.direct_target,
      threadSlug: m.thread_slug,
    })));
  });

  // [需求@2026-06-14] 日志流 — dashboard tab 5
  //   全局多维度过滤 messages 表(SSOT 所有 claude stream 事件)。
  //   - instanceId / projectId / threadSlug / eventType / since
  //   - eventType 支持 'assistant' / 'result' (前缀,匹配 result/success+error) / 'system' / 'all'
  //   - 默认 limit 500,max 2000
  //   - 默认按 ts DESC(最新在前),让前端 prepend 即可
  r.get('/log-stream', (req, res) => {
    const conds = [];
    const params = [];
    if (req.query.instanceId) { conds.push('instance_id = ?'); params.push(req.query.instanceId); }
    if (req.query.projectId) {
      // messages 没直接 projectId 字段,通过 instance_id join 在 role_instances
      const ids = db.prepare(`SELECT id FROM role_instances WHERE project_id = ?`).all(parseInt(req.query.projectId, 10)).map((r) => r.id);
      if (!ids.length) return res.json([]);
      conds.push(`instance_id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }
    if (req.query.threadSlug) {
      // thread 维度:thread_slug 直接或 direct_target 关联同 thread 实例
      conds.push('thread_slug = ?');
      params.push(req.query.threadSlug);
    }
    if (req.query.eventType && req.query.eventType !== 'all') {
      const et = req.query.eventType;
      // 前缀匹配:'result' → matches result/success + result/error;'system' → system/*
      if (et === 'result' || et === 'system') {
        conds.push('event_type LIKE ?');
        params.push(et + '%');
      } else {
        conds.push('event_type = ?');
        params.push(et);
      }
    }
    if (req.query.since) {
      conds.push('ts > ?');
      params.push(parseInt(req.query.since, 10));
    }
    const limit = Math.min(parseInt(req.query.limit, 10) || 500, 2000);
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const rows = db.prepare(`
      SELECT id, instance_id, role_name, direction, claude_session_id, ts, event_type, payload_json, thread_slug, direct_target
      FROM messages
      ${where}
      ORDER BY ts DESC, id DESC
      LIMIT ?
    `).all(...params, limit);
    res.json(rows.map((m) => ({
      id: m.id,
      instanceId: m.instance_id,
      roleName: m.role_name,
      direction: m.direction,
      claudeSessionId: m.claude_session_id,
      ts: m.ts,
      eventType: m.event_type,
      threadSlug: m.thread_slug,
      directTarget: m.direct_target,
      payload: JSON.parse(m.payload_json),
    })));
  });

  r.get('/instances/:id/history', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
    const rows = db.prepare(`
      SELECT id, instance_id, role_name, direction, claude_session_id, ts, event_type, payload_json
      FROM messages
      WHERE instance_id = ?
      ORDER BY ts ASC, id ASC
      LIMIT ?
    `).all(req.params.id, limit);
    res.json(rows.map((m) => ({
      id: m.id,
      instanceId: m.instance_id,
      roleName: m.role_name,
      direction: m.direction,
      claudeSessionId: m.claude_session_id,
      ts: m.ts,
      eventType: m.event_type,
      payload: JSON.parse(m.payload_json),
    })));
  });

  // [需求@2026-07-29 #192] chain 走串扫描 — 全库查各 thread chain 里 reason/summary
  //   引用别的 thread slug 的段(原设想是识别 pool 复用 race 造成的错记)。
  //   Query: ?since=<ISO time>  → 只返 ts >= since 的走串,默认全部
  //   使用:UI 一键自查 + 命令行 scripts/scan_chain_crossings.js 用同一 endpoint
  //
  // [bug@2026-08-06] 语义降级:仅文本引用扫描,不再当"异常"信号
  //   合理跨线索引用("参考 t-xxx 里的做法")会一直命中假警,导致 baseline
  //   一直被 ack。真"走串"看 X2 audit /api/audit/threadslug-flips。
  //   response.advisory=true 提示 client 这只是引用检索,非异常告警。
  // [需求@2026-07-30 X1 #195] 触发一次一致性检查(手动 UI 用) — 返回所有异常
  r.get('/consistency-check', async (req, res) => {
    try {
      const ConsistencyCheck = require('../spawn/ConsistencyCheck');
      const result = await ConsistencyCheck.runOnce();
      res.json({
        ts: Date.now(),
        baselineTs: ConsistencyCheck.getBaselineTs(),
        totalIssues: result.inconsistencies.reduce((s, x) => s + x.count, 0),
        selfHealed: result.selfHealed,
        kinds: result.inconsistencies.map((x) => x.kind),
        details: result.inconsistencies,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // [X2 #200] threadSlug 变更审计查询 —
  //   Query: ?instanceId=xxx (可选,不传 = 全库),&sinceHours=24,&limit=100
  //   返回该 inst(或全部)threadSlug 每次 flip 的历史 + caller stack
  r.get('/audit/threadslug-flips', (req, res) => {
    const instanceId = req.query.instanceId || null;
    const sinceHours = parseInt(req.query.sinceHours, 10) || 24;
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const sinceTs = Date.now() - sinceHours * 3600 * 1000;
    try {
      let sql = `
        SELECT ts, instance_id, payload_json FROM events
        WHERE kind = 'debug.instance_threadslug_flip' AND ts > ?
      `;
      const params = [sinceTs];
      if (instanceId) { sql += ' AND instance_id = ?'; params.push(instanceId); }
      sql += ' ORDER BY ts DESC LIMIT ?';
      params.push(limit);
      const rows = db.prepare(sql).all(...params);
      res.json({
        count: rows.length,
        sinceHours,
        flips: rows.map((r) => {
          const p = JSON.parse(r.payload_json);
          return {
            ts: r.ts, tsIso: new Date(r.ts).toISOString(),
            instanceId: r.instance_id,
            from: p.from, to: p.to,
            callerStack: p.callerStack,
          };
        }),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // [需求@2026-08-08 supervisor] 主动值班组件 API
  //   /state       — 当前状态灯 + 各 severity 计数(轻量,UI 顶栏轮询)
  //   /findings    — 详细 findings(可 filter by severity/ruleId/threadSlug)
  //   /log         — 决策日志时间线(自 sinceTs)
  //   /restart-check — 重启门控专用(返 verdict + block reasons)
  //   /dismiss/:id / /apply/:id — 用户交互
  r.get('/supervisor/state', (req, res) => {
    try {
      const Supervisor = require('../supervisor');
      res.json(Supervisor.getState());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  r.get('/supervisor/findings', (req, res) => {
    try {
      const Supervisor = require('../supervisor');
      const filter = {
        severity: req.query.severity,
        ruleId: req.query.ruleId,
        threadSlug: req.query.threadSlug,
      };
      res.json({ findings: Supervisor.getFindings(filter) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  r.get('/supervisor/log', (req, res) => {
    try {
      const Supervisor = require('../supervisor');
      const sinceTs = req.query.since ? parseInt(req.query.since, 10) : 0;
      res.json({ log: Supervisor.getLog(sinceTs) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  r.get('/supervisor/restart-check', async (req, res) => {
    try {
      const Supervisor = require('../supervisor');
      const verdict = await Supervisor.getRestartVerdict();
      res.json(verdict);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  r.post('/supervisor/dismiss/:id', (req, res) => {
    try {
      const Supervisor = require('../supervisor');
      const ok = Supervisor.dismissFinding(req.params.id);
      res.json({ ok, findingId: req.params.id });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  r.post('/supervisor/apply/:id', async (req, res) => {
    try {
      const Supervisor = require('../supervisor');
      const result = await Supervisor.applyFinding(req.params.id);
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(e.message.includes('not found') ? 404 : 400).json({ error: e.message });
    }
  });

  // [X1] 确认已知 chain crossings — 设 baseline,之后只报新走串
  r.post('/consistency-check/acknowledge', (req, res) => {
    try {
      const ConsistencyCheck = require('../spawn/ConsistencyCheck');
      const r2 = ConsistencyCheck.acknowledgeCrossings();
      res.json(r2);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.get('/chain-crossings', (req, res) => {
    try {
      const sinceMs = req.query.since ? new Date(req.query.since).getTime() : 0;
      const rows = db.prepare('SELECT slug, project_id, metadata_json FROM threads').all();
      const projects = require('../db').stmts.listAllProjects.all();
      const projById = new Map(projects.map((p) => [p.id, p.name]));
      const crossings = [];
      for (const r2 of rows) {
        let chain;
        try { chain = JSON.parse(r2.metadata_json).dispatch_chain || []; }
        catch { continue; }
        chain.forEach((c, i) => {
          const text = (c.reason || c.summary || '');
          const slugRefs = text.match(/t-m[a-z0-9]{7}-[a-z0-9]{4}/g) || [];
          for (const s of slugRefs) {
            if (s !== r2.slug) {
              crossings.push({
                host: r2.slug,
                projectId: r2.project_id,
                projectName: projById.get(r2.project_id) || '?',
                idx: i,
                ts: c.ts,
                kind: c.kind,
                from: c.fromRole || '',
                to: c.toRole || c.toDisplayName || '',
                otherSlug: s,
                preview: text.slice(0, 200).replace(/\n/g, ' '),
              });
              break;
            }
          }
        });
      }
      crossings.sort((a, b) => a.ts - b.ts);
      const filtered = sinceMs ? crossings.filter((c) => c.ts >= sinceMs) : crossings;
      res.json({
        total: filtered.length,
        threads: new Set(filtered.map((c) => c.host)).size,
        since: sinceMs ? new Date(sinceMs).toISOString() : null,
        latest: filtered.length ? new Date(filtered[filtered.length - 1].ts).toISOString() : null,
        crossings: filtered,
        advisory: true,
        advisoryNote: '仅文本引用扫描,合理跨线索引用会命中;真"走串"检测请查 /api/audit/threadslug-flips',
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---------------- Threads (Phase 2B 主视图) ----------------
  // [需求@2026-06-10] 线索是 user 需求(一等公民);所有路径以 thread_slug 为主
  r.get('/threads', requireProjectId, (req, res) => {
    const includeClosed = req.query.includeClosed === '1' || req.query.includeClosed === 'true';
    res.json(ThreadStore.list(req.project.id, { includeClosed }));
  });

  // [需求@2026-06-12 §8.8] 派工时序事件 — 仪表盘 tab 3 用
  //   返回 thread.handoff / thread.done / thread.blocked 三类事件(跨 project)
  // [arch §3+§6 ✅] 走 EventStore.listDispatchHistory,不再裸 SQL
  r.get('/dispatches/history', (req, res) => {
    const limit = parseInt(req.query.limit, 10) || 200;
    const events = EventStore.listDispatchHistory({ limit });
    const projects = require('../db').stmts.listAllProjects.all();
    const projById = new Map(projects.map((p) => [p.id, p]));
    res.json(events.map((e) => ({
      ...e,
      projectName: projById.get(e.projectId)?.name || '?',
    })));
  });

  // [需求@2026-06-12 §8.7] 跨 project 列所有线索 — 仪表盘 tab 2 用
  //   返回每条 thread 含 projectName + projectId,方便前端按 project 分组或跳转
  r.get('/threads/all', (req, res) => {
    const includeClosed = req.query.includeClosed === '1' || req.query.includeClosed === 'true';
    const includeSystem = req.query.includeSystem === '1' || req.query.includeSystem === 'true';
    const projects = includeSystem
      ? require('../db').stmts.listAllProjects.all()
      : ProjectStore.list();
    const all = [];
    for (const p of projects) {
      const threads = ThreadStore.list(p.id, { includeClosed });
      for (const t of threads) {
        all.push({ ...t, projectName: p.name, projectId: p.id });
      }
    }
    // Sort by updatedAt DESC (most active first)
    all.sort((a, b) => b.updatedAt - a.updatedAt);
    res.json(all);
  });

  r.post('/threads', requireProjectId, (req, res) => {
    const { slug, title } = req.body || {};
    try {
      const t = ThreadStore.create(req.project.id, { slug, title });
      res.status(201).json(t);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  r.get('/threads/:slug', requireProjectId, (req, res) => {
    const t = ThreadStore.get(req.project.id, req.params.slug);
    if (!t) return res.status(404).json({ error: 'thread not found' });
    res.json(t);
  });

  r.patch('/threads/:slug', requireProjectId, (req, res) => {
    const { stage, title } = req.body || {};
    try {
      let t = ThreadStore.get(req.project.id, req.params.slug);
      if (!t) return res.status(404).json({ error: 'thread not found' });
      if (stage) t = ThreadStore.setStage(req.project.id, req.params.slug, stage);
      if (title) t = ThreadStore.setTitle(req.project.id, req.params.slug, title);
      res.json(t);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // [需求@2026-06-16] limit 默认 200 → 500;max 2000 → 10000
  //   加 before=<ts> 参数支持分页查"看更早"(降序拉,从 before 之前再拉 N 条)
  r.get('/threads/:slug/history', requireProjectId, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 500, 10000);
    const before = req.query.before ? parseInt(req.query.before, 10) : null;
    let rows;
    if (before && Number.isFinite(before)) {
      // 分页:拉 ts < before 的最后 N 条,然后再 reverse 成升序
      rows = db.prepare(`
        SELECT id, instance_id, role_name, direction, claude_session_id, ts, event_type, payload_json
        FROM messages
        WHERE project_id = ? AND thread_slug = ? AND ts < ?
        ORDER BY ts DESC, id DESC
        LIMIT ?
      `).all(req.project.id, req.params.slug, before, limit);
      rows.reverse();
    } else {
      // [bug@2026-06-17] 老线索消息累积超 limit 时,ASC + LIMIT 切走的是"最新"。
      //   返"最早 N 条"导致 user 看不到最近的输入 / LLM 输出(5000+ 消息线索很常见)。
      //   修:DESC + LIMIT 取最近 N 条,再 reverse 成升序展示。
      //   "看更早"分页走 before 分支(那个本来就是 DESC + reverse 正确)。
      rows = db.prepare(`
        SELECT id, instance_id, role_name, direction, claude_session_id, ts, event_type, payload_json
        FROM messages
        WHERE project_id = ? AND thread_slug = ?
        ORDER BY ts DESC, id DESC
        LIMIT ?
      `).all(req.project.id, req.params.slug, limit);
      rows.reverse();
    }
    res.json(rows.map((m) => ({
      id: m.id,
      instanceId: m.instance_id,
      roleName: m.role_name,
      direction: m.direction,
      claudeSessionId: m.claude_session_id,
      ts: m.ts,
      eventType: m.event_type,
      payload: JSON.parse(m.payload_json),
    })));
  });

  // [需求@2026-06-29 #171] 线索导出 markdown:user 把对话/最终输出归档
  //   ?range=all|1d|3d|7d (默认 all)
  //   ?format=md|html (默认 md;[需求@2026-06-29 #172] HTML 保留 mate UI 视觉风格)
  //   ?saveToProject=true → 同时写到 <project.root_dir>/doc/exports/<slug>_<range>_<ts>.<ext>
  //   默认 Content-Disposition attachment 触发浏览器下载;只想拿文本可加 ?inline=true
  r.get('/threads/:slug/export', requireProjectId, (req, res) => {
    try {
      const ThreadStore = require('../threads/ThreadStore');
      const MarkdownExporter = require('../threads/MarkdownExporter');
      const HtmlExporter = require('../threads/HtmlExporter');
      const fs = require('node:fs');
      const path = require('node:path');

      const thread = ThreadStore.get(req.project.id, req.params.slug);
      if (!thread) return res.status(404).json({ error: 'thread not found' });

      const range = MarkdownExporter.parseRange(req.query.range || 'all');
      const now = Date.now();
      const format = (req.query.format || 'md').toLowerCase() === 'html' ? 'html' : 'md';

      // 拉所有 messages(导出场景,不分页,但限 50k 防 OOM)
      const rows = db.prepare(`
        SELECT id, instance_id, role_name, direction, ts, event_type, payload_json
        FROM messages
        WHERE project_id = ? AND thread_slug = ?
        ORDER BY ts ASC, id ASC
        LIMIT 50000
      `).all(req.project.id, req.params.slug);
      const messages = rows.map((m) => ({
        ts: m.ts,
        event_type: m.event_type,
        direction: m.direction,
        instance_id: m.instance_id,
        payload: JSON.parse(m.payload_json),
      }));
      const filtered = MarkdownExporter.filterByRange(messages, range, now);

      const threadSummary = {
        slug: thread.slug, title: thread.title, stage: thread.stage, outcome: thread.outcome,
        created_at: thread.created_at, updated_at: thread.updated_at,
      };
      const buildOpts = { range, now, projectName: req.project.name };
      const body = format === 'html'
        ? HtmlExporter.buildHtml(threadSummary, filtered, buildOpts)
        : MarkdownExporter.buildMarkdown(threadSummary, filtered, buildOpts);

      // 文件名:<slug>_<range>_YYYYMMDD-HHMM.<md|html>
      const d = new Date(now);
      const pad = (n) => String(n).padStart(2, '0');
      const timestamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
      const rangeTag = range.label.replace(/\s+/g, '');
      const ext = format === 'html' ? 'html' : 'md';
      const baseFilename = `${thread.slug}_${rangeTag}_${timestamp}.${ext}`;

      // 落项目 doc/exports/ (可选)
      let savedTo = null;
      if (String(req.query.saveToProject).toLowerCase() === 'true' && req.project.root_dir) {
        try {
          const dir = path.join(req.project.root_dir, 'doc', 'exports');
          fs.mkdirSync(dir, { recursive: true });
          const fp = path.join(dir, baseFilename);
          fs.writeFileSync(fp, body, 'utf8');
          savedTo = fp;
        } catch (e) {
          log.warn({ module: MOD, event: 'export_save_to_project_failed', error: e.message });
        }
      }

      const inline = String(req.query.inline).toLowerCase() === 'true';
      // 中文文件名 + Content-Disposition 要 RFC 5987 encode,否则浏览器乱码
      const encodedFn = encodeURIComponent(baseFilename);
      const contentType = format === 'html' ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8';
      res.set('Content-Type', contentType);
      if (!inline) {
        res.set('Content-Disposition', `attachment; filename="${encodedFn}"; filename*=UTF-8''${encodedFn}`);
      }
      if (savedTo) res.set('X-Mate-Saved-To', encodeURIComponent(savedTo));
      res.send(body);
    } catch (e) {
      log.error({ module: MOD, event: 'export_failed', error: e?.message || String(e) });
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/threads/:slug/message', requireProjectId, (req, res) => {
    const { text: rawText, targetInstance, clientMessageId, attachments } = req.body || {};
    if (typeof rawText !== 'string') return res.status(400).json({ error: 'text required' });
    if (!rawText.length && !(Array.isArray(attachments) && attachments.length)) {
      return res.status(400).json({ error: 'text or attachments required' });
    }
    // [需求@2026-07-22 #183] 处理 attachments —
    //   text (text/* + application/json/xml): base64 → utf8,<=100KB 内联到 text 消息尾;
    //                                          >100KB 落 <project>/.mate/uploads/<ts>/<name>
    //   image (image/*): base64 <=2MB(实际 base64 长度 <=2.8MB)→ 保留为 image content block
    //                    大图落盘,text 里写路径
    //   返 { textAugmented, imageBlocks, savedPaths }
    let text = rawText;
    let imageBlocks = [];
    let savedPaths = [];
    const TEXT_INLINE_LIMIT = 100 * 1024;     // 100KB decoded text
    const IMAGE_INLINE_LIMIT = 2 * 1024 * 1024; // 2MB decoded image
    if (Array.isArray(attachments) && attachments.length) {
      const path = require('path');
      const fs = require('fs');
      const uploadDir = path.join(req.project.root_dir, '.mate', 'uploads', String(Date.now()));
      let dirCreated = false;
      const ensureDir = () => {
        if (!dirCreated) { fs.mkdirSync(uploadDir, { recursive: true }); dirCreated = true; }
      };
      const inlineTextParts = [];
      for (const att of attachments) {
        const name = String(att?.name || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(0, 200);
        const mediaType = String(att?.mediaType || 'application/octet-stream');
        const b64 = String(att?.dataBase64 || '');
        if (!b64) continue;
        const isText = /^(text\/|application\/(json|xml|javascript|x-yaml|toml|x-sh))/i.test(mediaType);
        const isImage = /^image\//i.test(mediaType);
        let buf;
        try { buf = Buffer.from(b64, 'base64'); } catch (e) {
          inlineTextParts.push(`\n\n[附件 ${name}: base64 解码失败]`);
          continue;
        }
        if (isText) {
          if (buf.length <= TEXT_INLINE_LIMIT) {
            const content = buf.toString('utf8');
            const lang = /\.(json|jsonc)$/i.test(name) ? 'json'
              : /\.(md|markdown)$/i.test(name) ? 'markdown'
              : /\.(ya?ml)$/i.test(name) ? 'yaml'
              : /\.(js|mjs|cjs)$/i.test(name) ? 'javascript'
              : /\.(ts|tsx)$/i.test(name) ? 'typescript'
              : /\.py$/i.test(name) ? 'python'
              : /\.(sh|bash)$/i.test(name) ? 'bash'
              : '';
            inlineTextParts.push(`\n\n---\n**📎 附件: \`${name}\`** (${buf.length} bytes)\n\n\`\`\`${lang}\n${content}\n\`\`\``);
          } else {
            ensureDir();
            const fp = path.join(uploadDir, name);
            fs.writeFileSync(fp, buf);
            savedPaths.push(fp);
            inlineTextParts.push(`\n\n---\n**📎 附件(过大,已落盘)**: \`${fp}\` (${Math.round(buf.length / 1024)}KB, ${mediaType})\n用 Read tool 读取。`);
          }
        } else if (isImage) {
          if (buf.length <= IMAGE_INLINE_LIMIT) {
            imageBlocks.push({ mediaType, base64: b64 });
            inlineTextParts.push(`\n\n📎 图片附件: \`${name}\` (${Math.round(buf.length / 1024)}KB, ${mediaType}) — 直接看下面的 image`);
          } else {
            ensureDir();
            const fp = path.join(uploadDir, name);
            fs.writeFileSync(fp, buf);
            savedPaths.push(fp);
            inlineTextParts.push(`\n\n---\n**📎 大图附件(已落盘)**: \`${fp}\` (${Math.round(buf.length / 1024)}KB, ${mediaType})\n可用 Read tool 读取或让 mate-B 处理。`);
          }
        } else {
          // 其它类型统一落盘
          ensureDir();
          const fp = path.join(uploadDir, name);
          fs.writeFileSync(fp, buf);
          savedPaths.push(fp);
          inlineTextParts.push(`\n\n---\n**📎 附件(未知类型,已落盘)**: \`${fp}\` (${Math.round(buf.length / 1024)}KB, ${mediaType})`);
        }
      }
      text = text + inlineTextParts.join('');
    }
    try {
      // [需求@2026-06-12 §9.2] mateTerm 干预模式:targetInstance 指定 → 走 sendToThread 的指定路径
      if (targetInstance) {
        const result = spawnManager.sendToThread({
          projectId: req.project.id,
          projectRootDir: req.project.root_dir,
          threadSlug: req.params.slug,
          text,
          targetInstance,
          clientMessageId,
          imageBlocks: imageBlocks.length ? imageBlocks : null,
        });
        if (result?.deferred) {
          return res.json({ ok: true, deferred: true, pendingSendId: result.pendingSendId, reason: 'quota_pause', clientMessageId, savedPaths });
        }
        return res.json({ ok: true, instance: result.snapshot(), routedTo: result.role.name, mode: 'intervention', clientMessageId, savedPaths });
      }
      // [需求@2026-06-12 §6.2 Gap 1] 默认路由:依据 last_questioner_role_type(谁问送回谁)
      //   - has_pending_question 且 last_questioner_role_type='orchestrator' → 送给 H
      //   - has_pending_question 且 last_questioner_role_type='requirements' → 送给 R
      //   - 无 pending → 默认送 R(discussing 阶段 fresh thread)
      const ThreadStore = require('../threads/ThreadStore');
      const thread = ThreadStore.get(req.project.id, req.params.slug);
      let roleType = 'requirements';
      // [Phase 3.5 @2026-06-17] 路由优先用栈派生:栈顶 frame.status=blocked → 路由到该 frame 角色
      //   fallback 老 metadata 字段(向后兼容老 thread)
      let routedFromStack = false;
      try {
        const TCS = require('../threads/ThreadCallStack');
        const stack = TCS.load(req.project.id, req.params.slug);
        if (stack && !TCS.isEmpty(stack)) {
          const top = TCS.peek(stack);
          if (top?.status === TCS.FrameStatus.BLOCKED) {
            const roleMap = { R: 'requirements', H: 'orchestrator' };
            const rt = roleMap[top.role];
            if (rt) {
              roleType = rt;
              routedFromStack = true;
            }
          }
        }
      } catch (e) { /* fallback below */ }

      if (!routedFromStack && thread?.metadata?.has_pending_question && thread.metadata?.last_questioner_role_type) {
        // execB/testC 不直接问 user(它们的 question 已经走 handoff 到 H)
        // 所以这里 last_questioner_role_type 只可能是 'requirements' 或 'orchestrator'
        const lq = thread.metadata.last_questioner_role_type;
        if (lq === 'requirements' || lq === 'orchestrator') {
          roleType = lq;
        }
      }
      const result = spawnManager.sendToThread({
        projectId: req.project.id,
        projectRootDir: req.project.root_dir,
        threadSlug: req.params.slug,
        text,
        roleType,
        clientMessageId,
        imageBlocks: imageBlocks.length ? imageBlocks : null,
      });
      // [bug@2026-06-29 #170] quota PAUSED 时 sendToThread 返 {deferred:true, pendingSendId},
      //   不是 RoleInstance — 不能调 .snapshot(),否则 TypeError 让前端误以为发送失败。
      //   消息其实已经 enqueue 到 PendingSends,resume 后自动 flush。
      if (result?.deferred) {
        return res.json({
          ok: true, deferred: true,
          pendingSendId: result.pendingSendId,
          reason: 'quota_pause',
          clientMessageId,
          savedPaths,
        });
      }
      res.json({ ok: true, instance: result.snapshot(), routedTo: roleType, clientMessageId, savedPaths });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // [需求@2026-06-13 §18] 停止线索 — busy 的 instance(s) 走完整 kill 升级链
  //   (L1 stdin.end → L2 SIGTERM → L3 taskkill /F /T)。
  //   不删 thread,不删 messages;下次 user send 通过 lazy resurrection 起新 session。
  //   返回 killed list 让前端 ticker 提示具体翻了哪些 term。
  r.post('/threads/:slug/stop', requireProjectId, async (req, res) => {
    try {
      const thread = ThreadStore.get(req.project.id, req.params.slug);
      if (!thread) return res.status(404).json({ error: 'thread not found' });
      const bound = thread.metadata?.current_role_instances || {};
      const ids = [bound.requirements, bound.orchestrator, bound.executor, bound.validator].filter(Boolean);
      const killed = [];
      const skipped = [];
      for (const id of ids) {
        const inst = spawnManager.getInstance(id);
        if (!inst) { skipped.push({ id, reason: 'not-in-memory' }); continue; }
        if (inst.status === 'dead' || inst.status === 'disconnected') {
          skipped.push({ id, displayName: inst.displayName, reason: inst.status });
          continue;
        }
        if (inst.status !== 'busy' && inst.status !== 'spawning') {
          skipped.push({ id, displayName: inst.displayName, reason: 'idle' });
          continue;
        }
        try {
          const out = await spawnManager.killInstance(id);
          killed.push({ id, displayName: inst.displayName, level: out.level });
        } catch (e) {
          skipped.push({ id, displayName: inst.displayName, error: e.message });
        }
      }
      res.json({ ok: true, killed, skipped });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // [需求@2026-06-13] 重试派工 — 当 H 输出里包含 marker 但 MarkerDetector
  //   未识别(或老版本 mate bug)时,user 通过这个 endpoint 触发"事后重 parse + dispatch"。
  //   流程:
  //     1. 拿 thread 最近一条 result/* 事件
  //     2. 跑新版 MarkerDetector
  //     3. 找到 unrouted marker → 调用 SpawnManager._handleMarkers
  //   guard:不重复触发(若 thread.metadata.current_role_instances 已绑了 marker 的 target,跳过)
  r.post('/threads/:slug/retry-handoff', requireProjectId, async (req, res) => {
    try {
      const ThreadStore = require('../threads/ThreadStore');
      const MarkerDetector = require('../spawn/MarkerDetector');
      const thread = ThreadStore.get(req.project.id, req.params.slug);
      if (!thread) return res.status(404).json({ error: 'thread not found' });
      // 找最近 H 实例(designing/executing/testing 阶段都可能)
      const bound = thread.metadata?.current_role_instances || {};
      const candidateRoleIds = [bound.orchestrator, bound.executor, bound.validator, bound.requirements].filter(Boolean);
      if (!candidateRoleIds.length) return res.status(400).json({ error: 'no bound instances on this thread' });

      // 找最近一条 result event payload(从这些 instance 里挑最新的)
      const placeholders = candidateRoleIds.map(() => '?').join(',');
      const row = db.prepare(`
        SELECT ts, instance_id, payload_json FROM messages
        WHERE instance_id IN (${placeholders}) AND event_type LIKE 'result%'
        ORDER BY ts DESC LIMIT 1
      `).get(...candidateRoleIds);
      if (!row) return res.status(400).json({ error: 'no recent result event found for bound instances' });

      let payload;
      try { payload = JSON.parse(row.payload_json); } catch {
        return res.status(500).json({ error: 'payload parse failed' });
      }
      const text = payload.result || '';
      const markers = MarkerDetector.detect(text);
      if (!markers.length) {
        return res.status(400).json({ error: 'no markers detected in last result text', text_preview: text.slice(0, 200) });
      }

      // guard:如果 marker target 已经被 bind(派工已成功过),不重复触发
      const handoff = markers.find((m) => m.kind === 'handoff');
      if (handoff) {
        const { roleName: targetRoleName } = (() => {
          const m = String(handoff.target).match(/^([a-zA-Z][a-zA-Z0-9_-]*?)-(\d+)$/);
          const roleCatalog = require('../roles/RoleCatalog');
          if (m && roleCatalog.get(m[1])) return { roleName: m[1] };
          return { roleName: handoff.target };
        })();
        const roleCatalog = require('../roles/RoleCatalog');
        const targetRole = roleCatalog.get(targetRoleName);
        if (targetRole && bound[targetRole.type]) {
          return res.status(409).json({
            error: `marker target ${handoff.target} already routed — current_role_instances.${targetRole.type} = ${bound[targetRole.type]}`,
            hint: '该 marker 已被消费过;如果你想重新派工,请 user 在 thread 输入新需求让 H 重发',
          });
        }
      }

      // 找 fromInst:result event 来源
      const fromInst = spawnManager.getInstance(row.instance_id);
      if (!fromInst) return res.status(400).json({ error: `from instance ${row.instance_id} not found in memory` });

      // 异步触发,不阻塞 response
      setImmediate(() => spawnManager._handleMarkers(fromInst, markers));

      res.json({
        ok: true,
        replayedFrom: row.instance_id,
        markers: markers.map((m) => ({ kind: m.kind, target: m.target, reasonPreview: (m.reason || '').slice(0, 100) })),
        message: 'markers re-dispatched async',
      });
    } catch (e) {
      res.status(500).json({ error: e.message, stack: e.stack });
    }
  });

  // [需求@2026-07-20 #176 Layer 2] 线索解阻塞 — user 显式触发,处理"卡死"状态。
  //   Body: { action, targetInstanceId? }
  //     action='retry'      → 重发最后一次给 targetInstanceId 的 handoff prompt(未指定 target
  //                            则默认为栈顶帧)
  //     action='notify_h'   → 给绑定的 H 注入系统消息,告知下家已卡死,让 H 决策
  //     action='force_pop'  → 从栈 pop 掉 targetInstanceId 帧 + 追加合成 done seg +
  //                            给 caller(通常是 H)注入通知
  r.post('/threads/:slug/unstick', requireProjectId, async (req, res) => {
    const { action, targetInstanceId } = req.body || {};
    const validActions = ['retry', 'notify_h', 'force_pop'];
    if (!validActions.includes(action)) {
      return res.status(400).json({ error: `action must be one of ${validActions.join('/')}` });
    }
    try {
      const thread = ThreadStore.get(req.project.id, req.params.slug);
      if (!thread) return res.status(404).json({ error: 'thread not found' });
      // [bug@2026-07-20] 不用 db.call_stack_json —— MarkerDispatcher._updateStack 在
      //   appendDispatchChain 之前调用,导致 db 存的 stack 永远落后一段 chain
      //   (线索 t-mrkat70r-uher 实测:db 只有 [R,H],真实 stack 是 [R,H,B])。
      //   直接用 replayChain 从最新 chain 派生真实栈;顺便 save 回 db 修脏数据。
      const { replayChain } = require('../threads/replayChain');
      const TCS = require('../threads/ThreadCallStack');
      const sessionLookup = (id) => {
        if (!id) return null;
        try {
          const r = db.prepare('SELECT claude_session_id FROM role_instances WHERE id = ?').get(id);
          return r?.claude_session_id || null;
        } catch { return null; }
      };
      const replayed = replayChain(thread.metadata?.dispatch_chain || [], { lookupSessionId: sessionLookup });
      try { TCS.save(req.project.id, req.params.slug, replayed.stack); } catch (e) {
        log.warn({ module: MOD, event: 'unstick_stack_self_heal_failed', error: e.message });
      }
      const frames = replayed.stack.frames;
      if (!frames.length) return res.status(400).json({ error: 'stack empty — nothing to unstick' });

      // 默认 target = 栈顶帧
      const topFrame = frames[frames.length - 1];
      const stuckId = targetInstanceId || topFrame.instanceId;
      const stuckIdx = frames.findIndex((f) => f.instanceId === stuckId);
      if (stuckIdx < 0) return res.status(400).json({ error: `targetInstanceId ${stuckId} not in stack` });
      const stuckFrame = frames[stuckIdx];
      const stuckInst = spawnManager.getInstance(stuckId);

      // 找 caller(栈里 stuck 帧下方一层)+ 找最后一次派给 stuck 的 handoff seg(取 reason)
      const callerFrame = stuckIdx > 0 ? frames[stuckIdx - 1] : null;
      const chain = thread.metadata?.dispatch_chain || [];
      let lastHandoffToStuck = null;
      for (let i = chain.length - 1; i >= 0; i--) {
        if (chain[i].kind === 'handoff' && chain[i].toInstanceId === stuckId) {
          lastHandoffToStuck = chain[i];
          break;
        }
      }

      // ---------------- action=retry ----------------
      if (action === 'retry') {
        // [bug@2026-08-06 #201] stuckInst 不在 memory / 已 dead 时,不 404 —
        //   fallback:用 chain 里的 targetSpec + roleName 让 mate 走 pool 分配
        //   (自动 spawn 一个 fresh 的 role,slot 1)。老 dead 实例不复用。
        if (!lastHandoffToStuck) {
          return res.status(400).json({ error: `no handoff seg found for ${stuckId} in chain — cannot retry` });
        }
        // 如果 target 不在 memory 或 dead → 用 role type 派工,让 pool 分配
        if (!stuckInst || stuckInst.status === 'dead') {
          const roleName = lastHandoffToStuck.resolvedRole || lastHandoffToStuck.toRole;
          const roleCatalog = require('../roles/RoleCatalog');
          const role = roleCatalog.get(roleName);
          if (!role) return res.status(400).json({ error: `cannot determine role for retry (from chain seg toRole=${roleName})` });
          const anchorTs = (lastHandoffToStuck.ts || 0) - 5000;
          const row2 = db.prepare(`
            SELECT payload_json FROM messages
            WHERE instance_id = ? AND direction = 'user_to_role' AND thread_slug = ? AND ts >= ?
            ORDER BY ts ASC LIMIT 1
          `).get(stuckId, req.params.slug, anchorTs);
          if (!row2) return res.status(400).json({ error: 'no prior user_to_role prompt to reuse for retry' });
          let text2;
          try {
            const p = JSON.parse(row2.payload_json);
            const c = p?.message?.content;
            text2 = Array.isArray(c) ? c.filter((x) => x.type === 'text').map((x) => x.text).join('') : (typeof c === 'string' ? c : '');
          } catch { return res.status(500).json({ error: 'payload parse failed' }); }
          if (!text2) return res.status(400).json({ error: 'prior prompt no text' });
          text2 = text2.replace(/^\[Thread:\s*[^\]]+\]\n\n/, '');
          // 用 roleType + targetSlot(不指定 targetInstance)让 pool 分配 fresh
          const targetSlot = lastHandoffToStuck.resolvedSlot || stuckFrame.slot || null;
          const result2 = spawnManager.sendToThread({
            projectId: req.project.id,
            projectRootDir: req.project.root_dir,
            threadSlug: req.params.slug,
            text: text2,
            roleType: role.type,
            targetSlot,
            fromMarker: false,
          });
          if (result2?.deferred) {
            return res.json({ ok: true, action, deferred: true, pendingSendId: result2.pendingSendId, target: 'pool-spawned', hint: 'old dead inst replaced' });
          }
          return res.json({ ok: true, action, target: 'pool-spawned', displayName: result2?.displayName || 'new pool inst', resent: true, hint: `dead ${stuckId} replaced by fresh pool inst` });
        }
        // 用 chain handoff.ts 作为 anchor,找 ts >= anchor 的最早一条 user_to_role
        // (放宽 -5s 容忍 handoff record 和 message record 之间的微小时间偏差)
        const anchorTs = (lastHandoffToStuck.ts || 0) - 5000;
        const row = db.prepare(`
          SELECT payload_json, ts FROM messages
          WHERE instance_id = ? AND direction = 'user_to_role' AND thread_slug = ? AND ts >= ?
          ORDER BY ts ASC LIMIT 1
        `).get(stuckId, req.params.slug, anchorTs);
        if (!row) return res.status(400).json({ error: `no user_to_role message at/after chain handoff ts to retry` });
        let text;
        try {
          const p = JSON.parse(row.payload_json);
          const content = p?.message?.content;
          text = Array.isArray(content)
            ? content.filter((c) => c.type === 'text').map((c) => c.text).join('')
            : (typeof content === 'string' ? content : '');
        } catch { return res.status(500).json({ error: 'payload parse failed' }); }
        if (!text) {
          return res.status(400).json({
            error: `handoff prompt not found (msg at ${new Date(row.ts).toISOString()} has no text content — likely tool_result)`,
            hint: 'chain handoff ts anchor may be off by more than 5s, or handoff message was purged',
          });
        }
        text = text.replace(/^\[Thread:\s*[^\]]+\]\n\n/, '');

        const result = spawnManager.sendToThread({
          projectId: req.project.id,
          projectRootDir: req.project.root_dir,
          threadSlug: req.params.slug,
          text,
          targetInstance: stuckId,
          fromMarker: false,
        });
        if (result?.deferred) {
          return res.json({ ok: true, action, deferred: true, pendingSendId: result.pendingSendId, target: stuckId });
        }
        return res.json({ ok: true, action, target: stuckId, displayName: stuckInst.displayName, resent: true });
      }

      // ---------------- action=notify_h ----------------
      if (action === 'notify_h') {
        // 找栈里最近一层 H frame(通常是 caller,若栈顶就是 H 则通知栈顶)
        let hFrame = null;
        for (let i = frames.length - 1; i >= 0; i--) {
          if (frames[i].role === 'H') { hFrame = frames[i]; break; }
        }
        if (!hFrame) return res.status(400).json({ error: 'no H frame in stack to notify' });
        const hInst = spawnManager.getInstance(hFrame.instanceId);
        if (!hInst) return res.status(404).json({ error: `H instance ${hFrame.instanceId} not in memory` });

        const stuckDisplay = stuckInst?.displayName || stuckId;
        const stuckSince = new Date(stuckFrame.lastActivityAt || stuckFrame.pushedAt).toISOString();
        const reasonPreview = (lastHandoffToStuck?.reason || '').slice(0, 500);
        const injectText = `下派给 ${stuckDisplay}(${stuckId})的任务已卡死,自 ${stuckSince} 起无进展。可能原因:mid-turn 429 / session limit / 逻辑卡壳。

${reasonPreview ? `原 handoff reason:\n${reasonPreview}` : '(未找到原 handoff reason)'}

请决策下一步:
  (a) 重新派工同一 delegate(可缩小任务范围)
  (b) 换 slot 或换 role 派工
  (c) 上报 R,由 user 决策是否继续`;

        const tag = 'system:mate-operator';
        const wrapped = `<${tag}>
${injectText}

**这是 mate 系统注入,不是 user 输入。你可以直接决策 / 执行 / handoff,不必回复"收到"或等 user 确认。**
</${tag}>`;

        const result = spawnManager.sendToThread({
          projectId: req.project.id,
          projectRootDir: req.project.root_dir,
          threadSlug: req.params.slug,
          text: wrapped,
          targetInstance: hFrame.instanceId,
          fromMarker: false,
        });
        if (result?.deferred) {
          return res.json({ ok: true, action, deferred: true, pendingSendId: result.pendingSendId, target: hFrame.instanceId });
        }
        return res.json({
          ok: true, action, notifiedH: hFrame.instanceId, hDisplayName: hInst.displayName,
          stuckTarget: stuckId, stuckDisplayName: stuckDisplay,
        });
      }

      // ---------------- action=force_pop ----------------
      if (action === 'force_pop') {
        const TCS = require('../threads/ThreadCallStack');
        // 1. pop stuck 帧及以上所有帧
        const popped = frames.splice(stuckIdx);
        TCS.save(req.project.id, req.params.slug, { frames });
        // 2. 追加合成 done seg(标注 forced,非 terminal)
        const isTerminal = frames.length === 0 || frames[frames.length - 1].role === 'R';
        try {
          const updated = ThreadStore.appendDispatchChain(req.project.id, req.params.slug, {
            kind: 'done',
            fromRole: stuckFrame.role === 'R' ? 'mate-R' : stuckFrame.role === 'H' ? 'mate-H' : stuckFrame.role === 'B' ? 'mate-B' : 'mate-C',
            fromInstanceId: stuckId,
            summary: `[operator force-pop] frame popped due to stuck state`,
            callerInstanceId: callerFrame?.instanceId || null,
            isTerminal,
            forced: true,
          });
          const bus = require('../messageBus');
          bus.publish('dispatch.chain_updated', {
            projectId: req.project.id,
            threadSlug: req.params.slug,
            chain: updated?.metadata?.dispatch_chain || [],
          });
        } catch (e) {
          log.warn({ module: MOD, event: 'unstick_force_pop_chain_append_failed', error: e.message });
        }
        // 3. 若栈非空且顶层是 role != R 的 caller,注入通知让它决策
        let notifiedCaller = null;
        if (callerFrame && callerFrame.role !== 'R') {
          const callerInst = spawnManager.getInstance(callerFrame.instanceId);
          if (callerInst) {
            const stuckDisplay = stuckInst?.displayName || stuckId;
            const tag = 'system:mate-operator';
            const wrapped = `<${tag}>
你下派给 ${stuckDisplay}(${stuckId})的任务被 operator 强制 pop(卡死状态)。栈已回退到你这一层。

请决策下一步:重新派工 / 换 delegate / 上报 R。

**这是 mate 系统注入,不是 user 输入。**
</${tag}>`;
            try {
              spawnManager.sendToThread({
                projectId: req.project.id,
                projectRootDir: req.project.root_dir,
                threadSlug: req.params.slug,
                text: wrapped,
                targetInstance: callerFrame.instanceId,
                fromMarker: false,
              });
              notifiedCaller = callerFrame.instanceId;
            } catch (e) {
              log.warn({ module: MOD, event: 'unstick_force_pop_notify_caller_failed', error: e.message });
            }
          }
        }
        // 4. 若栈空 or 顶层是 R,清 outcome(避免脏 verified 阻挡后续 done 处理)
        if (frames.length === 0) {
          try {
            db.prepare(`UPDATE threads SET outcome = NULL WHERE project_id = ? AND slug = ?`)
              .run(req.project.id, req.params.slug);
          } catch {}
        }
        return res.json({
          ok: true, action, popped: popped.length,
          poppedFrames: popped.map((f) => ({ role: f.role, instanceId: f.instanceId })),
          notifiedCaller,
          stackDepth: frames.length,
        });
      }

      return res.status(400).json({ error: `unhandled action ${action}` });
    } catch (e) {
      res.status(500).json({ error: e.message, stack: e.stack });
    }
  });

  // ============================== B2: FTS5 全文检索 ==============================
  // [需求@2026-06-16] GET /api/search?q=<text>&projectId=N&threadSlug=xx&eventType=type&limit=50
  //   FTS5 MATCH 查询(unicode61 分词);返回带 snippet 高亮
  r.get('/search', (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);
    const projectId = req.query.projectId ? parseInt(req.query.projectId, 10) : null;
    const threadSlug = req.query.threadSlug || null;
    const eventType = req.query.eventType || null;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);

    // [2026-06-16] hybrid 策略:
    //   - query >= 3 字符 → FTS5 MATCH(快,trigram 索引)
    //   - query < 3 字符  → LIKE 全表扫(慢但准,trigram 索引最小单位 3 字符)
    //   - 查询字符串包含 -, :, " 等 FTS5 特殊字符 → 用 phrase 形式 "..." 包装
    const useFts = q.length >= 3;
    let sql;
    const params = [];

    if (useFts) {
      // FTS5 phrase 形式自动 escape:把 q 里的双引号转义,然后用 " 包整段
      const ftsQ = '"' + q.replace(/"/g, '""') + '"';
      sql = `
        SELECT m.id, m.project_id, m.thread_slug, m.instance_id, m.role_name,
               m.ts, m.event_type, m.direction,
               snippet(messages_fts, 0, '<mark>', '</mark>', '...', 16) AS snippet
        FROM messages_fts
        JOIN messages m ON m.id = messages_fts.rowid
        WHERE messages_fts MATCH ?
      `;
      params.push(ftsQ);
    } else {
      // LIKE fallback:短 query(包括 2 字中文)用 payload_json LIKE
      const likeQ = '%' + q.replace(/[%_]/g, '\\$&') + '%';
      sql = `
        SELECT m.id, m.project_id, m.thread_slug, m.instance_id, m.role_name,
               m.ts, m.event_type, m.direction,
               substr(m.payload_json, 1, 200) AS snippet
        FROM messages m
        WHERE m.payload_json LIKE ? ESCAPE '\\\\'
      `;
      params.push(likeQ);
    }

    if (projectId) { sql += ` AND m.project_id = ?`; params.push(projectId); }
    if (threadSlug) { sql += ` AND m.thread_slug = ?`; params.push(threadSlug); }
    if (eventType && eventType !== 'all') { sql += ` AND m.event_type = ?`; params.push(eventType); }
    sql += ` ORDER BY m.ts DESC LIMIT ?`;
    params.push(limit);

    try {
      const rows = db.prepare(sql).all(...params);
      // 加 thread.title 给 UI 显得友好
      const ProjectStore2 = require('../projects/ProjectStore');
      const projectsCache = new Map();
      const threadsCache = new Map();
      const enriched = rows.map((row) => {
        let projectName = projectsCache.get(row.project_id);
        if (projectName === undefined) {
          const p = ProjectStore2.get(row.project_id);
          projectName = p?.name || `#${row.project_id}`;
          projectsCache.set(row.project_id, projectName);
        }
        const tKey = `${row.project_id}::${row.thread_slug}`;
        let threadTitle = threadsCache.get(tKey);
        if (threadTitle === undefined && row.thread_slug) {
          const t = ThreadStore.get(row.project_id, row.thread_slug);
          threadTitle = t?.title || row.thread_slug;
          threadsCache.set(tKey, threadTitle);
        }
        return {
          id: row.id,
          projectId: row.project_id,
          projectName,
          threadSlug: row.thread_slug,
          threadTitle: threadTitle || row.thread_slug,
          instanceId: row.instance_id,
          roleName: row.role_name,
          ts: row.ts,
          eventType: row.event_type,
          direction: row.direction,
          snippet: row.snippet,
        };
      });
      res.json(enriched);
    } catch (e) {
      res.status(400).json({ error: `search failed: ${e.message}` });
    }
  });

  // ============================== Phase 2G Queue + Backlog ==============================
  // [需求@2026-06-15] busy 派工三选一 + cancel/dispatch backlog + 列表查询
  //   设计 doc:docs/discussions/2026-06-15-queue-arch.md

  const QueueDispatcher = require('../spawn/QueueDispatcher');
  const PendingSends = require('../spawn/PendingSends');

  // POST /api/dispatch/:id/choose  body: { choice: 'wait'|'backlog'|'cancel' }
  //   user 在 dispatch.busy_prompt 上选了什么
  r.post('/dispatch/:id/choose', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid pending send id' });
    const { choice } = req.body || {};
    if (!['wait', 'backlog', 'cancel'].includes(choice)) {
      return res.status(400).json({ error: 'choice must be wait | backlog | cancel' });
    }
    try {
      const r2 = await QueueDispatcher.handleUserChoice(id, choice, {
        dispatchCb: spawnManager._queueDispatchCb,
      });
      res.json(r2);
    } catch (e) {
      res.status(e.message.includes('not found') ? 404 : 400).json({ error: e.message });
    }
  });

  // POST /api/queue/:id/cancel  — cancel queued 项
  r.post('/queue/:id/cancel', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid pending send id' });
    const { reason } = req.body || {};
    try {
      QueueDispatcher.cancelQueued(id, reason || 'user-cancel');
      res.json({ ok: true, pendingSendId: id });
    } catch (e) {
      res.status(e.message.includes('not found') ? 404 : 400).json({ error: e.message });
    }
  });

  // [需求@2026-08-07 UI1] POST /api/queue/:id/dispatch — queued 状态强制 flush 该条(跳队)
  //   用途:ps stuck queued 太久(idle 事件没触发 / race 漏),用户手动 kick
  r.post('/queue/:id/dispatch', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid pending send id' });
    try {
      const row = await QueueDispatcher.forceDispatch(id, {
        dispatchCb: spawnManager._queueDispatchCb,
      });
      res.json({ ok: true, dispatched: true, pendingSendId: id, targetId: row.targetId });
    } catch (e) {
      res.status(e.message.includes('not found') ? 404 : 400).json({ error: e.message });
    }
  });

  // POST /api/backlog/:id/dispatch — backlog → queued + 立即 flush
  r.post('/backlog/:id/dispatch', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid pending send id' });
    try {
      const r2 = await QueueDispatcher.dispatchBacklog(id, {
        dispatchCb: spawnManager._queueDispatchCb,
      });
      res.json({ ok: true, dispatched: !!r2, pendingSendId: id });
    } catch (e) {
      res.status(e.message.includes('not found') ? 404 : 400).json({ error: e.message });
    }
  });

  // POST /api/backlog/:id/cancel — 同 queue cancel(allows backlog/queued/waiting_user)
  r.post('/backlog/:id/cancel', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid pending send id' });
    const { reason } = req.body || {};
    try {
      QueueDispatcher.cancelQueued(id, reason || 'user-cancel');
      res.json({ ok: true, pendingSendId: id });
    } catch (e) {
      res.status(e.message.includes('not found') ? 404 : 400).json({ error: e.message });
    }
  });

  // GET /api/queue  — 列所有 pending 项(状态 queued / backlog / waiting_user)
  //   可选 filter:?projectId=N&threadSlug=xx&status=queued|backlog|waiting_user|all
  r.get('/queue', (req, res) => {
    const status = req.query.status || 'all';
    const projectIdRaw = req.query.projectId;
    const threadSlug = req.query.threadSlug;
    let rows;
    if (status === 'all') {
      rows = PendingSends.listAll().filter(
        (r2) => ['queued', 'backlog', 'waiting_user', 'processing'].includes(r2.status)
      );
    } else {
      rows = PendingSends.listByStatus(status);
    }
    if (projectIdRaw) {
      const pid = parseInt(projectIdRaw, 10);
      rows = rows.filter((r2) => r2.projectId === pid);
    }
    if (threadSlug) {
      rows = rows.filter((r2) => r2.threadSlug === threadSlug);
    }
    res.json(rows);
  });

  // GET /api/queue/:id — 单条详情
  r.get('/queue/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid pending send id' });
    const row = PendingSends.getById(id);
    if (!row) return res.status(404).json({ error: 'pending send not found' });
    res.json(row);
  });

  return r;
}

module.exports = { buildRouter };
