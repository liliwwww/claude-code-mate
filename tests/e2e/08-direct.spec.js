// [需求@2026-06-17 E2E.10] 直连模式 — instance 沙箱对话
//
// 协议:POST /api/instances/:id/direct-message
// 验证:
//   - direct_target 字段标识
//   - 不挂任何 thread,chain 不变,thread.metadata 不动
//   - 该实例独立处理 message

const { test, expect } = require('@playwright/test');
const { BASE, injectScripts, resetTestState, getTestState, waitFor } = require('./fixtures/helpers');

// 简单脚本:任何输入回 "direct ack"
const directScripts = {
  'mate-B': [
    {
      match: '/ls/',
      emit: [
        { type: 'tool_use', tool: 'Bash', input: { command: 'ls' } },
        { type: 'tool_result', content: 'file1.txt\nfile2.txt' },
        { type: 'assistant', text: 'listed files: file1, file2' },
        { type: 'result_success' },
      ],
    },
    {
      match: /.*/,
      emit: [
        { type: 'assistant', text: 'direct ack' },
        { type: 'result_success' },
      ],
    },
  ],
};

test.describe('直连模式 — instance 独立对话不挂 thread', () => {
  test.beforeEach(async () => {
    await resetTestState();
    await injectScripts(directScripts);
  });

  test('spawn B instance + direct send → 收到响应,无 thread 影响', async () => {
    // 1. 先 spawn 一个 B 实例(走 /api/instances POST,需要 projectId query)
    const spawnResp = await fetch(`${BASE}/api/instances?projectId=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roleName: 'mate-B' }),
    });
    if (!spawnResp.ok) {
      throw new Error(`spawn failed: ${spawnResp.status} ${await spawnResp.text()}`);
    }
    const inst = await spawnResp.json();
    console.log('   spawned B instance:', inst.id);
    expect(inst.roleName).toBe('mate-B');

    // 等 B 进入 idle
    await waitFor(async () => {
      const st = await getTestState();
      const b = st.instances.find((i) => i.id === inst.id);
      return b && b.status === 'idle';
    }, { timeoutMs: 10000, label: 'B idle' });

    // 2. 直连发消息
    const directResp = await fetch(`${BASE}/api/instances/${inst.id}/direct-message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'ls /tmp' }),
    });
    expect(directResp.ok).toBe(true);
    console.log('   direct-message sent');

    // 等 B 处理完(turns >= 1)
    await waitFor(async () => {
      const st = await getTestState();
      const b = st.instances.find((i) => i.id === inst.id);
      return b && b.sessionStats?.turns >= 1;
    }, { timeoutMs: 8000, label: 'B 处理 direct msg' });

    // 3. 验证 messages 表里 direct_target 字段正确(通过 direct-history API)
    const histR = await fetch(`${BASE}/api/instances/${inst.id}/direct-history`);
    const hist = await histR.json();
    console.log('   direct history rows:', hist.length);
    expect(hist.length > 0).toBe(true);
    // 所有 direct history 消息的 directTarget 应该是该 instance id
    for (const m of hist) {
      expect(m.directTarget).toBe(inst.id);
    }

    // 4. 验证没有 thread 被创建
    const st = await getTestState();
    expect(st.threads.length).toBe(0);
    console.log('   no threads created — direct mode isolated 正确');
  });
});
