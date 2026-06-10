// [需求@2026-06-10] 集成 04 — 自动 handoff(分配任务核心场景)
//   覆盖:
//     - R 接到清晰一锤子需求 → 输出 <mate:handoff target="planA-H" />
//     - mate 自动 spawn H,bind 到 thread
//     - thread.stage 自动 discussing → designing
//     - thread.metadata.current_role_instances.orchestrator 不空
//   预算:1 R + 1 H 各 1-2 轮 → ~$0.40-0.80

const { describe, it, expect } = require('../_framework');
const { api, waitFor, ensureSandboxProject, archiveAllSandboxThreads, killProjectInstances, requireServer } = require('../_helpers');

describe('04 — auto handoff R → H', () => {
  let projectId;
  let slug;

  it('setup', async () => {
    await requireServer();
    const proj = await ensureSandboxProject();
    projectId = proj.id;
    await archiveAllSandboxThreads(projectId);
    await killProjectInstances(projectId);
  });

  it('create thread + send a one-shot clear requirement designed to trigger immediate handoff', async () => {
    const t = await api(`/threads?projectId=${projectId}`, {
      method: 'POST', body: { title: 'auto-handoff test' },
    });
    slug = t.body.slug;

    const text = [
      '需求很简单且明确,你不需要追问:',
      '',
      '* 做一个最简 Node.js CLI 工具,运行后打印 "ping" 并退出。',
      '* 不需要任何参数、配置、测试。',
      '* 所有细节我都不需要再确认。',
      '',
      '请直接写 queue 文件然后 handoff 给 planA-H。',
    ].join('\n');

    const r = await api(`/threads/${slug}/message?projectId=${projectId}`, {
      method: 'POST', body: { text },
    });
    expect(r.status).toBe(200);
  });

  it('thread.stage transitions to designing (auto handoff worked)', async () => {
    await waitFor(async () => {
      const t = await api(`/threads/${slug}?projectId=${projectId}`);
      return t.body.stage === 'designing' ? t.body : null;
    }, { timeoutMs: 180000, intervalMs: 1000, label: 'stage → designing' });

    const t = await api(`/threads/${slug}?projectId=${projectId}`);
    expect(t.body.stage).toBe('designing');
  });

  it('planA-H instance is bound to thread', async () => {
    const t = await api(`/threads/${slug}?projectId=${projectId}`);
    const hId = t.body.metadata.current_role_instances.orchestrator;
    expect(hId).toMatch(/^planA-H\./);
  });

  it('handoff event recorded for the thread', async () => {
    // No direct events endpoint, so we check via thread metadata that things wired up.
    // The thread is in designing with H bound — that's the observable signal.
    const t = await api(`/threads/${slug}?projectId=${projectId}`);
    expect(t.body.stage).toBe('designing');
    expect(t.body.metadata.current_role_instances.orchestrator).toBeTruthy();
  });

  it('cleanup', async () => {
    await archiveAllSandboxThreads(projectId);
    await killProjectInstances(projectId);
  });
});
