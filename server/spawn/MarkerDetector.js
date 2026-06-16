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

// [bug@2026-06-13] H 写 reason 时可能内联 JSON snippet,reason 字段含 `"` 字符。
//   原正则 reason="([^"]*)" 在第一个 `"` 处截断 → 整个 marker 不匹配。
//   修复:用非贪婪 `.*?` + s 标志(. 匹配换行),终止条件改成"最后一个 `"`后跟 `\s*\/>`"。
//   这样能 robust 处理任何包含 `"` / 换行的 reason / summary / question。
const HANDOFF_RE = /<mate:handoff\s+target="([^"]+)"(?:\s+reason="(.*?)")?\s*\/>/is;
const DONE_RE = /<mate:done(?:\s+summary="(.*?)")?\s*\/>/is;
const BLOCKED_RE = /<mate:blocked\s+question="(.*?)"(?:\s+severity="([^"]*)")?\s*\/>/is;
// [需求@2026-06-16 Phase 2H] reject 协议 — H 拒绝处理 queue 里的某条 task(冲突 / 优先级)
//   reason 必填;optional bounce_to 可指定"建议派给谁"(例:重新派回原 R 让 user clarify)
const REJECT_RE = /<mate:reject\s+reason="(.*?)"(?:\s+bounce_to="([^"]*)")?\s*\/>/is;

// [arch-debt §13] 失败可观测性 — 这个 looser 正则用于"看起来像 marker 但 parse 失败"
//   的判断。SpawnManager 在 detect() 返 [] 但 looksLikeMarker() 返 true 时 emit
//   'marker.malformed' event,让 user 在 dashboard 看见 — 不再 silent fail。
const LOOSE_MARKER_RE = /<mate:(handoff|done|blocked|reject)\b/i;

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

    const rj = text.match(REJECT_RE);
    if (rj) found.push({ kind: 'reject', reason: rj[1], bounceTo: rj[2] || null });

    return found;
  },

  /**
   * [arch-debt §13] 看起来像有 marker 的意图(粗判)。
   * 用于"detect 返 [] 但文本含 <mate:* 子串"的 malformed 检测。
   *
   * @returns {boolean}
   */
  looksLikeMarker(text) {
    if (!text || typeof text !== 'string') return false;
    return LOOSE_MARKER_RE.test(text);
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
      .replace(REJECT_RE, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  },
};

module.exports = MarkerDetector;
