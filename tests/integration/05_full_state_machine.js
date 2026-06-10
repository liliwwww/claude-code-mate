// [需求@2026-06-10] 集成 05 — 完整状态机 R → H → execB → done
//   user 视角:发一个需求,等回来 verified
//   覆盖:
//     - R 完工 → designing
//     - H 派工 → executing
//     - execB 完工 + handoff back → testing(verifying)
//     - H 自验 done → verified
//   预算:R + H + execB,多轮交互 → ~$0.80-2.00
//
//   ⚠️ 长测试(可能跑 5-10 分钟)。允许 stage 只到 designing/executing 也算"机制工作",
//   完整跑到 verified 是 stretch goal。

const { describe, it, expect } = require('../_framework');
const { api, waitFor, ensureSandboxProject, archiveAllSandboxThreads, killProjectInstances, requireServer } = require('../_helpers');

describe('05 — full state machine R→H→execB→done', () => {
  let projectId;
  let slug;

  it('setup', async () => {
    await requireServer();
    const proj = await ensureSandboxProject();
    projectId = proj.id;
    await archiveAllSandboxThreads(projectId);
    await killProjectInstances(projectId);
  });

  it('create thread + send minimal-but-actionable requirement', async () => {
    const t = await api(`/threads?projectId=${projectId}`, {
      method: 'POST', body: { title: 'full-machine test' },
    });
    slug = t.body.slug;

    const text = [
      '需求清单(全部已确定,不需追问):',
      '',
      '* 新建一个 Node.js 文件,运行后只打印 "hello state-machine" 并退出。',
      '* 文件路径你决定。',
      '* 内容尽量短,3 行以内。',
      '',
      '请按 R → H → execB → done 全自动流转,你不需要等我确认。',
    ].join('\n');

    await api(`/threads/${slug}/message?projectId=${projectId}`, {
      method: 'POST', body: { text },
    });
  });

  it('thread advances past discussing within 3 minutes', async () => {
    const reached = await waitFor(async () => {
      const t = await api(`/threads/${slug}?projectId=${projectId}`);
      return t.body.stage !== 'discussing' ? t.body.stage : null;
    }, { timeoutMs: 180000, intervalMs: 2000, label: 'stage past discussing' });
    expect(['designing', 'executing', 'testing', 'verified']).toContain(reached);
  });

  it('thread reaches executing or further within 5 minutes (H actually dispatched)', async () => {
    const reached = await waitFor(async () => {
      const t = await api(`/threads/${slug}?projectId=${projectId}`);
      const valid = ['executing', 'testing', 'verified'];
      return valid.includes(t.body.stage) ? t.body.stage : null;
    }, { timeoutMs: 300000, intervalMs: 2000, label: 'stage ≥ executing' });
    expect(['executing', 'testing', 'verified']).toContain(reached);
  });

  // Optional: full verified — long, often skipped in CI runs
  it.skip('thread reaches verified within 10 minutes (full machine)', async () => {
    await waitFor(async () => {
      const t = await api(`/threads/${slug}?projectId=${projectId}`);
      return t.body.stage === 'verified';
    }, { timeoutMs: 600000, intervalMs: 5000, label: 'stage → verified' });

    const t = await api(`/threads/${slug}?projectId=${projectId}`);
    expect(t.body.stage).toBe('verified');
  });

  it('cleanup', async () => {
    await archiveAllSandboxThreads(projectId);
    await killProjectInstances(projectId);
  });
});
