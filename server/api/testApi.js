// ============================================================================
// MODULE CONTRACT(RFC: docs/discussions/2026-06-16-stack-model-rfc.md E2E)
// ----------------------------------------------------------------------------
// 层:L4 HTTP API(test 专用,生产模式 disabled)
// 责任:E2E 测试的注入和检查接口
//   - POST /api/_test/scripts/:role          注入 mock 角色脚本
//   - GET  /api/_test/scripts                看所有 registry 脚本
//   - DELETE /api/_test/scripts              清空 registry,恢复 defaults
//   - GET  /api/_test/state                  看完整测试态(实例/栈/池)
//   - POST /api/_test/scripts/instance/:id   per-instance 脚本(优先 registry)
//
// 安全:
//   - 只在 MATE_MOCK_TERMS=1 时挂载,生产模式 router 不挂这些路由
//   - 任何接口被生产模式 user 误触 → 404
// ============================================================================

const USE_MOCK_TERMS = process.env.MATE_MOCK_TERMS === '1';

function mountTestApi(router, { spawnManager }) {
  if (!USE_MOCK_TERMS) {
    // 生产模式 — 一律 404
    router.all('/_test/*', (req, res) => {
      res.status(404).json({ error: 'test API only available in MATE_MOCK_TERMS=1 mode' });
    });
    return;
  }

  const MockMod = require('../spawn/MockRoleInstance');

  // POST /api/_test/scripts/:role  body: { scripts: [{ match, emit }, ...] }
  // match 可以是字符串(includes)或正则 source 字符串(以 / 开头结尾)
  router.post('/_test/scripts/:role', (req, res) => {
    const { role } = req.params;
    const { scripts } = req.body || {};
    if (!Array.isArray(scripts)) {
      return res.status(400).json({ error: 'scripts must be array' });
    }
    try {
      const compiled = scripts.map((s) => ({
        match: _compileMatch(s.match),
        emit: s.emit || [],
      }));
      MockMod.setRegistryScript(role, compiled);
      res.json({ ok: true, role, scripts: compiled.length });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // GET /api/_test/scripts
  router.get('/_test/scripts', (req, res) => {
    const reg = MockMod.getRegistry();
    // serialize: RegExp → /pattern/
    const out = {};
    for (const [role, scripts] of Object.entries(reg)) {
      out[role] = scripts.map((s) => ({
        match: s.match instanceof RegExp ? s.match.source : String(s.match),
        emit: s.emit,
      }));
    }
    res.json(out);
  });

  // DELETE /api/_test/scripts  → reset to defaults
  router.delete('/_test/scripts', (req, res) => {
    MockMod.resetRegistry();
    res.json({ ok: true });
  });

  // POST /api/_test/scripts/instance/:id  body: { scripts: [...] }
  router.post('/_test/scripts/instance/:id', (req, res) => {
    const inst = spawnManager.getInstance(req.params.id);
    if (!inst) return res.status(404).json({ error: 'instance not found' });
    if (typeof inst.setResponseScript !== 'function') {
      return res.status(400).json({ error: 'instance is not a mock' });
    }
    const { scripts } = req.body || {};
    if (!Array.isArray(scripts)) return res.status(400).json({ error: 'scripts must be array' });
    const compiled = scripts.map((s) => ({
      match: _compileMatch(s.match),
      emit: s.emit || [],
    }));
    inst.setResponseScript(compiled);
    res.json({ ok: true, instanceId: inst.id, scripts: compiled.length });
  });

  // GET /api/_test/state  → 测试态全景(给断言用)
  router.get('/_test/state', (req, res) => {
    const insts = spawnManager.listInstances(null, { includeDead: true });
    const ProjectStore = require('../projects/ProjectStore');
    const { db } = require('../db');
    const SlotPool = require('../spawn/SlotPool');

    const threads = db.prepare(`SELECT slug, project_id, stage, outcome, call_stack_json, metadata_json FROM threads`).all();
    const threadsWithStack = threads.map((t) => {
      let stack = null;
      try { stack = JSON.parse(t.call_stack_json || 'null'); } catch {}
      let metadata = null;
      try { metadata = JSON.parse(t.metadata_json || '{}'); } catch {}
      return {
        slug: t.slug,
        projectId: t.project_id,
        stage: t.stage,
        outcome: t.outcome,
        stack,
        hasChain: !!(metadata?.dispatch_chain?.length),
        chainLength: metadata?.dispatch_chain?.length || 0,
        // [需求@2026-06-19 #162 回归] 暴露 chain 末段,断言 R 是否真收到 delegate-done
        lastChainSeg: metadata?.dispatch_chain?.slice(-1)?.[0] || null,
      };
    });

    res.json({
      mockMode: true,
      // listInstances 已返回 snapshot 对象,不需要再调 .snapshot()
      instances: insts,
      threads: threadsWithStack,
      slotPools: SlotPool.snapshotAll(),
      projects: ProjectStore.list(),
    });
  });

  // POST /api/_test/enable-dispatch-log  body: { projectId } — 开启该 project 的派工文件落盘
  router.post('/_test/enable-dispatch-log', (req, res) => {
    const { projectId } = req.body || {};
    if (!projectId) return res.status(400).json({ error: 'projectId required' });
    const { db } = require('../db');
    try {
      db.prepare(`UPDATE projects SET dispatch_log_enabled = 1 WHERE id = ?`).run(projectId);
      res.json({ ok: true, projectId });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/_test/reset  → DB 清空 + 杀所有 mock 实例(不删表,只清行)
  router.post('/_test/reset', async (req, res) => {
    const config = require('../config');
    if (!/test|tmp|sandbox/i.test(config.paths.sqlite)) {
      return res.status(403).json({ error: 'reset 仅允许测试 DB (path 必须含 test/tmp/sandbox)' });
    }

    // 1. 杀所有内存里的 mock 实例,防止 setTimeout 延迟 fire 走野
    const insts = spawnManager.listInstances(null, { includeDead: true });
    for (const isnap of insts) {
      const i = spawnManager.getInstance(isnap.id);
      if (!i) continue;
      try {
        if (typeof i.kill === 'function') await i.kill();
      } catch {}
    }
    // 清 SpawnManager 内部 map(spawnManager.instances 是 public Map)
    if (spawnManager.instances?.clear) spawnManager.instances.clear();

    // 2. 清 DB
    const { db } = require('../db');
    const tables = ['messages', 'role_instances', 'dispatches', 'events', 'threads', 'mate_pending_sends'];
    for (const t of tables) {
      try { db.prepare(`DELETE FROM ${t}`).run(); } catch {}
    }
    // 3. 清 SlotPool 内存态
    try { require('../spawn/SlotPool').clearAllPools(); } catch {}
    // 4. scripts 恢复默认
    MockMod.resetRegistry();
    res.json({ ok: true, cleared: tables, killedInstances: insts.length });
  });
}

function _compileMatch(m) {
  if (typeof m === 'string') {
    // /pat/flags 形式 → RegExp
    const re = m.match(/^\/(.+)\/([gimsuy]*)$/);
    if (re) return new RegExp(re[1], re[2]);
    return m; // plain string, MockRoleInstance 用 includes
  }
  if (m instanceof RegExp) return m;
  if (m === undefined || m === null) return /.*/;
  return /.*/;
}

module.exports = { mountTestApi };
