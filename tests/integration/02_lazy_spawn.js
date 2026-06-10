// [需求@2026-06-10] 集成 02 — 懒 spawn + 单线索往返
//   覆盖:
//     - 创建线索(无 slug 无 title)
//     - 发首条 → 后端懒 spawn R 并绑定到线索(无 greeting 浪费)
//     - assistant 回复持久化、流式事件统计
//     - 复用同实例处理后续消息
//   预算:1 个 R 实例,2-3 轮对话 → ~$0.20-0.40

const { describe, it, expect } = require('../_framework');
const { api, waitFor, sleep, ensureSandboxProject, archiveAllSandboxThreads, requireServer } = require('../_helpers');

describe('02 — lazy spawn & single thread', () => {
  let projectId;
  let slug;

  it('setup: sandbox project ready', async () => {
    await requireServer();
    const proj = await ensureSandboxProject();
    projectId = proj.id;
    expect(projectId).toBeTruthy();
  });

  it('create thread without slug → backend auto-generates t-xxx', async () => {
    const r = await api(`/threads?projectId=${projectId}`, {
      method: 'POST',
      body: { title: 'lazy spawn test' },
    });
    expect(r.status).toBe(201);
    expect(r.body.slug).toMatch(/^t-[a-z0-9]+-[a-z0-9]+$/);
    expect(r.body.stage).toBe('discussing');
    slug = r.body.slug;
  });

  it('no R instance bound yet (truly lazy)', async () => {
    const t = await api(`/threads/${slug}?projectId=${projectId}`);
    expect(t.body.metadata.current_role_instances.requirements).toBeNull();
  });

  it('send first message → R lazy-spawned, message routed', async () => {
    const send = await api(`/threads/${slug}/message?projectId=${projectId}`, {
      method: 'POST',
      body: { text: 'Reply with ONLY one word: lazy' },
    });
    expect(send.status).toBe(200);
    expect(send.body.ok).toBe(true);
    expect(send.body.instance.id).toMatch(/^planA-R\./);
  });

  it('thread is now bound to a R instance', async () => {
    const t = await api(`/threads/${slug}?projectId=${projectId}`);
    expect(t.body.metadata.current_role_instances.requirements).toMatch(/^planA-R\./);
  });

  it('R responds within 90s + assistant text persisted', async () => {
    const found = await waitFor(async () => {
      const h = await api(`/threads/${slug}/history?projectId=${projectId}`);
      return h.body.find((m) => m.eventType === 'assistant');
    }, { timeoutMs: 90000, label: 'first assistant reply' });
    expect(found).toBeTruthy();
  });

  it('second message reuses the same R instance (no respawn)', async () => {
    const before = await api(`/threads/${slug}?projectId=${projectId}`);
    const oldInstanceId = before.body.metadata.current_role_instances.requirements;

    // wait for R idle (busy → idle after result)
    await waitFor(async () => {
      const inst = await api(`/instances?projectId=${projectId}`);
      const r = inst.body.find((x) => x.id === oldInstanceId);
      return r && (r.status === 'idle' || r.status === 'disconnected');
    }, { timeoutMs: 30000, label: 'R idle' });

    await api(`/threads/${slug}/message?projectId=${projectId}`, {
      method: 'POST', body: { text: 'Reply with ONLY: reuse' },
    });

    const after = await api(`/threads/${slug}?projectId=${projectId}`);
    expect(after.body.metadata.current_role_instances.requirements).toBe(oldInstanceId);
  });

  it('cleanup: archive sandbox threads + kill instances', async () => {
    const { killProjectInstances } = require('../_helpers');
    await archiveAllSandboxThreads(projectId);
    await killProjectInstances(projectId);
  });
});
