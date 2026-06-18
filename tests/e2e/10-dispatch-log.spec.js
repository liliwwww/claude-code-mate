// [需求@2026-06-19] 派工文件落盘 — push 写新文件, callback / done / blocked / reject 追加 section

const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { BASE, injectScripts, resetTestState, getTestState, waitFor, waitForThreadStage } = require('./fixtures/helpers');

// 用 tmp dir 当 project root,避免污染真项目
const E2E_PROJECT_ROOT = path.join(os.tmpdir(), 'mate-e2e-dispatch-log');

// 派工脚本: R→H (含 task_slug)→ B→ callback → H done
const dispatchLogScripts = {
  'mate-R': [
    {
      match: '/dispatch/',
      emit: [
        { type: 'assistant', text: 'planA confirmed', marker: '<mate:handoff target="mate-H" reason="implement plan A" task_slug="test_dispatch_log" />' },
        { type: 'result_success' },
      ],
    },
    {
      match: '/<delegate mate-H-1 done>/',
      emit: [
        { type: 'assistant', text: 'final', marker: '<mate:done summary="confirmed" />' },
        { type: 'result_success' },
      ],
    },
    {
      match: /.*/,
      emit: [
        { type: 'assistant', text: 'ready' },
        { type: 'result_success' },
      ],
    },
  ],
  'mate-H': [
    {
      match: '/Thread handoff from mate-B/',
      emit: [
        { type: 'assistant', text: 'B verified', marker: '<mate:done summary="B done verified" />' },
        { type: 'result_success' },
      ],
    },
    {
      match: '/Thread handoff from mate-R/',
      emit: [
        { type: 'assistant', text: 'plan dispatched', marker: '<mate:handoff target="mate-B-1" reason="step 1" />' },
        { type: 'result_success' },
      ],
    },
    {
      match: /.*/,
      emit: [{ type: 'assistant', text: 'ready' }, { type: 'result_success' }],
    },
  ],
  'mate-B': [
    {
      match: '/Thread handoff from mate-H/',
      emit: [
        { type: 'assistant', text: 'impl done', marker: '<mate:handoff target="mate-H" reason="step 1 implemented" />' },
        { type: 'result_success' },
      ],
    },
    {
      match: /.*/,
      emit: [{ type: 'assistant', text: 'ready' }, { type: 'result_success' }],
    },
  ],
  'mate-C': [
    {
      match: /.*/,
      emit: [{ type: 'assistant', text: 'ready' }, { type: 'result_success' }],
    },
  ],
};

test.describe('派工文件落盘 (kb_knowledge 风格)', () => {
  test.beforeAll(() => {
    // 确保 project root 存在 (api 创建 project 时要求 rootDir 存在)
    try { fs.mkdirSync(E2E_PROJECT_ROOT, { recursive: true }); } catch {}
    // 清空目标 dispatch 目录
    const dir = path.join(E2E_PROJECT_ROOT, 'doc', 'dispatch');
    if (fs.existsSync(dir)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  test.beforeEach(async () => {
    await resetTestState();
    await injectScripts(dispatchLogScripts);
  });

  test('开启 project + R 给 task_slug → push 写文件, callback/done 追加', async () => {
    // 1. 创建测试 project,启用 dispatch_log,root_dir=tmpdir
    //   project 名加时间戳保唯一 (reset 不删 projects 表)
    const projName = 'e2e-dispatch-log-' + Math.random().toString(36).slice(2, 8);
    const projResp = await fetch(`${BASE}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: projName, rootDir: E2E_PROJECT_ROOT }),
    });
    if (!projResp.ok) {
      throw new Error(`create project failed: ${projResp.status} ${await projResp.text()}`);
    }
    const proj = await projResp.json();
    console.log('   created project:', proj.id, '@', proj.root_dir);

    // 开启 dispatch_log_enabled
    const enResp = await fetch(`${BASE}/api/_test/enable-dispatch-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: proj.id }),
    });
    if (!enResp.ok) throw new Error('enable-dispatch-log failed: ' + (await enResp.text()));

    // 2. 创建 thread + 发消息
    const slug = (await (await fetch(`${BASE}/api/threads?projectId=${proj.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'dispatch log test' }),
    })).json()).slug;

    await fetch(`${BASE}/api/threads/${slug}/message?projectId=${proj.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'please dispatch this work' }),
    });

    // 等 verified
    await waitForThreadStage(slug, 'verified', { timeoutMs: 15000 });

    // 3. 验证 doc/dispatch/ 下文件
    const dispatchDir = path.join(E2E_PROJECT_ROOT, 'doc', 'dispatch');
    expect(fs.existsSync(dispatchDir)).toBe(true);

    const files = fs.readdirSync(dispatchDir);
    console.log('   派工文件:', files);
    expect(files.length).toBeGreaterThanOrEqual(2); // 至少 R→H 和 H→B 两个 push

    // 文件名应含 task_slug
    expect(files.some((f) => f.includes('test_dispatch_log'))).toBe(true);
    expect(files.some((f) => f.includes('001_R_to_H'))).toBe(true);
    expect(files.some((f) => f.includes('002_H_to_B-1'))).toBe(true);

    // 4. 看文件内容
    const firstFile = files.find((f) => f.includes('001_R_to_H'));
    const content = fs.readFileSync(path.join(dispatchDir, firstFile), 'utf8');
    console.log('   ---001_R_to_H 内容预览---');
    console.log(content.slice(0, 400));
    console.log('   ---末尾---');
    console.log(content.slice(-400));

    expect(content).toContain('task_slug');
    expect(content).toContain('test_dispatch_log');
    expect(content).toContain('implement plan A'); // reason

    // 第二个 push 文件 (H→B-1) 应该有 callback section (B 回调 H)
    const secondFile = files.find((f) => f.includes('002_H_to_B-1'));
    const content2 = fs.readFileSync(path.join(dispatchDir, secondFile), 'utf8');
    expect(content2).toContain('Callback'); // B 的 callback 追加进来
    expect(content2).toContain('Done'); // H 验完了 done
  });
});
