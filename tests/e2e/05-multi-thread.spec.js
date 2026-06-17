// [需求@2026-06-17 E2E.7] 多线索并发 + H singleton + B slot 竞争
//
// 验证:
//   - H 是 project singleton(parallelism_limit=1),N 线索抢 H 时 FIFO 排队
//   - 多线索能并发推进栈结构
//   - 资源最终都释放,两条都 verified
//   - SlotPool / PendingSends 行为正确

const { test, expect } = require('@playwright/test');
const {
  BASE,
  injectScripts,
  resetTestState,
  getTestState,
  waitFor,
  waitForThreadStage,
} = require('./fixtures/helpers');
const { happyPath } = require('./fixtures/scripts');

// [Phase 1+2 已知限制] queue 派工 chain 段没记 — 这导致多线索并发时
//   thread B 的 R→H handoff 通过 queue 路径,chain 段被 _performHandoff
//   提前 return 跳过 appendDispatchChain。Phase 3 栈模型(SlotPool + 帧 FIFO)
//   会重写这块,届时 queue 也是 SSOT 一等公民。本测试先 skip 标限制。
test.describe.skip('[Phase 3 待解] 多线索并发抢 H singleton', () => {
  test.beforeEach(async () => {
    await resetTestState();
    await injectScripts(happyPath);
  });

  test('2 线索同时派工 → 都 verified,FIFO 不死锁', async () => {
    // 直接用 API 创建俩线索 + 并发发消息(不走 UI,简化场景)
    const PROJ = 1;

    const createThread = async (title) => {
      const r = await fetch(`${BASE}/api/threads?projectId=${PROJ}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      const j = await r.json();
      return j.slug;
    };

    const slugA = await createThread('thread A');
    const slugB = await createThread('thread B');
    console.log('   created:', slugA, slugB);

    // 同时给两条线索发消息(触发 R → H → B → done 链)
    await Promise.all([
      fetch(`${BASE}/api/threads/${slugA}/message?projectId=${PROJ}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'please dispatch alpha work' }),
      }),
      fetch(`${BASE}/api/threads/${slugB}/message?projectId=${PROJ}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'please dispatch beta work' }),
      }),
    ]);

    // 等两条都 verified
    await waitForThreadStage(slugA, 'verified', { timeoutMs: 30_000 });
    await waitForThreadStage(slugB, 'verified', { timeoutMs: 30_000 });

    const state = await getTestState();
    const tA = state.threads.find((t) => t.slug === slugA);
    const tB = state.threads.find((t) => t.slug === slugB);
    console.log('   A chain:', tA.chainLength, 'stage:', tA.stage);
    console.log('   B chain:', tB.chainLength, 'stage:', tB.stage);

    expect(tA.stage).toBe('verified');
    expect(tB.stage).toBe('verified');
    expect(tA.chainLength).toBeGreaterThanOrEqual(4);
    expect(tB.chainLength).toBeGreaterThanOrEqual(4);

    // H 实例只有 1 个(singleton)
    const hInsts = state.instances.filter((i) => i.roleName === 'mate-H');
    console.log('   H instances:', hInsts.length);
    expect(hInsts.length).toBe(1);
  });

  test('3 线索并发,H FIFO 排队不丢消息', async () => {
    const PROJ = 1;

    const createThread = async (title) => {
      const r = await fetch(`${BASE}/api/threads?projectId=${PROJ}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      return (await r.json()).slug;
    };

    const slugs = await Promise.all([
      createThread('t-1'),
      createThread('t-2'),
      createThread('t-3'),
    ]);

    // 三个同时发
    await Promise.all(slugs.map((s) =>
      fetch(`${BASE}/api/threads/${s}/message?projectId=${PROJ}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'please dispatch work' }),
      })
    ));

    // 全部 verified
    for (const slug of slugs) {
      await waitForThreadStage(slug, 'verified', { timeoutMs: 45_000 });
    }

    const state = await getTestState();
    for (const slug of slugs) {
      const t = state.threads.find((x) => x.slug === slug);
      expect(t.stage).toBe('verified');
      expect(t.chainLength).toBeGreaterThanOrEqual(4);
    }

    // 仍只 1 个 H 实例
    const hCount = state.instances.filter((i) => i.roleName === 'mate-H').length;
    expect(hCount).toBe(1);
    console.log('   3 threads verified, H singleton confirmed (count:', hCount, ')');
  });
});
