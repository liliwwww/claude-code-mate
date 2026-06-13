// [arch-debt §12 ✅ 2026-06-13] Adversarial MarkerDetector 测试
//
// 跑 fixture cases.js 里的每个 case,验证 detect / looksLikeMarker 行为正确。
//
// 防止再次重蹈 2026-06-13 的 reason 含 JSON `"` 截断 bug。

const { describe, it, expect } = require('../_framework');
const M = require('../../server/spawn/MarkerDetector');
const cases = require('../fixtures/marker_adversarial/cases');

describe('MarkerDetector adversarial fixtures', () => {
  for (const c of cases) {
    it(c.name, () => {
      const result = M.detect(c.text);
      expect(result).toHaveLength(c.expect.count);
      if (c.expect.count > 0 && c.expect.kind) {
        // 找一个匹配 kind 的 marker
        const m = result.find((x) => x.kind === c.expect.kind);
        if (!m) {
          throw new Error(`expected kind=${c.expect.kind} not found in [${result.map((r) => r.kind).join(',')}]`);
        }
        if (c.expect.target) expect(m.target).toBe(c.expect.target);
        if (c.expect.reason !== undefined) expect(m.reason).toBe(c.expect.reason);
        if (c.expect.summary !== undefined) expect(m.summary).toBe(c.expect.summary);
        if (c.expect.question !== undefined) expect(m.question).toBe(c.expect.question);
        if (c.expect.severity !== undefined) expect(m.severity).toBe(c.expect.severity);
        // 松散匹配:reason contains
        if (c.reasonContains) {
          const r = m.reason || m.summary || m.question || '';
          if (!r.includes(c.reasonContains)) {
            throw new Error(`expected reason to contain "${c.reasonContains}", got "${r.slice(0, 200)}"`);
          }
        }
        if (c.reasonMinLength) {
          const r = m.reason || m.summary || m.question || '';
          if (r.length < c.reasonMinLength) {
            throw new Error(`expected reason length >= ${c.reasonMinLength}, got ${r.length}`);
          }
        }
      }
      // looksLikeMarker 验证
      if (c.looksLikeMarker !== undefined) {
        expect(M.looksLikeMarker(c.text)).toBe(c.looksLikeMarker);
      }
    });
  }
});

describe('MarkerDetector.looksLikeMarker', () => {
  it('returns false for null / undefined / empty', () => {
    expect(M.looksLikeMarker(null)).toBe(false);
    expect(M.looksLikeMarker(undefined)).toBe(false);
    expect(M.looksLikeMarker('')).toBe(false);
  });
  it('returns true for any <mate:* substring', () => {
    expect(M.looksLikeMarker('blah <mate:handoff blah blah')).toBe(true);
    expect(M.looksLikeMarker('<mate:done')).toBe(true);
    expect(M.looksLikeMarker('see <mate:blocked here')).toBe(true);
  });
  it('returns false for non-mate XML-like tags', () => {
    expect(M.looksLikeMarker('<other:handoff />')).toBe(false);
    expect(M.looksLikeMarker('<mate-X handoff />')).toBe(false);
  });
});
