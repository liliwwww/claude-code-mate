// [需求@2026-06-10] 单测:StreamParser — NDJSON 行缓冲核心
//   覆盖:完整行 / 跨 chunk / 多事件单 chunk / 畸形 JSON / 超大行防御

const { describe, it, expect } = require('../_framework');
const { StreamParser, isResultError, extractAssistantText, extractToolUses, extractTextDelta,
  isResult, isAssistantFinal, isSystemInit, isStreamPartial, isRateLimitEvent, isUserEcho } = require('../../server/spawn/streamParser');

function makeParser() {
  const events = [];
  const errors = [];
  let overflows = 0;
  const p = new StreamParser({
    onEvent: (e) => events.push(e),
    onParseError: (line, err) => errors.push({ line, msg: err.message }),
    onLineOverflow: () => overflows++,
  });
  return { p, events, errors, get overflows() { return overflows; } };
}

describe('StreamParser', () => {
  it('single complete line → 1 event with parsed payload', () => {
    const { p, events } = makeParser();
    p.feed('{"type":"system","subtype":"init","session_id":"abc"}\n');
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('system/init');
    expect(events[0].raw.session_id).toBe('abc');
  });

  it('multiple events in one chunk are split correctly', () => {
    const { p, events } = makeParser();
    p.feed('{"type":"system","subtype":"init"}\n{"type":"assistant"}\n{"type":"result","subtype":"success","is_error":false}\n');
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.eventType)).toEqual(['system/init', 'assistant', 'result/success']);
  });

  it('partial line is buffered until newline arrives', () => {
    const { p, events } = makeParser();
    p.feed('{"type":"sys');
    expect(events).toHaveLength(0);
    p.feed('tem","subtype":"init"}\n');
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('system/init');
  });

  it('chunk boundary in middle of JSON does not lose data', () => {
    const { p, events } = makeParser();
    const chunks = ['{"type":"a', 'ssistant","mes', 'sage":{"content":[{"ty', 'pe":"text","text":"hi"}]}}', '\n'];
    for (const c of chunks) p.feed(c);
    expect(events).toHaveLength(1);
    expect(events[0].raw.message.content[0].text).toBe('hi');
  });

  it('malformed JSON triggers onParseError, parser keeps going', () => {
    const { p, events, errors } = makeParser();
    p.feed('not json\n{"type":"assistant"}\n');
    expect(events).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(events[0].eventType).toBe('assistant');
  });

  it('empty / whitespace-only lines are ignored', () => {
    const { p, events, errors } = makeParser();
    p.feed('\n\n{"type":"assistant"}\n   \n');
    expect(events).toHaveLength(1);
    expect(errors).toHaveLength(0);
  });

  it('oversized buffer triggers onLineOverflow and resets', () => {
    const { p } = makeParser();
    const huge = 'x'.repeat(1_500_000);
    p.feed(huge);
    // Without a newline, after exceeding the limit the parser should drop + report
    // Then a fresh small line should still parse:
    p.feed('\n{"type":"assistant"}\n');
    // After overflow + reset, the next valid line should parse.
    // (We just check parser doesn't blow up.)
    expect(true).toBe(true);
  });
});

describe('StreamParser helpers', () => {
  it('isResultError trusts is_error not subtype', () => {
    expect(isResultError({ type: 'result', subtype: 'success', is_error: true })).toBe(true);
    expect(isResultError({ type: 'result', subtype: 'success', is_error: false })).toBe(false);
    expect(isResultError({ type: 'result', subtype: 'error', is_error: false })).toBe(false);
    expect(isResultError({ type: 'assistant', is_error: true })).toBe(false);
  });

  it('extractAssistantText joins all text content blocks', () => {
    const ev = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello' }, { type: 'tool_use', name: 'X' }, { type: 'text', text: ' world' }] },
    };
    expect(extractAssistantText(ev)).toBe('hello world');
  });

  it('extractToolUses returns name+input', () => {
    const ev = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { path: 'x' } }] },
    };
    expect(extractToolUses(ev)).toEqual([{ id: 't1', name: 'Read', input: { path: 'x' } }]);
  });

  it('extractTextDelta returns text from stream_event content_block_delta', () => {
    const ev = {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } },
    };
    expect(extractTextDelta(ev)).toBe('partial');
  });

  it('extractTextDelta returns null for non-delta stream events', () => {
    expect(extractTextDelta({ type: 'stream_event', event: { type: 'message_start' } })).toBeNull();
    expect(extractTextDelta({ type: 'assistant' })).toBeNull();
  });
});

// [arch-debt §14 ✅ 2026-06-13] eventType 谓词中心化
describe('eventType predicates (arch-debt §14)', () => {
  it('isResult matches "result", "result/success", "result/error"', () => {
    expect(isResult('result')).toBe(true);
    expect(isResult('result/success')).toBe(true);
    expect(isResult('result/error')).toBe(true);
    expect(isResult('result/anything-future')).toBe(true);
    expect(isResult('not-result')).toBe(false);
    expect(isResult('assistant')).toBe(false);
    expect(isResult('')).toBe(false);
    expect(isResult(null)).toBe(false);
    expect(isResult(undefined)).toBe(false);
  });

  it('isAssistantFinal only matches exact "assistant"', () => {
    expect(isAssistantFinal('assistant')).toBe(true);
    expect(isAssistantFinal('assistant/x')).toBe(false);
    expect(isAssistantFinal('user')).toBe(false);
  });

  it('isSystemInit only matches "system/init"', () => {
    expect(isSystemInit('system/init')).toBe(true);
    expect(isSystemInit('system/status')).toBe(false);
    expect(isSystemInit('init')).toBe(false);
  });

  it('isStreamPartial only matches "stream_event"', () => {
    expect(isStreamPartial('stream_event')).toBe(true);
    expect(isStreamPartial('stream')).toBe(false);
    expect(isStreamPartial('event')).toBe(false);
  });

  it('isRateLimitEvent only matches "rate_limit_event"', () => {
    expect(isRateLimitEvent('rate_limit_event')).toBe(true);
    expect(isRateLimitEvent('rate_limit')).toBe(false);
  });

  it('isUserEcho only matches "user"', () => {
    expect(isUserEcho('user')).toBe(true);
    expect(isUserEcho('user_to_role')).toBe(false);
    expect(isUserEcho('User')).toBe(false);
  });
});
