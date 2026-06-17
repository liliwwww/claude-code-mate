// [需求@2026-06-17 E2E] Playwright 测试 helpers

const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:8722';

/**
 * Inject 一组角色脚本到 mate server。
 * scripts: { 'mate-R': [...], 'mate-H': [...], ... }
 */
async function injectScripts(scripts) {
  for (const [role, list] of Object.entries(scripts)) {
    // 把 RegExp / match 转字符串(server 端会 compile 回 RegExp)
    const serializable = list.map((s) => ({
      match: s.match instanceof RegExp ? `/${s.match.source}/${s.match.flags}` : s.match,
      emit: s.emit,
    }));
    const r = await fetch(`${BASE}/api/_test/scripts/${encodeURIComponent(role)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scripts: serializable }),
    });
    if (!r.ok) {
      throw new Error(`injectScripts ${role} failed: ${r.status} ${await r.text()}`);
    }
  }
}

/**
 * 清测试态 — 把 DB 数据清空,scripts 复原 defaults。
 * 用法:每个 test 开头调一次确保状态干净。
 */
async function resetTestState() {
  const r = await fetch(`${BASE}/api/_test/reset`, { method: 'POST' });
  if (!r.ok) throw new Error(`reset failed: ${r.status} ${await r.text()}`);
}

/**
 * 看测试态全景。
 */
async function getTestState() {
  const r = await fetch(`${BASE}/api/_test/state`);
  if (!r.ok) throw new Error(`getTestState failed: ${r.status}`);
  return r.json();
}

/**
 * waitFor(predicate, opts) — 轮询直到 predicate 返回 truthy 或超时。
 * predicate 可 async。返回 predicate 的最后结果。
 */
async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 100, label = 'condition' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await predicate();
      if (r) return r;
    } catch {}
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  throw new Error(`waitFor timeout (${timeoutMs}ms): ${label}`);
}

/**
 * 等到某 thread 出现 + stage 满足条件
 */
async function waitForThreadStage(slugOrPredicate, stagePredicate, opts) {
  return waitFor(async () => {
    const state = await getTestState();
    let thread = null;
    if (typeof slugOrPredicate === 'function') {
      thread = state.threads.find(slugOrPredicate);
    } else {
      thread = state.threads.find((t) => t.slug === slugOrPredicate);
    }
    if (!thread) return null;
    if (typeof stagePredicate === 'function') {
      return stagePredicate(thread) ? thread : null;
    }
    if (thread.stage === stagePredicate) return thread;
    return null;
  }, { ...opts, label: `thread stage = ${stagePredicate}` });
}

/**
 * 等到 outcome 设了
 */
async function waitForOutcome(slug, expected, opts) {
  return waitFor(async () => {
    const state = await getTestState();
    const t = state.threads.find((x) => x.slug === slug);
    if (!t) return null;
    if (t.outcome === expected) return t;
    return null;
  }, { ...opts, label: `thread ${slug} outcome=${expected}` });
}

module.exports = {
  BASE,
  injectScripts,
  resetTestState,
  getTestState,
  waitFor,
  waitForThreadStage,
  waitForOutcome,
};
