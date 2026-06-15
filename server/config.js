// ============================================================================
// MODULE CONTRACT(架构 SSOT:docs/architecture.md §3 §4 §6)
// ----------------------------------------------------------------------------
// 层:L0 Infrastructure
// 责任:加载 .env + 暴露 typed config 单例(所有 env 入口)
// 公共 API:export const config = { port, paths, httpProxy, claudeBin,
//   globalMaxClaudeProcesses, defaultSessionTtlHours, stuckBusyThresholdMin,
//   disconnectedKeepPerGroup, ttlScanIntervalMin, ttlWarnBeforeMin, ... }
// 允许依赖:dotenv / path / fs(boot 期 mkdir 副作用 OK)
// 禁止:
//   - 任何业务逻辑
//   - 动态修改 config(只读 + 启动期校验)
//   - 在别处直接读 process.env(全部走 config)
// ============================================================================
//
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
  // [需求@2026-06-14 user] 日常使用发现 claude session 不需要自动过期 —
  //   2h/4h TTL 反复 kill+lazy-resurrect 反而打断上下文。提到 720h(30 天)实际等价
  //   "永不过期"。需要 per-role 短 TTL 仍在 frontmatter 写 session_ttl_hours 覆盖。
  defaultSessionTtlHours: int(process.env.DEFAULT_SESSION_TTL_HOURS, 720),

  // [需求@2026-06-12 §8.10 + Phase 2E §13 + 2026-06-15 Phase 2G M1.5] 全局并发软上限
  //   超出 emit cap_warn,前端红条 banner,不硬拒
  //   口径:只算 idle/busy/spawning 真活实例(disconnected 不算)
  //   2026-06-15:Phase 2G boot 预热 1 H + 4 B + 4 C = 9 池实例 + N R(per thread)+ 弹性 →
  //              默认从 8 提到 16
  globalMaxClaudeProcesses: int(process.env.GLOBAL_MAX_CLAUDE_PROCESSES, 16),

  // [需求@2026-06-15 Phase 2G M1.5] Boot 预热配置
  //   开启 → 启动时为 defaultProjectId 预 spawn 1 H + 4 B + 4 C(parallelism_limit 上限)
  //   关闭 → 全 lazy spawn(等到有 marker / user send 触发才起)
  //   user 反馈:R→H→B/C 多角色派工链路,H 想分派 B/C 时希望"看见"4 个 slot,
  //   首次派工不用等 spawn(~3-5s)
  preheatPoolOnBoot: (process.env.PREHEAT_POOL_ON_BOOT || 'true').toLowerCase() !== 'false',

  // [需求@2026-06-12 §8.10] background recycler 扫描间隔 + 提前预警阈值
  ttlScanIntervalMin: int(process.env.TTL_SCAN_INTERVAL_MIN, 5),
  ttlWarnBeforeMin: int(process.env.TTL_WARN_BEFORE_MIN, 15),
  // [需求@2026-06-12 Phase 2E §4] status=busy 但长时间无活动 → 自动 unstick 阈值
  stuckBusyThresholdMin: int(process.env.STUCK_BUSY_THRESHOLD_MIN, 5),
  // [需求@2026-06-12 Phase 2E §13] disconnected 实例每 (project,role) 双组保留数,
  //   超出按 lastActiveAt 降序老化(标 dead)
  disconnectedKeepPerGroup: int(process.env.DISCONNECTED_KEEP_PER_GROUP, 5),
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
