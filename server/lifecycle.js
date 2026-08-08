// ============================================================================
// MODULE CONTRACT
// ----------------------------------------------------------------------------
// 层:L5 Bootstrap 辅助
// 责任:mate 进程生命周期管理 — 硬关(SIGTERM/uncaught)+ graceful 关(UI 触发)
//   API 层可以通过 gracefulShutdown() 请求"等 busy 完成再关"。
// 公共 API:
//   registerServer(httpServer)     — index.js 启动后注册,让 lifecycle 拿到 server
//   shutdown(reason)               — 硬关(不等 busy)
//   gracefulShutdown({reason, timeoutMs, onProgress}) — 等 busy 完成后关
//   isShuttingDown()               — 让别的模块可以 check 是否正在关
// 允许依赖:messageBus / spawnManager / QuotaState / ConsistencyCheck / Supervisor / logger
// 禁止:业务判断
// ============================================================================
//
// [需求@2026-08-08 Phase 2b] Graceful shutdown

const log = require('./logger');
const MOD = 'lifecycle';

let _server = null;
let _shuttingDown = false;
let _gracefulActive = null;   // { reason, startTs, timeoutMs, resolve, reject } — 单例

function registerServer(server) {
  _server = server;
}

function isShuttingDown() {
  return _shuttingDown;
}

async function _doHardShutdown(reason) {
  console.log(`[shutdown] reason: ${reason}`);
  _shuttingDown = true;
  try {
    require('./quota/QuotaState').stop();
    require('./spawn/ConsistencyCheck').stop();
    require('./supervisor').stop();
    await require('./spawn/SpawnManager').shutdown();
  } catch (e) {
    log.error({ module: 'shutdown', event: 'component_stop_failed', error: e?.message || String(e) });
  }
  if (_server) {
    _server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  } else {
    process.exit(0);
  }
}

/**
 * 硬关 — 用于 SIGINT/SIGTERM/uncaughtException
 */
function shutdown(reason) {
  if (_shuttingDown) return;
  _doHardShutdown(reason);
}

/**
 * 优雅关 — 等 busy insts 都 idle 再关(超时兜底硬关)
 *
 * @param {Object} opts
 * @param {string} opts.reason
 * @param {number} opts.timeoutMs — 最长等多久(默认 30s),超时强制硬关
 * @param {Function} opts.onProgress — 每秒回调 { busyCount, elapsedMs }
 * @returns {Promise<{completed: boolean, timedOut: boolean, finalBusyCount: number, elapsedMs: number}>}
 */
async function gracefulShutdown({ reason = 'graceful_shutdown', timeoutMs = 30_000, onProgress } = {}) {
  if (_shuttingDown) {
    return { completed: false, timedOut: false, finalBusyCount: 0, elapsedMs: 0, alreadyRunning: true };
  }
  if (_gracefulActive) {
    return { ..._gracefulActive.status, alreadyRunning: true };
  }
  _shuttingDown = true;   // 标记后:HTTP 层可以 check 拒绝新消息

  const spawnManager = require('./spawn/SpawnManager');
  const startTs = Date.now();
  log.info({ module: MOD, event: 'graceful_shutdown_started', reason, timeoutMs });
  try { require('./messageBus').publish('system.graceful_shutdown_started', { reason, timeoutMs, startTs }); } catch {}

  let busyCount = 0;
  let elapsedMs = 0;
  while (true) {
    const insts = Array.from(spawnManager.instances?.values?.() || []);
    busyCount = insts.filter((i) => i.status === 'busy' || i.status === 'spawning').length;
    elapsedMs = Date.now() - startTs;

    if (onProgress) {
      try { onProgress({ busyCount, elapsedMs }); } catch {}
    }
    try { require('./messageBus').publish('system.graceful_shutdown_progress', { busyCount, elapsedMs, timeoutMs }); } catch {}

    if (busyCount === 0) {
      log.info({ module: MOD, event: 'graceful_shutdown_all_idle', elapsedMs });
      await _doHardShutdown(reason + ':graceful_all_idle');
      return { completed: true, timedOut: false, finalBusyCount: 0, elapsedMs };
    }
    if (elapsedMs >= timeoutMs) {
      log.warn({ module: MOD, event: 'graceful_shutdown_timeout', busyCount, elapsedMs });
      await _doHardShutdown(reason + ':timeout_forced');
      return { completed: true, timedOut: true, finalBusyCount: busyCount, elapsedMs };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

module.exports = {
  registerServer,
  shutdown,
  gracefulShutdown,
  isShuttingDown,
};
