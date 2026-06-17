// [需求@2026-06-17 E2E.9] 干预模式 — dashboard 直发指定 instance
//
// 协议:POST /api/threads/:slug/message body.targetInstance=<id>
// 验证:user 干预 H,H 收到 user msg 并按其响应

const { test, expect } = require('@playwright/test');
const { BASE, injectScripts, resetTestState, getTestState, waitFor, waitForThreadStage } = require('./fixtures/helpers');
const { happyPath } = require('./fixtures/scripts');

// 用 happyPath 起跑 → 中途干预
const interventionScripts = {
  ...happyPath,
  'mate-H': [
    // ① 第一次收到 R 派工 → blocked 等 user 干预决策
    {
      match: '/Thread handoff from mate-R/',
      emit: [
        { type: 'assistant', text: 'waiting for user decision' },
        { type: 'result_success' },
      ],
    },
    // ② user 干预说 EMERGENCY → H 改派优先 B
    {
      match: '/EMERGENCY/',
      emit: [
        { type: 'assistant', text: 'emergency mode, dispatching B-1', marker: '<mate:handoff target="mate-B-1" reason="emergency override" />' },
        { type: 'result_success' },
      ],
    },
    // ③ B callback → done
    {
      match: '/Thread handoff from mate-B/',
      emit: [
        { type: 'assistant', text: 'verified', marker: '<mate:done summary="emergency done" />' },
        { type: 'result_success' },
      ],
    },
    {
      match: /.*/,
      emit: [
        { type: 'assistant', text: 'idle' },
        { type: 'result_success' },
      ],
    },
  ],
};

test.describe('干预模式 — dashboard targetInstance 路由', () => {
  test.beforeEach(async () => {
    await resetTestState();
    await injectScripts(interventionScripts);
  });

  test('user 干预 H 实例直发 EMERGENCY → H 派 B → done', async () => {
    const slug = (await (await fetch(`${BASE}/api/threads?projectId=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'intervention' }),
    })).json()).slug;

    // 触发 R → H(H 拿到后只 "waiting" 不 emit marker)
    await fetch(`${BASE}/api/threads/${slug}/message?projectId=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'please dispatch' }),
    });

    // 等 H 实例存在 + chain[0] R→H 记录
    await waitFor(async () => {
      const st = await getTestState();
      const hInst = st.instances.find((i) => i.roleName === 'mate-H');
      return hInst && hInst.threadSlug === slug;
    }, { timeoutMs: 10000, label: 'H 实例 ready' });

    const stateBefore = await getTestState();
    const hInst = stateBefore.instances.find((i) => i.roleName === 'mate-H');
    console.log('   H instance:', hInst.id);

    // 干预模式发 EMERGENCY 直接给 H
    const interventionResp = await fetch(`${BASE}/api/threads/${slug}/message?projectId=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'EMERGENCY override', targetInstance: hInst.id }),
    });
    const interventionJ = await interventionResp.json();
    console.log('   routedTo:', interventionJ.routedTo, 'mode:', interventionJ.mode);
    expect(interventionJ.routedTo).toBe('mate-H');
    expect(interventionJ.mode).toBe('intervention');

    // 等 H 处理 EMERGENCY → 派 B-1
    await waitFor(async () => {
      const r = await (await fetch(`${BASE}/api/threads/${slug}?projectId=1`)).json();
      const chain = r.metadata?.dispatch_chain || [];
      return chain.some((s) => s.kind === 'handoff' && s.fromRole === 'mate-H' && s.toRole === 'mate-B');
    }, { timeoutMs: 10000, label: 'H 派 B 段出现' });

    // 等最终 verified
    await waitForThreadStage(slug, 'verified', { timeoutMs: 15000 });

    const finalT = await (await fetch(`${BASE}/api/threads/${slug}?projectId=1`)).json();
    console.log('   final stage:', finalT.stage, 'chain:', finalT.metadata.dispatch_chain.length);
    expect(finalT.stage).toBe('verified');
  });
});
