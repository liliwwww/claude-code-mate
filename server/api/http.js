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
      console.error('[buildRouter] testApi mount failed:', e.message);
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
    const byReason = PendingSends.countByReason();
    const pendingByTarget = (projectId ? PendingSends.listByProject(projectId) : PendingSends.listAll())
      .reduce((acc, p) => {
        const key = `${p.targetKind}:${p.targetId}`;
        if (!acc[key]) acc[key] = { targetKind: p.targetKind, targetId: p.targetId, n: 0, latestEnqueuedAt: 0 };
        acc[key].n++;
        if (p.enqueuedAt > acc[key].latestEnqueuedAt) acc[key].latestEnqueuedAt = p.enqueuedAt;
        return acc;
      }, {});
    const pending = {
      total: projectId ? PendingSends.countByProject(projectId) : PendingSends.count(),
      byReason,
      byTarget: Object.values(pendingByTarget),
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
      const inst = spawnManager.sendDirectToInstance(req.params.id, text, { clientMessageId });
      res.json({ ok: true, instance: inst.snapshot(), mode: 'direct', clientMessageId });
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
      rows = db.prepare(`
        SELECT id, instance_id, role_name, direction, claude_session_id, ts, event_type, payload_json
        FROM messages
        WHERE project_id = ? AND thread_slug = ?
        ORDER BY ts ASC, id ASC
        LIMIT ?
      `).all(req.project.id, req.params.slug, limit);
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

  r.post('/threads/:slug/message', requireProjectId, (req, res) => {
    const { text, targetInstance, clientMessageId } = req.body || {};
    if (typeof text !== 'string' || !text.length) return res.status(400).json({ error: 'text required' });
    try {
      // [需求@2026-06-12 §9.2] mateTerm 干预模式:targetInstance 指定 → 走 sendToThread 的指定路径
      if (targetInstance) {
        const inst = spawnManager.sendToThread({
          projectId: req.project.id,
          projectRootDir: req.project.root_dir,
          threadSlug: req.params.slug,
          text,
          targetInstance,
          clientMessageId,
        });
        return res.json({ ok: true, instance: inst.snapshot(), routedTo: inst.role.name, mode: 'intervention', clientMessageId });
      }
      // [需求@2026-06-12 §6.2 Gap 1] 默认路由:依据 last_questioner_role_type(谁问送回谁)
      //   - has_pending_question 且 last_questioner_role_type='orchestrator' → 送给 H
      //   - has_pending_question 且 last_questioner_role_type='requirements' → 送给 R
      //   - 无 pending → 默认送 R(discussing 阶段 fresh thread)
      const ThreadStore = require('../threads/ThreadStore');
      const thread = ThreadStore.get(req.project.id, req.params.slug);
      let roleType = 'requirements';
      if (thread?.metadata?.has_pending_question && thread.metadata?.last_questioner_role_type) {
        // execB/testC 不直接问 user(它们的 question 已经走 handoff 到 H)
        // 所以这里 last_questioner_role_type 只可能是 'requirements' 或 'orchestrator'
        const lq = thread.metadata.last_questioner_role_type;
        if (lq === 'requirements' || lq === 'orchestrator') {
          roleType = lq;
        }
      }
      const inst = spawnManager.sendToThread({
        projectId: req.project.id,
        projectRootDir: req.project.root_dir,
        threadSlug: req.params.slug,
        text,
        roleType,
        clientMessageId,
      });
      res.json({ ok: true, instance: inst.snapshot(), routedTo: roleType, clientMessageId });
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
