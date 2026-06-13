// ============================================================================
// MODULE CONTRACT(架构 SSOT:docs/architecture.md §3 §4 §6)
// ----------------------------------------------------------------------------
// 层:L2 Process Control(2026-06-13 从 L3 system-agent/ 迁入 L2 spawn/,
//   arch-debt §4 ✅;marker 解析是 stream-json 应用层,属 L2 不属 L3)
// 责任:正则解析 <mate:handoff/done/blocked /> marker(纯函数)
// 公共 API:detect(text) → markers[]
// 允许依赖:无(纯)
// 禁止:
//   - 任何 IO
//   - 决策(只解析,谁触发什么是 SpawnManager 的事)
//   - 副作用
// 新增 marker 类型 → 先改 architecture.md + arch-debt.md 再加
// ============================================================================
//
// [需求@2026-06-10 §6] mate handoff marker detector
//   R/H/B/C 的 system prompt 教它们在每轮末尾输出 <mate:...> marker。
//   这个模块负责从 assistant 文本里识别 marker,供 SpawnManager 自动派工。

const HANDOFF_RE = /<mate:handoff\s+target="([^"]+)"(?:\s+reason="([^"]*)")?\s*\/>/i;
const DONE_RE = /<mate:done(?:\s+summary="([^"]*)")?\s*\/>/i;
const BLOCKED_RE = /<mate:blocked\s+question="([^"]+)"(?:\s+severity="([^"]*)")?\s*\/>/i;

const MarkerDetector = {
  /**
   * Parse an assistant text for mate markers.
   * @returns {Array<{kind, target?, reason?, summary?, question?, severity?}>}
   *   kind: 'handoff' | 'done' | 'blocked'
   */
  detect(text) {
    if (!text || typeof text !== 'string') return [];
    const found = [];

    const h = text.match(HANDOFF_RE);
    if (h) found.push({ kind: 'handoff', target: h[1], reason: h[2] || '' });

    const d = text.match(DONE_RE);
    if (d) found.push({ kind: 'done', summary: d[1] || '' });

    const b = text.match(BLOCKED_RE);
    if (b) found.push({ kind: 'blocked', question: b[1], severity: b[2] || 'mid' });

    return found;
  },

  /**
   * Strip markers from text (for clean display / persistence if needed).
   */
  strip(text) {
    if (!text) return text;
    return text
      .replace(HANDOFF_RE, '')
      .replace(DONE_RE, '')
      .replace(BLOCKED_RE, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  },
};

module.exports = MarkerDetector;
