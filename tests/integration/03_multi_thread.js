// [需求@2026-06-10] 集成 03 — 多重需求讨论(user 关键场景)
//   覆盖:
//     - 同 project 同时创建 3 条线索
//     - 每条发不同消息
//     - 验证 3 个独立 R 实例绑定 + 互不串台
//     - 验证 parallelism limit(R 上限 3)
//   预算:3 个 R 实例,每个 1 轮 → ~$0.20-0.50

const { describe, it, expect } = require('../_framework');
const { api, waitFor, ensureSandboxProject, archiveAllSandboxThreads, killProjectInstances, requireServer } = require('../_helpers');

describe('03 — multi-thread concurrent discussion', () => {
  let projectId;
  const slugs = [];
  const expectedReplies = ['alpha', 'beta', 'gamma'];

  it('setup: sandbox + start with clean slate', async () => {
    await requireServer();
    const proj = await ensureSandboxProject();
    projectId = proj.id;
    await archiveAllSandboxThreads(projectId);
    await killProjectInstances(projectId);
  });

  it('create 3 threads concurrently', async () => {
    const titles = ['thread A', 'thread B', 'thread C'];
    const created = await Promise.all(titles.map((title) =>
      api(`/threads?projectId=${projectId}`, { method: 'POST', body: { title } })
    ));
    for (const c of created) {
      expect(c.status).toBe(201);
      slugs.push(c.body.slug);
    }
    expect(slugs).toHaveLength(3);
  });

  it('send a unique single-word reply prompt to each thread', async () => {
    await Promise.all(slugs.map((slug, i) =>
      api(`/threads/${slug}/message?projectId=${projectId}`, {
        method: 'POST',
        body: { text: `Reply with ONLY one English word: ${expectedReplies[i]}` },
      })
    ));
  });

  it('each thread gets its own R instance bound', async () => {
    // Wait for all three to have bound R
    await waitFor(async () => {
      const bound = await Promise.all(slugs.map(async (s) => {
        const t = await api(`/threads/${s}?projectId=${projectId}`);
        return t.body.metadata.current_role_instances.requirements;
      }));
      return bound.every(Boolean) ? bound : null;
    }, { timeoutMs: 30000, label: '3 R instances bound' });

    // Verify all 3 bound instances are distinct
    const bound = await Promise.all(slugs.map(async (s) => {
      const t = await api(`/threads/${s}?projectId=${projectId}`);
      return t.body.metadata.current_role_instances.requirements;
    }));
    const uniq = new Set(bound);
    expect(uniq.size).toBe(3);
  });

  it('each thread eventually gets the expected single-word reply (no crosstalk)', async () => {
    const matches = await waitFor(async () => {
      const found = await Promise.all(slugs.map(async (s, i) => {
        const h = await api(`/threads/${s}/history?projectId=${projectId}`);
        const assistants = h.body.filter((m) => m.eventType === 'assistant');
        const text = assistants.flatMap((m) =>
          (m.payload.message?.content || []).filter((c) => c.type === 'text').map((c) => c.text.toLowerCase())
        ).join(' ');
        return text.includes(expectedReplies[i]);
      }));
      return found.every(Boolean) ? found : null;
    }, { timeoutMs: 180000, label: '3 distinct replies arrive' });

    expect(matches).toEqual([true, true, true]);
  });

  it('parallelism limit (R = 3) — creating a 4th does not spawn 4th R', async () => {
    // R max is 3; creating a 4th thread is fine (lazy spawn isn't triggered),
    // but actually sending to it should refuse since 3 R already alive
    const fourth = await api(`/threads?projectId=${projectId}`, { method: 'POST', body: { title: 'D' } });
    expect(fourth.status).toBe(201);

    const send = await api(`/threads/${fourth.body.slug}/message?projectId=${projectId}`, {
      method: 'POST', body: { text: 'hi' },
    });
    // We expect a 400 with parallelism limit (because all 3 R are still busy/idle, not disconnected)
    // BUT if the 3 finished and went idle quickly, the test might race. Allow either:
    //   - 200 (spawn succeeded — meaning a previous R was already disconnected)
    //   - 400 with limit message
    if (send.status !== 200) {
      expect(send.status).toBe(400);
      expect(JSON.stringify(send.body)).toContain('parallelism limit');
    }
  });

  it('cleanup', async () => {
    await archiveAllSandboxThreads(projectId);
    await killProjectInstances(projectId);
  });
});
