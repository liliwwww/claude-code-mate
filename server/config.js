// Loads .env and exposes a typed config object to the rest of the backend.
// All env access goes through here — never read process.env elsewhere.

require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env') });

const path = require('node:path');
const fs = require('node:fs');

function bool(s, def) {
  if (s === undefined) return def;
  return /^(1|true|yes|on)$/i.test(s);
}

function int(s, def) {
  const n = parseInt(s ?? '', 10);
  return Number.isFinite(n) ? n : def;
}

const ROOT = path.resolve(__dirname, '..');

const config = {
  root: ROOT,
  port: int(process.env.PORT, 8721),

  // Proxy (REQUIRED — child claude processes need these)
  httpProxy:  process.env.HTTP_PROXY  || '',
  httpsProxy: process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '',
  noProxy:    process.env.NO_PROXY    || 'localhost,127.0.0.1',

  // CLI binary location
  claudeBin: process.env.CLAUDE_BIN || 'claude',

  // Sibling project — for Phase 1, fall back to mate's own root
  siblingProjectDir: process.env.SIBLING_PROJECT_DIR || ROOT,

  // Paths derived from root
  paths: {
    root: ROOT,
    server: path.join(ROOT, 'server'),
    public: path.join(ROOT, 'public'),
    rolesDir: path.join(ROOT, 'roles'),
    dataDir: path.join(ROOT, 'data'),
    snapshotsDir: path.join(ROOT, 'data', 'snapshots'),
    sqlite: path.join(ROOT, 'data', 'mate.sqlite'),
    runlogDir: path.join(ROOT, 'data', 'runlog'),
  },

  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),

  // Default session TTL — overridden per-role via role frontmatter
  defaultSessionTtlHours: 4,

  // [需求@2026-06-12 §8.10] 全局并发软上限 — 超出 emit cap_warn,前端红条 banner,不硬拒
  //   默认 16(R 池 10 + 2 H + 2 execB + 2 testC 起算)。
  globalMaxClaudeProcesses: int(process.env.GLOBAL_MAX_CLAUDE_PROCESSES, 16),

  // [需求@2026-06-12 §8.10] background recycler 扫描间隔 + 提前预警阈值
  ttlScanIntervalMin: int(process.env.TTL_SCAN_INTERVAL_MIN, 5),
  ttlWarnBeforeMin: int(process.env.TTL_WARN_BEFORE_MIN, 15),
};

// Ensure data dirs exist
for (const d of [config.paths.dataDir, config.paths.snapshotsDir, config.paths.runlogDir]) {
  fs.mkdirSync(d, { recursive: true });
}

// Validation warnings (not fatal at boot — UI surfaces them as banners)
config.warnings = [];
if (!config.httpProxy) {
  config.warnings.push('HTTP_PROXY is empty — claude child processes will fail to reach Anthropic API.');
}
if (!fs.existsSync(config.paths.rolesDir)) {
  config.warnings.push(`Roles directory not found: ${config.paths.rolesDir}`);
}

module.exports = config;
