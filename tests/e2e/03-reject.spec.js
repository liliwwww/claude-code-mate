// [需求@2026-06-17 E2E.6] H reject B callback → chain 记 reject 段

const { test, expect } = require('@playwright/test');
const { injectScripts, resetTestState, getTestState, waitFor } = require('./fixtures/helpers');
const { hReject } = require('./fixtures/scripts');

test.describe('H reject 验收 → bounce R', () => {
  test.beforeEach(async () => {
    await resetTestState();
    await injectScripts(hReject);
  });

  test('R → H → B → H verify fails → reject → R 收 notice', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => {
      const sel = document.querySelector('#project-picker');
      return sel && sel.options.length > 0;
    }, { timeout: 10000 });

    await page.click('#new-thread-btn');
    await page.fill('#nt-title', 'reject test');
    await page.evaluate(() => {
      document.querySelector('#new-thread-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    });

    await waitFor(async () => (await getTestState()).threads.length > 0);
    const slug = (await getTestState()).threads[0].slug;

    await page.fill('#msg-input', 'please dispatch this work');
    await page.click('#send-btn');

    // 等 chain 出现 reject 段
    await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:8722/api/threads/${slug}?projectId=1`);
      const t = await r.json();
      const chain = t.metadata?.dispatch_chain || [];
      return chain.some((s) => s.kind === 'reject');
    }, { timeoutMs: 15000, label: 'reject 段出现' });

    const r = await fetch(`http://127.0.0.1:8722/api/threads/${slug}?projectId=1`);
    const t = await r.json();
    const chain = t.metadata.dispatch_chain;
    const rejectSeg = chain.find((s) => s.kind === 'reject');
    console.log('   chain length:', chain.length);
    console.log('   reject reason:', rejectSeg.reason);
    expect(rejectSeg).toBeTruthy();
    // hReject 的 H reject reason: "B claim 跟 verify 不符 — reject。"
    expect(rejectSeg.reason.length > 0).toBe(true);
  });
});
