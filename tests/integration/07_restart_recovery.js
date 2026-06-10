// [需求@2026-06-10] 集成 07 — 重启不丢数据 + lazy resurrection
//   覆盖:
//     - 创建线索,送消息,等 R 回完(实例 idle)
//     - 模拟 server 重启:kill 实例(模拟 mate 退出 + claude session 留在 jsonl)
//     - 重新 list instances → 实例变 disconnected,但 SQLite 历史和 session_id 在
//     - 再发消息 → 自动 spawn 新进程 with --resume,对话续上
//   预算:1 R,3-4 轮 → ~$0.30-0.60

const { describe, it, expect } = require('../_framework');
const { api, waitFor, ensureSandboxProject, archiveAllSandboxThreads, killProjectInstances, requireServer } = require('../_helpers');

describe('07 — restart recovery + lazy resurrection', () => {
  let projectId;
  let slug;
  let firstInstanceId;
  let firstSessionId;

  it('setup', async () => {
    await requireServer();
    const proj = await ensureSandboxProject();
    projectId = proj.id;
    await archiveAllSandboxThreads(projectId);
    await killProjectInstances(projectId);
  });

  it('create thread + send memory-planting message', async () => {
    const t = await api(`/threads?projectId=${projectId}`, {
      method: 'POST', body: { title: 'restart recovery' },
    });
    slug = t.body.slug;

    await api(`/threads/${slug}/message?projectId=${projectId}`, {
      method: 'POST',
      body: { text: '请记住:我的最喜欢的颜色是 emerald。然后只回 "saved"。' },
    });

    // Wait until result arrives
    await waitFor(async () => {
      const h = await api(`/threads/${slug}/history?projectId=${projectId}`);
      return h.body.some((m) => m.eventType === 'result/success');
    }, { timeoutMs: 120000, label: 'first result arrives' });

    const t2 = await api(`/threads/${slug}?projectId=${projectId}`);
    firstInstanceId = t2.body.metadata.current_role_instances.requirements;
    expect(firstInstanceId).toBeTruthy();

    const inst = await api(`/instances?projectId=${projectId}`);
    firstSessionId = inst.body.find((x) => x.id === firstInstanceId).sessionId;
    expect(firstSessionId).toBeTruthy();
  });

  it('simulate mate restart: kill the running R instance', async () => {
    // We don't actually restart the server here (would interrupt this test process);
    // killing the instance simulates the same observable effect: process gone, jsonl persists.
    const r = await api(`/instances/${encodeURIComponent(firstInstanceId)}`, { method: 'DELETE' });
    expect(r.status).toBe(200);

    // The instance row in DB should still exist, but status will eventually flip dead.
    await waitFor(async () => {
      const inst = await api(`/instances?projectId=${projectId}`);
      const r = inst.body.find((x) => x.id === firstInstanceId);
      return !r;  // dead instances are filtered out from /instances
    }, { timeoutMs: 15000, label: 'instance disappears from active list' });
  });

  it('next message triggers spawn + --resume; same instance ID is reused', async () => {
    await api(`/threads/${slug}/message?projectId=${projectId}`, {
      method: 'POST', body: { text: '我刚才说我最喜欢的颜色是什么?只回那个颜色名。' },
    });

    // Wait for new result
    await waitFor(async () => {
      const inst = await api(`/instances?projectId=${projectId}`);
      const r = inst.body.find((x) => x.id === firstInstanceId);
      return r && (r.status === 'busy' || r.status === 'idle');
    }, { timeoutMs: 30000, label: 'R instance live again' });
  });

  it('the resumed R remembers the color (recall via --resume)', async () => {
    const found = await waitFor(async () => {
      const h = await api(`/threads/${slug}/history?projectId=${projectId}`);
      const assistants = h.body.filter((m) => m.eventType === 'assistant');
      const last = assistants[assistants.length - 1];
      if (!last) return null;
      const text = (last.payload.message?.content || [])
        .filter((c) => c.type === 'text').map((c) => c.text).join('').toLowerCase();
      return text.includes('emerald') ? text : null;
    }, { timeoutMs: 120000, label: 'emerald recalled' });
    expect(found).toContain('emerald');
  });

  it('cleanup', async () => {
    await archiveAllSandboxThreads(projectId);
    await killProjectInstances(projectId);
  });
});
