// ============================================================================
// MODULE CONTRACT
// ----------------------------------------------------------------------------
// 层:L0 Infra
// 责任:结构化日志输出。替换散乱的 console.warn/error/log,统一格式便于 grep
//   统计 bug 频率(backlog X3)。
// 公共 API:info() / warn() / error() / debug() — 均接受 (ctx, msg?)
// 允许依赖:无(纯 stdout/stderr 输出)
// 禁止:
//   - 落盘(events 表由 recordEvent 负责,logger 只管控制台)
//   - 阻塞 IO
// ============================================================================
//
// [需求@2026-08-06 X3] 结构化 logger。
//
// 用法:
//   const log = require('./logger');
//   log.warn({ module: 'SpawnManager', event: 'flush_failed', pendingSendId: 42, error: e.message });
//   log.info({ module: 'boot', event: 'ready', port: 8721 });
//
// 输出(默认 pretty,一行):
//   [2026-08-06T12:00:00.000Z] [WARN] [SpawnManager] flush_failed pendingSendId=42 error="target dead"
//
// 环境变量:
//   MATE_LOG_LEVEL = debug|info|warn|error   默认 info
//   MATE_LOG_JSON  = 1                       改输出 JSON line(便于 jq/ELK)

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVEL = LEVELS[process.env.MATE_LOG_LEVEL] || LEVELS.info;
const JSON_OUT = process.env.MATE_LOG_JSON === '1';

function _fmtValue(v) {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'string') return v.includes(' ') || v.includes('=') ? JSON.stringify(v) : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch { return '[unstringifiable]'; }
}

function _fmt(lvl, ctx, msg) {
  const ts = new Date().toISOString();
  if (JSON_OUT) {
    const out = { ts, lvl, ...ctx };
    if (msg) out.msg = msg;
    try { return JSON.stringify(out); } catch { return JSON.stringify({ ts, lvl, err: 'serialize failed' }); }
  }
  const mod = ctx.module || '-';
  const evt = ctx.event || '';
  const extra = Object.entries(ctx)
    .filter(([k]) => k !== 'module' && k !== 'event')
    .map(([k, v]) => `${k}=${_fmtValue(v)}`)
    .join(' ');
  const parts = [`[${ts}]`, `[${lvl.toUpperCase()}]`, `[${mod}]`];
  if (evt) parts.push(evt);
  if (extra) parts.push(extra);
  if (msg) parts.push('· ' + msg);
  return parts.join(' ');
}

function _log(lvl, ctx, msg) {
  if ((LEVELS[lvl] || 0) < LEVEL) return;
  const line = _fmt(lvl, ctx || {}, msg || '');
  if (lvl === 'warn' || lvl === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

module.exports = {
  debug: (ctx, msg) => _log('debug', ctx, msg),
  info: (ctx, msg) => _log('info', ctx, msg),
  warn: (ctx, msg) => _log('warn', ctx, msg),
  error: (ctx, msg) => _log('error', ctx, msg),
};
