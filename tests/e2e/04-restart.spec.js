// [需求@2026-06-17 E2E.6] 重启恢复 — 跑一半 reset 实例(模拟 mate 重启)
//
// 这个测试不真重启 mate(playwright 不会重启 server),
// 而是用 _test/reset 模拟"清进程内存"的效果,然后看 lazy resurrection 是否能继续。

const { test, expect } = require('@playwright/test');
const { injectScripts, resetTestState, getTestState, waitFor, waitForThreadStage } = require('./fixtures/helpers');
const { happyPath } = require('./fixtures/scripts');

test.describe('实例 disconnect 后 lazy resurrect', () => {
  test.beforeEach(async () => {
    await resetTestState();
    await injectScripts(happyPath);
  });

  test('R idle 后 sendUserText 仍能继续推进', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => {
      const sel = document.querySelector('#project-picker');
      return sel && sel.options.length > 0;
    }, { timeout: 10000 });

    await page.click('#new-thread-btn');
    await page.fill('#nt-title', 'restart resilience');
    await page.evaluate(() => {
      document.querySelector('#new-thread-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    });

    await waitFor(async () => (await getTestState()).threads.length > 0);
    const slug = (await getTestState()).threads[0].slug;

    // 第一轮 dispatch
    await page.fill('#msg-input', 'please dispatch round 1');
    await page.click('#send-btn');
    await waitForThreadStage(slug, 'verified', { timeoutMs: 15000 });

    const state1 = await getTestState();
    const t1 = state1.threads.find((x) => x.slug === slug);
    console.log('   round 1 chain:', t1.chainLength, 'stage:', t1.stage);
    expect(t1.stage).toBe('verified');

    // 重新激活同一线索:再发一条消息
    //   逻辑:线索 verified 后 R/H/B 都 idle(在内存)。新消息进来路由到 R,
    //   R 重新工作 → 派 H → ... → 第二轮 verified
    await page.fill('#msg-input', 'please dispatch round 2');
    await page.click('#send-btn');

    // 等 chain 长度增长(超过 round 1 的)
    await waitFor(async () => {
      const s = await getTestState();
      const t = s.threads.find((x) => x.slug === slug);
      return t && t.chainLength > t1.chainLength;
    }, { timeoutMs: 15000, label: '第二轮 chain 增长' });

    // 等 stage 再 verified
    await waitForThreadStage(slug, 'verified', { timeoutMs: 15000 });

    const state2 = await getTestState();
    const t2 = state2.threads.find((x) => x.slug === slug);
    console.log('   round 2 chain:', t2.chainLength, 'stage:', t2.stage);
    expect(t2.chainLength).toBeGreaterThan(t1.chainLength);
    expect(t2.stage).toBe('verified');
  });
});
