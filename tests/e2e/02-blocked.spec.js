// [需求@2026-06-17 E2E.6] H emit blocked → user 回复 → 继续 → done

const { test, expect } = require('@playwright/test');
const { injectScripts, resetTestState, getTestState, waitFor, waitForThreadStage } = require('./fixtures/helpers');
const { hBlocked } = require('./fixtures/scripts');

test.describe('blocked + user 回复继续', () => {
  test.beforeEach(async () => {
    await resetTestState();
    await injectScripts(hBlocked);
  });

  test('R 派 H → H blocked → user 回复 "选 A" → H 派 B → done', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => {
      const sel = document.querySelector('#project-picker');
      return sel && sel.options.length > 0;
    }, { timeout: 10000 });

    // 创建线索
    await page.click('#new-thread-btn');
    await page.fill('#nt-title', 'blocked test');
    await page.evaluate(() => {
      document.querySelector('#new-thread-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    });

    await waitFor(async () => (await getTestState()).threads.length > 0);
    const slug = (await getTestState()).threads[0].slug;

    // 发消息触发 R → H
    await page.fill('#msg-input', 'please dispatch this work');
    await page.click('#send-btn');

    // 等 H emit blocked(thread.metadata.blocked 应设)
    await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:8722/api/threads/${slug}?projectId=1`);
      const t = await r.json();
      return t.metadata?.blocked?.question;
    }, { timeoutMs: 10000, label: 'H blocked question 出现' });

    const tAfterBlock = await (await fetch(`http://127.0.0.1:8722/api/threads/${slug}?projectId=1`)).json();
    console.log('   blocked question:', tAfterBlock.metadata.blocked.question);
    expect(tAfterBlock.metadata.blocked.question).toContain('path A');

    // user 回复 "PICK_A"(应路由到 H,因为 last_questioner_role_type=orchestrator)
    await page.fill('#msg-input', 'PICK_A');
    await page.click('#send-btn');

    // 等 chain 继续推进(H 应该派 B)
    await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:8722/api/threads/${slug}?projectId=1`);
      const t = await r.json();
      const chain = t.metadata?.dispatch_chain || [];
      return chain.some((s) => s.kind === 'handoff' && s.toRole === 'mate-B');
    }, { timeoutMs: 10000, label: 'H 在 user 答 A 后派 B' });

    // 等 done
    await waitForThreadStage(slug, 'verified', { timeoutMs: 15000 });

    const final = await getTestState();
    const t = final.threads.find((x) => x.slug === slug);
    console.log('   final stage:', t.stage);
    console.log('   final chainLen:', t.chainLength);
    expect(t.stage).toBe('verified');
  });
});
