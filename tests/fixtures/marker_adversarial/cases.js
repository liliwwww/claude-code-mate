// [arch-debt §12 ✅ 2026-06-13] Adversarial marker test fixtures
//
// 目的:实战 2 bug 暴露 MarkerDetector 单测只覆盖 happy path。
//   这份 fixture 把 LLM 真实可能输出的各种 marker 形态全部列下来,做 parse 验证。

module.exports = [
  // ---------- 基线 happy path ----------
  {
    name: 'simple handoff',
    text: 'queue 已 ready。\n<mate:handoff target="mate-H" reason="需求 queued" />',
    expect: { count: 1, kind: 'handoff', target: 'mate-H', reason: '需求 queued' },
  },
  {
    name: 'handoff no reason',
    text: '<mate:handoff target="mate-B" />',
    expect: { count: 1, kind: 'handoff', target: 'mate-B', reason: '' },
  },
  {
    name: 'done with summary',
    text: '完成。<mate:done summary="Tetris 已交付" />',
    expect: { count: 1, kind: 'done', summary: 'Tetris 已交付' },
  },
  {
    name: 'done no summary',
    text: '<mate:done />',
    expect: { count: 1, kind: 'done', summary: '' },
  },
  {
    name: 'blocked',
    text: '<mate:blocked question="导入是追加还是覆盖?" severity="mid" />',
    expect: { count: 1, kind: 'blocked', question: '导入是追加还是覆盖?', severity: 'mid' },
  },

  // ---------- 实战 bug case ----------
  {
    name: 'reason contains JSON snippet with double quotes [2026-06-13 bug]',
    text: '...设计...\n<mate:handoff target="mate-B" reason="对齐 SSE 协议。新形状 {"type":"answer","content":<text>,"forced":false} 来对应前端" />',
    expect: { count: 1, kind: 'handoff', target: 'mate-B' },
    reasonContains: '新形状',
    reasonMinLength: 20,
  },
  {
    name: 'reason multiline with unicode + line breaks',
    text: `<mate:handoff target="mate-H" reason="
对齐 hybrid_ontology 的 SSE 协议
【文件】kb_backend/app/services/qa_hybrid_lg_agent_service.py
【SCOPE】5 处必改
1. final_answer → answer
2. tool_call 补 round
3. 新增 tool_result 事件
" />`,
    expect: { count: 1, kind: 'handoff', target: 'mate-H' },
    reasonContains: '【SCOPE】',
  },
  {
    name: 'reason含 escape 序列 \\n \\" \\\\',
    text: '<mate:handoff target="mate-B" reason="例:文本是 \\"hello\\\\nworld\\" 这种" />',
    expect: { count: 1, kind: 'handoff', target: 'mate-B' },
    reasonContains: 'hello',
  },
  {
    name: 'reason 引用其他 marker 文本(防嵌套误判)',
    text: '<mate:handoff target="mate-H" reason="例如有人写 <mate:done summary=\\"x\\" /> 这种" />',
    expect: { count: 1, kind: 'handoff', target: 'mate-H' },
    reasonContains: 'mate:done',
  },

  // ---------- target with slot suffix ----------
  {
    name: 'target with slot',
    text: '<mate:handoff target="mate-B-2" reason="复用上轮 mate-B-2 的 warm context" />',
    expect: { count: 1, kind: 'handoff', target: 'mate-B-2' },
  },

  // ---------- 多 marker / 优先级 ----------
  {
    name: 'multi-markers handoff + blocked',
    text: 'A. <mate:handoff target="mate-H" /> B. <mate:blocked question="??" />',
    expect: { count: 2 },  // 都识别;优先级在 dispatcher 处理
  },

  // ---------- 位置 ----------
  {
    name: 'marker in middle of text',
    text: 'Step 1: 写 queue。\n<mate:handoff target="mate-H" />\nStep 2: 等编排。',
    expect: { count: 1, kind: 'handoff' },
  },
  {
    name: 'marker at end with trailing newlines',
    text: 'work done.\n\n<mate:done summary="ok" />\n\n\n',
    expect: { count: 1, kind: 'done', summary: 'ok' },
  },

  // ---------- malformed (should be detected by looksLikeMarker) ----------
  {
    name: 'malformed: handoff with broken syntax — looksLikeMarker should true',
    text: '<mate:handoff target=mate-H reason="missing quotes" />',
    expect: { count: 0 },
    looksLikeMarker: true,
  },
  {
    name: 'malformed: handoff but no closing /',
    text: '<mate:handoff target="mate-H" reason="x">',
    expect: { count: 0 },
    looksLikeMarker: true,
  },
  {
    name: 'no marker at all → looksLikeMarker false',
    text: 'just normal assistant text, no markers.',
    expect: { count: 0 },
    looksLikeMarker: false,
  },

  // ---------- case insensitive ----------
  {
    name: 'CASE-INSENSITIVE marker tag',
    text: '<MATE:HANDOFF TARGET="mate-H" />',
    expect: { count: 1, kind: 'handoff' },
  },
];
