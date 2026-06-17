// [需求@2026-06-17 E2E.8] bounce 协议 — H 弹回 R
//
// 协议:H emit <mate:handoff target="mate-R" ...> 表 bounce(把球踢回 R)
// 验证:
//   - chain 含 H→R 段
//   - R 重新拿到控制权,可再次 emit handoff target=H
//   - 完整闭环最终 verified

const { test, expect } = require('@playwright/test');
const { BASE, injectScripts, resetTestState, getTestState, waitFor, waitForThreadStage } = require('./fixtures/helpers');
const { hBounce, hBounceNew } = require('./fixtures/scripts');

test.describe('bounce: H → R 弹回', () => {
  test.beforeEach(async () => {
    await resetTestState();
    await injectScripts(hBounce);
  });

  test('R → H → H bounce R → R refine → H → B → done', async () => {
    const slug = (await (await fetch(`${BASE}/api/threads?projectId=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'bounce test' }),
    })).json()).slug;

    await fetch(`${BASE}/api/threads/${slug}/message?projectId=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'please dispatch this work' }),
    });

    // 等出现 H→R 段(bounce)
    await waitFor(async () => {
      const r = await (await fetch(`${BASE}/api/threads/${slug}?projectId=1`)).json();
      const chain = r.metadata?.dispatch_chain || [];
      return chain.some((s) => s.kind === 'handoff' && s.fromRole === 'mate-H' && s.toRole === 'mate-R');
    }, { timeoutMs: 10_000, label: 'H→R bounce 段出现' });

    // 等最终 verified
    await waitForThreadStage(slug, 'verified', { timeoutMs: 15_000 });

    const r = await (await fetch(`${BASE}/api/threads/${slug}?projectId=1`)).json();
    const chain = r.metadata.dispatch_chain;
    console.log('   chain segments:', chain.length);
    const handoffSegs = chain.filter((s) => s.kind === 'handoff');
    handoffSegs.forEach((s) => console.log('   ', s.fromRole, '→', s.toRole));

    expect(r.stage).toBe('verified');
    // 必有 H→R 段
    expect(handoffSegs.some((s) => s.fromRole === 'mate-H' && s.toRole === 'mate-R')).toBe(true);
    // 必有 H→B 段(refine 之后才有)
    expect(handoffSegs.some((s) => s.fromRole === 'mate-H' && s.toRole === 'mate-B')).toBe(true);
  });

  // [Phase 4 @2026-06-17] 新 <mate:bounce> 语法跑通
  test('Phase 4 新协议:<mate:bounce> 替代 handoff target=mate-R 跑通', async () => {
    await resetTestState();
    await injectScripts(hBounceNew);

    const slug = (await (await fetch(`${BASE}/api/threads?projectId=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'bounce v2' }),
    })).json()).slug;

    await fetch(`${BASE}/api/threads/${slug}/message?projectId=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'please dispatch this work' }),
    });

    await waitFor(async () => {
      const r = await (await fetch(`${BASE}/api/threads/${slug}?projectId=1`)).json();
      const chain = r.metadata?.dispatch_chain || [];
      return chain.some((s) => s.kind === 'handoff' && s.fromRole === 'mate-H' && s.toRole === 'mate-R');
    }, { timeoutMs: 10_000, label: 'H→R bounce 段(新协议)出现' });

    await waitForThreadStage(slug, 'verified', { timeoutMs: 15_000 });

    const r = await (await fetch(`${BASE}/api/threads/${slug}?projectId=1`)).json();
    expect(r.stage).toBe('verified');
    console.log('   新协议 chain segments:', r.metadata.dispatch_chain.length);
  });
});
