// [需求@2026-06-10] 单测:MarkerDetector — 状态机的核心解析逻辑
//   纯函数,零 IO,毫秒级。覆盖所有 marker 形态 + 边界情况。

const { describe, it, expect } = require('../_framework');
const M = require('../../server/spawn/MarkerDetector');

describe('MarkerDetector.detect', () => {
  it('handoff with target + reason', () => {
    const out = M.detect('queue 已 ready。\n<mate:handoff target="mate-H" reason="需求 queued" />');
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ kind: 'handoff', target: 'mate-H', reason: '需求 queued', taskSlug: null });
  });

  it('handoff with target only (no reason)', () => {
    const out = M.detect('<mate:handoff target="mate-B" />');
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ kind: 'handoff', target: 'mate-B', reason: '', taskSlug: null });
  });

  it('done with summary', () => {
    const out = M.detect('完成。<mate:done summary="Tetris 已交付" />');
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ kind: 'done', summary: 'Tetris 已交付' });
  });

  it('done without summary', () => {
    const out = M.detect('<mate:done />');
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ kind: 'done', summary: '' });
  });

  it('blocked with severity', () => {
    const out = M.detect('<mate:blocked question="单机还是联机?" severity="high" />');
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ kind: 'blocked', question: '单机还是联机?', severity: 'high' });
  });

  it('blocked default severity = mid', () => {
    const out = M.detect('<mate:blocked question="???" />');
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe('mid');
  });

  // [Phase 4 @2026-06-17] bounce 协议
  it('bounce with reason', () => {
    const out = M.detect('<mate:bounce reason="scope unclear" />');
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ kind: 'bounce', reason: 'scope unclear' });
  });

  it('bounce 含中文 + 特殊字符', () => {
    const out = M.detect('<mate:bounce reason="需求歧义:A 还是 B?" />');
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('bounce');
    expect(out[0].reason).toBe('需求歧义:A 还是 B?');
  });

  it('looksLikeMarker 含 bounce', () => {
    expect(M.looksLikeMarker('<mate:bounce')).toBe(true);
    expect(M.looksLikeMarker('not a marker')).toBe(false);
  });

  it('strip 也清 bounce', () => {
    const cleaned = M.strip('text <mate:bounce reason="x" /> tail');
    expect(cleaned).toBe('text  tail');
  });

  it('empty text → []', () => {
    expect(M.detect('')).toEqual([]);
    expect(M.detect(null)).toEqual([]);
    expect(M.detect(undefined)).toEqual([]);
  });

  it('plain text without markers → []', () => {
    expect(M.detect('Hello world, no markers here.')).toEqual([]);
    expect(M.detect('user 想做 Tetris,我先了解需求。')).toEqual([]);
  });

  it('handoff + blocked in one message → both detected', () => {
    const out = M.detect('<mate:handoff target="mate-B" /> <mate:blocked question="OS?" />');
    expect(out).toHaveLength(2);
  });

  it('case-insensitive marker tag matches', () => {
    const out = M.detect('<MATE:HANDOFF TARGET="planA-H" />');
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('handoff');
  });

  it('marker buried in middle of prose still detected', () => {
    const txt = 'Step 1: 写 queue。\n<mate:handoff target="mate-H" />\nStep 2: 等编排。';
    const out = M.detect(txt);
    expect(out).toHaveLength(1);
  });
});

describe('MarkerDetector.strip', () => {
  it('removes single marker cleanly', () => {
    const t = M.strip('我们继续。\n<mate:handoff target="mate-H" reason="OK" />\n');
    expect(t).toBe('我们继续。');
  });

  it('removes done marker', () => {
    const t = M.strip('交付。<mate:done summary="ok" />');
    expect(t).toBe('交付。');
  });

  it('removes all markers when multiple present', () => {
    const t = M.strip('A. <mate:handoff target="mate-H" /> B. <mate:blocked question="??" />');
    expect(t).toBe('A.  B.');
  });

  it('collapses excess newlines after stripping', () => {
    const t = M.strip('Line 1\n\n\n\n<mate:handoff target="mate-B" />\n\n\n\nLine 2');
    expect(t).toMatch(/^Line 1\n+Line 2$/);
  });

  it('empty / null input is safe', () => {
    expect(M.strip('')).toBe('');
    expect(M.strip(null)).toBe(null);
  });
});
