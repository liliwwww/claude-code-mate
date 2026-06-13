// ============================================================================
// MODULE CONTRACT(架构 SSOT:docs/architecture.md §3 §4 §6)
// ----------------------------------------------------------------------------
// 层:L2 Process Control
// 责任:claude stdout NDJSON 容错解析 + 通用 event helpers(纯函数)
// 公共 API:class StreamParser + 解析 helpers(isResultError /
//   extractAssistantText / extractToolUses / extractToolResults /
//   extractTextDelta)
// 允许依赖:无(纯)
// 禁止:
//   - 任何 IO(文件 / 网络 / db)
//   - 业务判断
//   - 解析 mate marker(那是 MarkerDetector,只对 result.result 文本应用)
//   - 修改 raw event 字段(只读)
// ============================================================================
//
// Line-buffered NDJSON parser for claude headless stdout.
// Tolerant of partial chunks, multi-line bursts, and oversized lines.
// Emits a uniform shape: { eventType, raw, ts }.
//
// Event type classification (findings.md §4):
//   system/init           - startup metadata, session_id is here
//   system/api_retry      - retry notification
//   system/error          - undocumented but defensive
//   rate_limit_event      - rate/quota status (plan missed this)
//   user                  - stdin echo (--replay-user-messages)
//   assistant             - full assistant message (content[] of text/tool_use)
//   stream_event          - Anthropic SSE wrapper (token-level partials)
//                           nested .event.type = message_start | content_block_start |
//                           content_block_delta | content_block_stop |
//                           message_delta | message_stop
//   result/success|error  - terminal — but trust ev.is_error, NOT subtype!

const MAX_LINE_BYTES = 1_000_000;

class StreamParser {
  constructor({ onEvent, onParseError, onLineOverflow } = {}) {
    this.buf = '';
    this.onEvent = onEvent || (() => {});
    this.onParseError = onParseError || (() => {});
    this.onLineOverflow = onLineOverflow || (() => {});
  }

  feed(chunk) {
    this.buf += chunk.toString('utf8');
    let idx;
    while ((idx = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      this._handleLine(line);
    }
    if (this.buf.length > MAX_LINE_BYTES) {
      const dropped = this.buf;
      this.buf = '';
      this.onLineOverflow(dropped.length);
    }
  }

  _handleLine(line) {
    try {
      const ev = JSON.parse(line);
      const eventType = ev.type + (ev.subtype ? '/' + ev.subtype : '');
      this.onEvent({ eventType, raw: ev, ts: Date.now() });
    } catch (e) {
      this.onParseError(line, e);
    }
  }
}

// Helper: determine if an event indicates the result is an error.
// Per findings §6 — DON'T trust subtype, trust is_error.
function isResultError(ev) {
  return ev?.type === 'result' && ev.is_error === true;
}

// [arch-debt §14 ✅ 2026-06-13] eventType 谓词中心化 — 所有 caller 必须用这些函数,
//   绝不允许在别处自己写 `eventType === 'result'` / `=== 'rate_limit_event'` 等。
//   原因:streamParser 把 type+subtype 拼成 'result/success' 等,过去
//   RoleInstance.js 用了 `=== 'result'` 不匹配 → status 永久卡 busy(Bug 1)。
//
// 这里集中维护 mate 关心的所有 eventType 谓词,新增 event type 时只改这里。
function isResult(eventType) {
  return typeof eventType === 'string' && eventType.startsWith('result');
}
function isAssistantFinal(eventType) {
  return eventType === 'assistant';
}
function isSystemInit(eventType) {
  return eventType === 'system/init';
}
function isStreamPartial(eventType) {
  return eventType === 'stream_event';
}
function isRateLimitEvent(eventType) {
  return eventType === 'rate_limit_event';
}
function isUserEcho(eventType) {
  return eventType === 'user';
}

// Helper: extract assistant text from an `assistant` event.
function extractAssistantText(ev) {
  if (ev?.type !== 'assistant' || !ev.message || !Array.isArray(ev.message.content)) return '';
  return ev.message.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('');
}

// Helper: extract tool_use entries.
function extractToolUses(ev) {
  if (ev?.type !== 'assistant' || !ev.message || !Array.isArray(ev.message.content)) return [];
  return ev.message.content
    .filter((c) => c.type === 'tool_use')
    .map((c) => ({ id: c.id, name: c.name, input: c.input }));
}

// Helper: extract tool_results from a `user` event (claude wraps tool results as user msgs).
function extractToolResults(ev) {
  if (ev?.type !== 'user' || !ev.message || !Array.isArray(ev.message.content)) return [];
  return ev.message.content
    .filter((c) => c.type === 'tool_result')
    .map((c) => {
      const text = typeof c.content === 'string'
        ? c.content
        : Array.isArray(c.content)
        ? c.content.map((x) => x.text || '').join('')
        : JSON.stringify(c.content);
      return { tool_use_id: c.tool_use_id, is_error: !!c.is_error, content: text };
    });
}

// Helper: extract text delta from a stream_event.
function extractTextDelta(ev) {
  if (ev?.type !== 'stream_event') return null;
  const sub = ev.event;
  if (sub?.type === 'content_block_delta' && sub.delta?.type === 'text_delta') {
    return sub.delta.text;
  }
  return null;
}

module.exports = {
  StreamParser,
  isResultError,
  // [arch-debt §14] eventType 谓词中心化
  isResult,
  isAssistantFinal,
  isSystemInit,
  isStreamPartial,
  isRateLimitEvent,
  isUserEcho,
  extractAssistantText,
  extractToolUses,
  extractToolResults,
  extractTextDelta,
  MAX_LINE_BYTES,
};
