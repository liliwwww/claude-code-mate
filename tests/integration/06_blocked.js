// [需求@2026-06-10] 集成 06 — BLOCKED 信号(业务岔口)
//   覆盖:R 收到模糊需求 → 输出 <mate:blocked /> → 线索 metadata.blocked 写入
//   预算:1 个 R,1-2 轮 → ~$0.20-0.40

const { describe, it, expect } = require('../_framework');
const { api, waitFor, ensureSandboxProject, archiveAllSandboxThreads, killProjectInstances, requireServer } = require('../_helpers');

describe('06 — BLOCKED signal on ambiguous requirement', () => {
  let projectId;
  let slug;

  it('setup', async () => {
    await requireServer();
    const proj = await ensureSandboxProject();
    projectId = proj.id;
    await archiveAllSandboxThreads(projectId);
    await killProjectInstances(projectId);
  });

  it('send a deliberately ambiguous business decision', async () => {
    const t = await api(`/threads?projectId=${projectId}`, {
      method: 'POST', body: { title: 'blocked test' },
    });
    slug = t.body.slug;

    // Intentionally ambiguous — user requesting a feature with two equally valid interpretations
    // and explicitly hinting it's a business decision they must make.
    const text = [
      '我想做一个数据导入功能。',
      '',
      '"导入"有两种业务含义,我不知道哪个对:',
      '* 追加(append)到现有数据',
      '* 覆盖(replace)现有数据',
      '',
      '这是一个业务决策,只有产品方(也就是我)能拍。',
      '请你直接 BLOCKED,不要替我做决定。',
    ].join('\n');

    await api(`/threads/${slug}/message?projectId=${projectId}`, {
      method: 'POST', body: { text },
    });
  });

  it('thread.metadata.blocked is populated within 2 minutes', async () => {
    const blocked = await waitFor(async () => {
      const t = await api(`/threads/${slug}?projectId=${projectId}`);
      return t.body.metadata.blocked || null;
    }, { timeoutMs: 120000, intervalMs: 2000, label: 'blocked metadata set' });

    expect(blocked.question).toBeTruthy();
    expect(['low', 'mid', 'high']).toContain(blocked.severity);
    expect(blocked.raisedBy).toMatch(/^planA-R$/);
  });

  it('blocked thread stays in discussing (no auto handoff)', async () => {
    const t = await api(`/threads/${slug}?projectId=${projectId}`);
    expect(t.body.stage).toBe('discussing');
  });

  it('cleanup', async () => {
    await archiveAllSandboxThreads(projectId);
    await killProjectInstances(projectId);
  });
});
