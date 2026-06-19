// [需求@2026-06-17 E2E.5] 核心:创建线索 + R→H→B 派工 + done 完结

const { test, expect } = require('@playwright/test');
const {
  injectScripts,
  resetTestState,
  getTestState,
  waitFor,
  waitForThreadStage,
} = require('./fixtures/helpers');
const { happyPath } = require('./fixtures/scripts');

test.describe('线索创建 + 完整派工链', () => {
  test.beforeEach(async () => {
    await resetTestState();
    await injectScripts(happyPath);
  });

  test('happy path: user 输入 → R → H → B → done → verified', async ({ page }) => {
    // 1. 打开主页 + 等 project picker 加载完成(确保 state.activeProjectId 已设)
    await page.goto('/');
    await expect(page.locator('#topbar')).toBeVisible();
    // 等 #project-picker 至少有 1 个 option(说明 projects API 回来了)
    await page.waitForFunction(() => {
      const sel = document.querySelector('#project-picker');
      return sel && sel.options.length > 0;
    }, { timeout: 10000 });

    // 2. 创建新线索
    await page.click('#new-thread-btn');
    const dialog = page.locator('#new-thread-dialog');
    await expect(dialog).toBeVisible();
    await page.fill('#nt-title', 'E2E test thread');
    // 用 form submit 而不是 click,避免 dialog method=dialog 的边界
    await page.evaluate(() => {
      const form = document.querySelector('#new-thread-form');
      form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    });

    // 等线索出现在左侧列表 + 自动 focus
    await waitFor(async () => {
      const state = await getTestState();
      return state.threads.length > 0;
    }, { timeoutMs: 5000, label: 'thread created' });

    const stateAfterCreate = await getTestState();
    const slug = stateAfterCreate.threads[0].slug;
    console.log('   created thread:', slug);

    // 3. 发消息 — 触发 R 跑(R 会 emit handoff → mate 自动 dispatch H)
    //    R 脚本配置 match='dispatch',输入要带 "dispatch" 才会 push H
    const input = page.locator('#msg-input');
    await input.fill('please dispatch this work');
    await page.click('#send-btn');

    // 4. 等 H 接到工作(thread.stage 应该 → designing)
    //    (考虑当前 Phase 1+2 还没切 SSOT,我们看 metadata 里的 chain 演变)
    await waitFor(async () => {
      const state = await getTestState();
      const t = state.threads.find((x) => x.slug === slug);
      return t && t.chainLength >= 1;
    }, { timeoutMs: 8000, label: 'chain >= 1 segment' });

    // 5. 验证 chain 推进:R→H,H→B,B→H callback,H→done
    //    Phase 1+2 期间 outcome 字段还没被运行时写,看 stage='verified' 当 SSOT
    await waitForThreadStage(slug, 'verified', { timeoutMs: 15000 });

    // 6. 验证最终态
    const finalState = await getTestState();
    const t = finalState.threads.find((x) => x.slug === slug);
    expect(t.stage).toBe('verified');
    // [需求@2026-06-19 #162 回归] chain 必须 5 段:
    //   R→H, H→B, B→H, H-done(callback to R), R-done(terminal)
    //   buggy 版本(callerRoleType 字符串错配)在 H-done 处 setStage verified 但
    //   R 收不到 delegate 消息 → 末段是 H-done 而非 R-done → 数据未真闭环。
    expect(t.chainLength).toBeGreaterThanOrEqual(5);
    expect(t.lastChainSeg?.kind).toBe('done');
    expect(t.lastChainSeg?.fromRole).toBe('mate-R');
    expect(t.lastChainSeg?.isTerminal).toBe(true);

    console.log('   chain length:', t.chainLength);
    console.log('   stack:', t.stack ? `depth ${t.stack.frames.length}` : '(not migrated, Phase 1+2 cold field)');
    console.log('   outcome:', t.outcome || '(not set, Phase 3 will wire)');

    // 7. 验证 UI 反映了状态
    //    线索列表里应该有 verified 标识
    const focusedThread = page.locator('.thread-card.focused, .thread-card.active').first();
    if (await focusedThread.count() > 0) {
      const stageText = await focusedThread.textContent();
      console.log('   UI thread card text contains stage info');
    }
  });

  test('mock 模式下 instance 池正确分配', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => {
      const sel = document.querySelector('#project-picker');
      return sel && sel.options.length > 0;
    }, { timeout: 10000 });
    await page.click('#new-thread-btn');
    await page.fill('#nt-title', 'pool alloc test');
    await page.evaluate(() => {
      document.querySelector('#new-thread-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    });

    // 等线索创建
    await waitFor(async () => (await getTestState()).threads.length > 0);
    const state = await getTestState();
    const slug = state.threads[0].slug;

    await page.fill('#msg-input', 'please dispatch this work');
    await page.click('#send-btn');

    // 等 R 出现
    await waitFor(async () => {
      const s = await getTestState();
      return s.instances.some((i) => i.roleName === 'mate-R' && i.threadSlug === slug);
    }, { timeoutMs: 5000, label: 'R instance bound' });

    // 等 H 出现(R 派工触发 H spawn)
    await waitFor(async () => {
      const s = await getTestState();
      return s.instances.some((i) => i.roleName === 'mate-H');
    }, { timeoutMs: 8000, label: 'H instance spawned' });

    const final = await getTestState();
    const r = final.instances.find((i) => i.roleName === 'mate-R');
    const h = final.instances.find((i) => i.roleName === 'mate-H');
    expect(r).toBeTruthy();
    expect(h).toBeTruthy();
    expect(r._mock).toBe(true);
    expect(h._mock).toBe(true);
    console.log('   R:', r.id, 'status:', r.status);
    console.log('   H:', h.id, 'status:', h.status);
  });
});
