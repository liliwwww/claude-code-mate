// REST endpoints. Phase 2A: project-aware.
//
// [需求@2026-06-10] 多 project 支持:list/spawn/etc 都按 ?projectId=N 隔离。
// projectId 验证 + active project state 由前端通过 localStorage 维护,后端 stateless。

const express = require('express');
const roleCatalog = require('../roles/RoleCatalog');
const spawnManager = require('../spawn/SpawnManager');
const ProjectStore = require('../projects/ProjectStore');
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

  return r;
}

module.exports = { buildRouter };
