// ============================================================================
// MODULE CONTRACT(架构 SSOT:docs/architecture.md §3 §4 §6)
// ----------------------------------------------------------------------------
// 层:L3 Business Hooks
// 责任:代理 / claude bin / DB / cwd 等环境可达性探针(user 触发)
// 公共 API:runAllChecks()
// 允许依赖:config / child_process / fs
// 禁止:阻塞 boot;修改任何 config / 环境(只检测)
// ============================================================================
//
// [需求@2026-06-10 §2.1] 环境检测 — 手动触发,失败不阻塞
//   检测项:
//     - claude 二进制可执行(--version)
//     - 代理 env 已配
//     - 代理可达 anthropic API(quick reach test)
//     - SQLite 可写
//     - claude 已认证(用 claude -p "ok" --no-session-persistence 一秒探针)
//
// 每项独立,部分失败不影响其它项。

const { execSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const config = require('../config');

async function check(name, fn) {
  const t0 = Date.now();
  try {
    const result = await fn();
    return { name, ok: true, durationMs: Date.now() - t0, detail: result };
  } catch (e) {
    return { name, ok: false, durationMs: Date.now() - t0, error: e.message };
  }
}

function runClaudeVersion() {
  const out = execSync(`"${config.claudeBin}" --version`, { encoding: 'utf8', timeout: 10000 });
  return out.trim();
}

function checkProxyEnv() {
  if (!config.httpProxy) throw new Error('HTTP_PROXY not set in .env');
  if (!config.httpsProxy) throw new Error('HTTPS_PROXY not set in .env');
  return `HTTP_PROXY=${config.httpProxy} · HTTPS_PROXY=${config.httpsProxy}`;
}

async function checkClaudeAuth() {
  return new Promise((resolve, reject) => {
    const child = spawn(config.claudeBin, [
      '-p', 'ok',
      '--output-format', 'json',
      '--model', 'claude-haiku-4-5',
      '--no-session-persistence',
      '--permission-mode', 'dontAsk',
      '--tools', '',
      '--max-budget-usd', '0.05',
    ], {
      cwd: config.root,
      env: {
        ...process.env,
        HTTP_PROXY: config.httpProxy,
        HTTPS_PROXY: config.httpsProxy,
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('error', (err) => reject(new Error(`spawn failed: ${err.message}`)));
    child.on('exit', (code) => {
      if (code !== 0) {
        let parsed;
        try { parsed = JSON.parse(stdout); } catch {}
        if (parsed?.result?.includes('Not logged in')) {
          return reject(new Error('claude not logged in — run `claude` interactively once to authenticate'));
        }
        return reject(new Error(`claude probe exit ${code}: ${stderr.slice(0, 200) || stdout.slice(0, 200)}`));
      }
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.is_error) {
          return reject(new Error(`api error: ${parsed.result?.slice(0, 200) || 'unknown'}`));
        }
        resolve(`authenticated · model=${parsed.modelUsage ? Object.keys(parsed.modelUsage).join(',') : '?'} · cost ${parsed.total_cost_usd}`);
      } catch (e) {
        reject(new Error(`parse failed: ${e.message}`));
      }
    });
    setTimeout(() => {
      if (child.exitCode === null) {
        try { child.kill(); } catch {}
        reject(new Error('auth probe timeout (30s)'));
      }
    }, 30000);
  });
}

function checkDbWritable() {
  const probe = require('node:path').join(config.paths.dataDir, '.envcheck.tmp');
  fs.writeFileSync(probe, String(Date.now()));
  fs.unlinkSync(probe);
  return `${config.paths.sqlite} (writable)`;
}

async function runAllChecks() {
  const results = [];
  results.push(await check('claude binary', runClaudeVersion));
  results.push(await check('proxy env', checkProxyEnv));
  results.push(await check('SQLite writable', checkDbWritable));
  results.push(await check('claude auth + API reach', checkClaudeAuth));

  const allOk = results.every((r) => r.ok);
  return {
    ok: allOk,
    summary: allOk ? 'all checks passed' : `${results.filter((r) => !r.ok).length} check(s) failed`,
    checks: results,
    ranAt: Date.now(),
  };
}

module.exports = { runAllChecks };
