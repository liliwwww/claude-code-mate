// [需求@2026-06-17 E2E] 4 角色响应脚本 fixture
//
// 每个脚本格式: { match: 'string'|'/regex/', emit: [eventScript, ...] }
//   - eventScript.type: 'assistant'|'tool_use'|'tool_result'|'result_success'|'result_error'
//   - eventScript.text + eventScript.marker: 拼到 assistant 输出末尾(模拟 LLM 自然产 marker)

// 场景 1: 完整 R → H → B → done(终结)
const happyPath = {
  'mate-R': [
    // user 第一次输入(创建线索)→ R 派给 H
    {
      match: '/dispatch/',
      emit: [
        { type: 'assistant', text: '需求确认,派给 H 设计方案。', marker: '<mate:handoff target="mate-H" reason="user needs dispatch" />' },
        { type: 'result_success' },
      ],
    },
    // H bounce 回 R 后,R 翻译并 emit done(terminal)
    {
      match: '/<delegate mate-H-1 done>/',
      emit: [
        { type: 'assistant', text: '完成。已告诉 user。', marker: '<mate:done summary="user dispatch 已完成" />' },
        { type: 'result_success' },
      ],
    },
    // greeting / fallback
    {
      match: /.*/,
      emit: [
        { type: 'assistant', text: 'ready (mock R)' },
        { type: 'result_success' },
      ],
    },
  ],

  'mate-H': [
    // 收到 R 的 handoff → 派给 B-1
    {
      match: '/Thread handoff from mate-R/',
      emit: [
        { type: 'assistant', text: '设计已拟,派给 B-1 执行。', marker: '<mate:handoff target="mate-B-1" reason="execute step 1" />' },
        { type: 'result_success' },
      ],
    },
    // B callback → H verify → done
    {
      match: '/Thread handoff from mate-B/',
      emit: [
        { type: 'assistant', text: '验证: 已读 X 确认存在,函数 Y 已实现。', marker: '<mate:done summary="B-1 verified — file:line 证据 ok" />' },
        { type: 'result_success' },
      ],
    },
    // fallback
    {
      match: /.*/,
      emit: [
        { type: 'assistant', text: 'ready (mock H)' },
        { type: 'result_success' },
      ],
    },
  ],

  'mate-B': [
    // 收到 H 派工 → 干活 → callback 给 H
    {
      match: '/Thread handoff from mate-H/',
      emit: [
        { type: 'tool_use', tool: 'Read', input: { file_path: '/mock/file.txt' } },
        { type: 'tool_result', content: 'file content mock' },
        { type: 'assistant', text: '实施完成。修改了 X,新增了 Y。', marker: '<mate:handoff target="mate-H" reason="实施完成请验收" />' },
        { type: 'result_success' },
      ],
    },
    {
      match: /.*/,
      emit: [
        { type: 'assistant', text: 'ready (mock B)' },
        { type: 'result_success' },
      ],
    },
  ],

  'mate-C': [
    {
      match: /.*/,
      emit: [
        { type: 'assistant', text: 'ready (mock C)' },
        { type: 'result_success' },
      ],
    },
  ],
};

// 场景 2: H 收到 R 后立刻 blocked(需要 user 决策)
const hBlocked = {
  ...happyPath,
  'mate-H': [
    // ① B callback 优先匹配(放最前面),否则 conv ctx 里有 PICK_A 会误匹配
    {
      match: '/Thread handoff from mate-B/',
      emit: [
        { type: 'assistant', text: 'verified: file ok, function ok.', marker: '<mate:done summary="B-1 verified — evidence ok" />' },
        { type: 'result_success' },
      ],
    },
    // ② R 第一次派工 → blocked
    {
      match: '/Thread handoff from mate-R/',
      emit: [
        { type: 'assistant', text: 'ambiguous, ask user.', marker: '<mate:blocked question="path A or B?" severity="mid" />' },
        { type: 'result_success' },
      ],
    },
    // ③ user 回 PICK_A → 派 B
    {
      match: '/PICK_A/',
      emit: [
        { type: 'assistant', text: 'PICK_A received, dispatch B.', marker: '<mate:handoff target="mate-B-1" reason="path A" />' },
        { type: 'result_success' },
      ],
    },
    // 其它情况 fallback
    {
      match: /.*/,
      emit: [
        { type: 'assistant', text: 'ready (mock H fallback)' },
        { type: 'result_success' },
      ],
    },
  ],
};

// 场景 3: B callback,H verify 失败 → reject 弹 R
const hReject = {
  ...happyPath,
  'mate-H': [
    happyPath['mate-H'][0], // R → H handoff 同
    {
      match: '/Thread handoff from mate-B/',
      emit: [
        { type: 'assistant', text: 'B claim 跟 verify 不符 — reject。', marker: '<mate:reject reason="B 说改了文件但 Read 没找到" />' },
        { type: 'result_success' },
      ],
    },
    ...happyPath['mate-H'],
  ],
};

// 场景 4: H 收到 R 后 bounce 回 R (H 觉得需求不清,弹给 R)
const hBounce = {
  ...happyPath,
  'mate-H': [
    // ① B callback 优先(永远先匹配避免循环)
    {
      match: '/Thread handoff from mate-B/',
      emit: [
        { type: 'assistant', text: 'verified ok', marker: '<mate:done summary="B-1 done" />' },
        { type: 'result_success' },
      ],
    },
    // ② R refined 也优先(避免落入 generic R match → 无限 bounce)
    {
      match: '/REFINED/',
      emit: [
        { type: 'assistant', text: 'now clear, dispatching', marker: '<mate:handoff target="mate-B-1" reason="refined task" />' },
        { type: 'result_success' },
      ],
    },
    // ③ R 第一次派工 → bounce 回 R(target=mate-R 在协议里是 bounce)
    {
      match: '/Thread handoff from mate-R/',
      emit: [
        { type: 'assistant', text: 'need more clarification from R', marker: '<mate:handoff target="mate-R" reason="ambiguous scope" />' },
        { type: 'result_success' },
      ],
    },
    {
      match: /.*/,
      emit: [
        { type: 'assistant', text: 'ready (mock H fallback)' },
        { type: 'result_success' },
      ],
    },
  ],
  'mate-R': [
    // ① delegate done(优先)→ R 拍板结束
    {
      match: '/<delegate mate-H-1 done>/',
      emit: [
        { type: 'assistant', text: 'final done', marker: '<mate:done summary="dispatch verified end-to-end" />' },
        { type: 'result_success' },
      ],
    },
    // ② H bounce 回 R(handoff from H)→ R "clarifies" → REFINED
    //   必须比 /dispatch/ 先,因为 H bounce 的 conversation context 会含原始 "dispatch"
    {
      match: '/Thread handoff from mate-H/',
      emit: [
        { type: 'assistant', text: 'H wants clarification. user said: REFINED scope', marker: '<mate:handoff target="mate-H" reason="REFINED task per user" />' },
        { type: 'result_success' },
      ],
    },
    // ③ user 第一次输入 → R 派给 H
    {
      match: '/dispatch/',
      emit: [
        { type: 'assistant', text: '需求确认,派给 H 设计方案。', marker: '<mate:handoff target="mate-H" reason="user needs dispatch" />' },
        { type: 'result_success' },
      ],
    },
    {
      match: /.*/,
      emit: [
        { type: 'assistant', text: 'ready (mock R)' },
        { type: 'result_success' },
      ],
    },
  ],
};

module.exports = {
  happyPath,
  hBlocked,
  hReject,
  hBounce,
};
