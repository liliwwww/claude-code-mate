// [需求@2026-06-10] 测试共享 helpers
//   - api():REST 调用 mate server
//   - waitFor():轮询直到 predicate truthy 或超时
//   - serverIsLive():预检 server 是否在监听
//   - ensureSandboxProject():保证测试用 sandbox project 存在,返回 row
//   - archiveThread():测试结束关线索
//   - sleep():便利
//
// 所有集成测试用 sandbox project,**绝不**碰 Default project — user 自己用的数据要保护。

const fs = require('node:fs');
const path = require('node:path');

const PORT = parseInt(process.env.MATE_PORT, 10) || 8721;
const BASE = `http://127.0.0.1:${PORT}`;
const SANDBOX_NAME = 'test-sandbox';
const SANDBOX_DIR = path.resolve(__dirname, '..', 'data', 'test-sandbox');

async function api(p, opts = {}) {
  const res = await fetch(BASE + '/api' + p, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

async function waitFor(predicate, { timeoutMs = 60000, intervalMs = 500, label = 'condition' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let r;
    try { r = await predicate(); } catch (e) { r = null; }
    if (r) return r;
    await sleep(intervalMs);
  }
  throw new Error(`waitFor timeout: ${label} after ${timeoutMs}ms`);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function serverIsLive() {
  try {
    const r = await fetch(BASE + '/api/system');
    return r.ok;
  } catch { return false; }
}

async function requireServer() {
  const live = await serverIsLive();
  if (!live) {
    throw new Error(`mate server not running on ${BASE}. Start it with: node server/index.js`);
  }
}

async function ensureSandboxProject() {
  const projects = await api('/projects');
  if (projects.status !== 200) {
    throw new Error(`/projects failed: ${JSON.stringify(projects)}`);
  }
  const existing = projects.body.find((p) => p.name === SANDBOX_NAME);
  if (existing) return existing;

  fs.mkdirSync(SANDBOX_DIR, { recursive: true });
  const r = await api('/projects', {
    method: 'POST',
    body: { name: SANDBOX_NAME, rootDir: SANDBOX_DIR.replace(/\\/g, '/') },
  });
  if (r.status !== 201) {
    throw new Error(`create sandbox failed: ${JSON.stringify(r.body)}`);
  }
  return r.body;
}

async function archiveAllSandboxThreads(projectId) {
  const r = await api(`/threads?projectId=${projectId}&includeClosed=1`);
  if (r.status !== 200) return;
  for (const t of r.body) {
    if (t.stage !== 'closed') {
      await api(`/threads/${encodeURIComponent(t.slug)}?projectId=${projectId}`, {
        method: 'PATCH', body: { stage: 'closed' },
      }).catch(() => {});
    }
  }
}

async function killProjectInstances(projectId) {
  const r = await api(`/instances?projectId=${projectId}`);
  if (r.status !== 200) return;
  for (const inst of r.body) {
    if (inst.status === 'busy' || inst.status === 'idle' || inst.status === 'spawning') {
      await api(`/instances/${encodeURIComponent(inst.id)}`, { method: 'DELETE' }).catch(() => {});
    }
  }
}

// Extract assistant text from db payload(便利)
function extractAssistantText(payload) {
  const content = payload?.message?.content;
  if (Array.isArray(content)) {
    return content.filter((c) => c.type === 'text').map((c) => c.text).join('');
  }
  return '';
}

module.exports = {
  api,
  waitFor,
  sleep,
  serverIsLive,
  requireServer,
  ensureSandboxProject,
  archiveAllSandboxThreads,
  killProjectInstances,
  extractAssistantText,
  BASE,
  PORT,
  SANDBOX_NAME,
};
