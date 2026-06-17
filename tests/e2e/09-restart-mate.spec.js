// [需求@2026-06-17 E2E.11] mate 真重启 — 进程级 kill + 重启,栈持久化恢复
//
// 这个测试 NOT 用 Playwright webServer(它管 server 生命周期)。
// 改用单独 spawn server,跑一半 kill,再 spawn 新 server,验证 DB 持久数据全在。

const { test, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { BASE, injectScripts, resetTestState, getTestState, waitFor, waitForThreadStage } = require('./fixtures/helpers');
const { happyPath } = require('./fixtures/scripts');

// 用独立端口避免撞 playwright 自己的 webServer(8722)
const RESTART_PORT = 8723;
const RESTART_BASE = `http://127.0.0.1:${RESTART_PORT}`;
const RESTART_DB = path.join(os.tmpdir(), 'mate-e2e-restart.sqlite');

function startMate() {
  return new Promise((resolve, reject) => {
    // 清旧 DB
    for (const ext of ['', '-shm', '-wal']) {
      const f = RESTART_DB + ext;
      if (fs.existsSync(f)) try { fs.unlinkSync(f); } catch {}
    }

    const proc = spawn('node', ['server/index.js'], {
      cwd: path.resolve(__dirname, '..', '..'),
      env: {
        ...process.env,
        PORT: String(RESTART_PORT),
        MATE_DB: RESTART_DB,
        MATE_MOCK_TERMS: '1',
        PREHEAT_POOL_ON_BOOT: 'false',
        LOG_LEVEL: 'warn',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let booted = false;
    proc.stdout.on('data', (d) => {
      const s = d.toString();
      if (s.includes('[boot] listening') && !booted) {
        booted = true;
        resolve(proc);
      }
    });
    proc.stderr.on('data', () => {});
    proc.on('error', reject);
    setTimeout(() => { if (!booted) reject(new Error('server boot timeout')); }, 10000);
  });
}

function startMateResume() {
  return new Promise((resolve, reject) => {
    // 关键:不清 DB
    const proc = spawn('node', ['server/index.js'], {
      cwd: path.resolve(__dirname, '..', '..'),
      env: {
        ...process.env,
        PORT: String(RESTART_PORT),
        MATE_DB: RESTART_DB,
        MATE_MOCK_TERMS: '1',
        PREHEAT_POOL_ON_BOOT: 'false',
        LOG_LEVEL: 'warn',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let booted = false;
    proc.stdout.on('data', (d) => {
      if (d.toString().includes('[boot] listening') && !booted) {
        booted = true;
        resolve(proc);
      }
    });
    proc.stderr.on('data', () => {});
    proc.on('error', reject);
    setTimeout(() => { if (!booted) reject(new Error('resume boot timeout')); }, 10000);
  });
}

async function killMate(proc) {
  return new Promise((resolve) => {
    proc.on('exit', () => resolve());
    proc.kill('SIGKILL');
    setTimeout(resolve, 2000); // force timeout
  });
}

test.describe('mate 真重启 — 栈/线索/messages 全保留', () => {
  test.beforeEach(async () => {
    // 确保旧端口空闲
    try { await fetch(`${RESTART_BASE}/api/system`); } catch {} // 如果起着,跳过
  });

  test('happy 链跑完 → kill mate → 重启 → 数据全在 → 二轮派工继续', async () => {
    // 1. 启 mate
    let mate = await startMate();

    // 2. 注入 scripts + 跑完整 happy 链
    const compileMatch = (m) => m instanceof RegExp ? `/${m.source}/${m.flags}` : m;
    for (const [role, list] of Object.entries(happyPath)) {
      const r = await fetch(`${RESTART_BASE}/api/_test/scripts/${encodeURIComponent(role)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scripts: list.map((s) => ({ match: compileMatch(s.match), emit: s.emit })) }),
      });
      if (!r.ok) throw new Error(`script inject failed for ${role}: ${r.status}`);
    }

    const slug = (await (await fetch(`${RESTART_BASE}/api/threads?projectId=1`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'restart test' }),
    })).json()).slug;

    await fetch(`${RESTART_BASE}/api/threads/${slug}/message?projectId=1`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'dispatch round 1' }),
    });

    // 等 round 1 verified
    await waitForThreadStageOn(RESTART_BASE, slug, 'verified', 15000);

    const stateBeforeKill = await getStateOn(RESTART_BASE);
    const tBefore = stateBeforeKill.threads.find((t) => t.slug === slug);
    console.log('   before kill: chain=', tBefore.chainLength, 'stage=', tBefore.stage);
    const messagesBefore = await getMessagesCount(RESTART_BASE, slug);
    console.log('   before kill: messages count =', messagesBefore);

    // 3. KILL mate
    await killMate(mate);
    console.log('   mate killed');

    // 4. RESTART mate(同 DB)
    mate = await startMateResume();
    console.log('   mate restarted');

    // 5. 验证 thread 仍在 + chain 完整
    const stateAfterRestart = await getStateOn(RESTART_BASE);
    const tAfter = stateAfterRestart.threads.find((t) => t.slug === slug);
    expect(tAfter).toBeTruthy();
    expect(tAfter.chainLength).toBe(tBefore.chainLength);
    expect(tAfter.stage).toBe('verified');
    console.log('   after restart: chain=', tAfter.chainLength, 'stage=', tAfter.stage);

    // messages 应保留
    const messagesAfter = await getMessagesCount(RESTART_BASE, slug);
    expect(messagesAfter).toBeGreaterThanOrEqual(messagesBefore);
    console.log('   after restart: messages count =', messagesAfter);

    // 6. 重启后 inject scripts(registry 是内存,重启会失)
    for (const [role, list] of Object.entries(happyPath)) {
      await fetch(`${RESTART_BASE}/api/_test/scripts/${encodeURIComponent(role)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scripts: list.map((s) => ({ match: compileMatch(s.match), emit: s.emit })) }),
      });
    }

    // 7. 重启后再发消息 → 二轮派工
    await fetch(`${RESTART_BASE}/api/threads/${slug}/message?projectId=1`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'dispatch round 2' }),
    });
    await waitForChainGrowthOn(RESTART_BASE, slug, tAfter.chainLength + 1, 15000);
    await waitForThreadStageOn(RESTART_BASE, slug, 'verified', 15000);

    const stateFinal = await getStateOn(RESTART_BASE);
    const tFinal = stateFinal.threads.find((t) => t.slug === slug);
    console.log('   round 2 final: chain=', tFinal.chainLength, 'stage=', tFinal.stage);
    expect(tFinal.chainLength).toBeGreaterThan(tAfter.chainLength);

    // 清场
    await killMate(mate);
  });
});

// ---------- helpers ----------
async function getStateOn(base) {
  const r = await fetch(`${base}/api/_test/state`);
  return r.json();
}

async function getMessagesCount(base, slug) {
  const r = await fetch(`${base}/api/threads/${slug}/history?projectId=1&limit=1000`);
  const msgs = await r.json();
  return Array.isArray(msgs) ? msgs.length : 0;
}

async function waitForThreadStageOn(base, slug, stage, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const st = await getStateOn(base);
    const t = st.threads.find((x) => x.slug === slug);
    if (t && t.stage === stage) return t;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`waitForThreadStage timeout: ${slug} stage=${stage}`);
}

async function waitForChainGrowthOn(base, slug, minLen, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const st = await getStateOn(base);
    const t = st.threads.find((x) => x.slug === slug);
    if (t && t.chainLength >= minLen) return t;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`waitForChainGrowth timeout: ${slug} >= ${minLen}`);
}
