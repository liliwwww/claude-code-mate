// Backend entrypoint. Bootstraps config, db, role catalog, spawn manager,
// HTTP server, REST router, WebSocket attach, and graceful shutdown.

const express = require('express');
const http = require('node:http');
const path = require('node:path');

const config = require('./config');
const roleCatalog = require('./roles/RoleCatalog');
const spawnManager = require('./spawn/SpawnManager');
const { buildRouter } = require('./api/http');
const { attach: attachWs } = require('./api/ws');

// Bootstrap
roleCatalog.load();
console.log('[boot] roles loaded:', roleCatalog.list().map((r) => `${r.name}(${r.type})`).join(', '));
spawnManager.restoreFromDisk();
// [需求@2026-06-12 §8.10] 后台 TTL 扫描:idle 太久的实例 emit warn 事件
spawnManager.startTtlScanner();
// [需求@2026-06-12 Phase 2E §6] QuotaState 启动 — 恢复持久化状态 + setTimer + cron
const QuotaState = require('./quota/QuotaState');
QuotaState.start();

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(config.paths.public));
app.use('/api', buildRouter());

// Banner endpoint (proxy / warnings + Default project id for first-time bootstrap)
// [需求@2026-06-10] 前端启动时从这里拿 Default project id,避免 hard-code
app.get('/api/system', (req, res) => {
  const ProjectStore = require('./projects/ProjectStore');
  const defaultProject = ProjectStore.getByName('Default');
  res.json({
    version: require('../package.json').version,
    port: config.port,
    httpProxy: config.httpProxy || null,
    warnings: config.warnings || [],
    defaultSessionTtlHours: config.defaultSessionTtlHours,
    defaultProjectId: defaultProject?.id ?? 1,
    // [需求@2026-06-12 §8.10] 让 UI 知道全局 cap 阈值,显示"N/16"红条
    globalMaxClaudeProcesses: config.globalMaxClaudeProcesses,
  });
});

const server = http.createServer(app);
attachWs(server);

server.listen(config.port, '127.0.0.1', () => {
  console.log(`[boot] listening on http://127.0.0.1:${config.port}`);
  if (config.warnings.length) {
    console.warn('[boot] warnings:');
    for (const w of config.warnings) console.warn('  -', w);
  }
});

// Graceful shutdown
async function shutdown(reason) {
  console.log(`[shutdown] reason: ${reason}`);
  try {
    QuotaState.stop();
    await spawnManager.shutdown();
  } catch (e) {
    console.error('[shutdown] spawnManager.shutdown error:', e);
  }
  server.close(() => process.exit(0));
  // Hard exit after 5s if server.close hangs
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => { console.error('uncaught:', e); shutdown('uncaughtException'); });
