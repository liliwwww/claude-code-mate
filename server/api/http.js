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

  r.get('/instances/:id/history', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
    const rows = db.prepare(`
      SELECT id, instance_id, role_name, direction, claude_session_id, ts, event_type, payload_json
      FROM messages
      WHERE instance_id = ?
      ORDER BY ts ASC
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

  r.get('/threads/:slug/history', requireProjectId, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 2000);
    const rows = db.prepare(`
      SELECT id, instance_id, role_name, direction, claude_session_id, ts, event_type, payload_json
      FROM messages
      WHERE project_id = ? AND thread_slug = ?
      ORDER BY ts ASC
      LIMIT ?
    `).all(req.project.id, req.params.slug, limit);
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
    const { text } = req.body || {};
    if (typeof text !== 'string' || !text.length) return res.status(400).json({ error: 'text required' });
    try {
      // [需求@2026-06-12 §6.2 Gap 1] 路由依据 last_questioner_role_type(谁问送回谁)
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
      });
      res.json({ ok: true, instance: inst.snapshot(), routedTo: roleType });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  return r;
}

module.exports = { buildRouter };
