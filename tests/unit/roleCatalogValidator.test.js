// [arch-debt §7 ✅ 2026-06-13] RoleCatalog frontmatter validator 单测
//
// 测试 validateField:type / enum / range 各失败路径 + 各成功路径

const { describe, it, expect } = require('../_framework');
const RoleCatalog = require('../../server/roles/RoleCatalog');
const { ROLE_SCHEMA, validateField } = RoleCatalog;

// stub console.warn 不污染输出
const origWarn = console.warn;
const captured = [];
console.warn = (...args) => { captured.push(args.join(' ')); };
process.on('exit', () => { console.warn = origWarn; });

function reset() { captured.length = 0; }

describe('RoleCatalog.ROLE_SCHEMA shape', () => {
  it('has all expected fields', () => {
    const expected = ['name', 'type', 'parallelism_limit', 'is_central', 'session_ttl_hours',
      'display_color', 'allowed_tools', 'allow_rules', 'permission_mode',
      'skill_command', 'peer_visibility'];
    for (const k of expected) {
      expect(k in ROLE_SCHEMA).toBe(true);
    }
  });

  it('required fields marked correctly', () => {
    expect(ROLE_SCHEMA.name.required).toBe(true);
    expect(ROLE_SCHEMA.type.required).toBe(true);
    expect(ROLE_SCHEMA.parallelism_limit.required).toBe(true);
    expect(ROLE_SCHEMA.is_central.required || false).toBe(false);
  });
});

describe('validateField type checks', () => {
  it('string accepts string', () => {
    reset();
    const r = validateField('test.md', 'name', 'planA-R', ROLE_SCHEMA.name);
    expect(r.ok).toBe(true);
    expect(captured.length).toBe(0);
  });

  it('string rejects number', () => {
    reset();
    const r = validateField('test.md', 'name', 42, ROLE_SCHEMA.name);
    expect(r.ok).toBe(false);
    expect(captured.some((s) => s.includes('must be string'))).toBe(true);
  });

  it('integer accepts integer', () => {
    reset();
    const r = validateField('test.md', 'parallelism_limit', 5, ROLE_SCHEMA.parallelism_limit);
    expect(r.ok).toBe(true);
  });

  it('integer rejects float', () => {
    reset();
    const r = validateField('test.md', 'parallelism_limit', 5.5, ROLE_SCHEMA.parallelism_limit);
    expect(r.ok).toBe(false);
    expect(captured.some((s) => s.includes('must be integer'))).toBe(true);
  });

  it('boolean accepts boolean', () => {
    reset();
    const r = validateField('test.md', 'is_central', true, ROLE_SCHEMA.is_central);
    expect(r.ok).toBe(true);
  });

  it('boolean rejects string "true"', () => {
    reset();
    const r = validateField('test.md', 'is_central', 'true', ROLE_SCHEMA.is_central);
    expect(r.ok).toBe(false);
  });

  it('array accepts array', () => {
    reset();
    const r = validateField('test.md', 'allowed_tools', ['Read', 'Write'], ROLE_SCHEMA.allowed_tools);
    expect(r.ok).toBe(true);
  });

  it('array rejects string', () => {
    reset();
    const r = validateField('test.md', 'allowed_tools', 'Read', ROLE_SCHEMA.allowed_tools);
    expect(r.ok).toBe(false);
  });
});

describe('validateField enum checks', () => {
  it('valid type enum passes', () => {
    reset();
    const r = validateField('test.md', 'type', 'orchestrator', ROLE_SCHEMA.type);
    expect(r.ok).toBe(true);
  });

  it('invalid type enum fails with helpful message', () => {
    reset();
    const r = validateField('test.md', 'type', 'wizard', ROLE_SCHEMA.type);
    expect(r.ok).toBe(false);
    expect(captured.some((s) => s.includes('not in allowed'))).toBe(true);
  });

  it('valid permission_mode enum', () => {
    reset();
    const r = validateField('test.md', 'permission_mode', 'dontAsk', ROLE_SCHEMA.permission_mode);
    expect(r.ok).toBe(true);
  });

  it('invalid permission_mode rejected', () => {
    reset();
    const r = validateField('test.md', 'permission_mode', 'autoApprove', ROLE_SCHEMA.permission_mode);
    expect(r.ok).toBe(false);
  });
});

describe('validateField range checks', () => {
  it('parallelism_limit=1 OK (min)', () => {
    reset();
    expect(validateField('test.md', 'parallelism_limit', 1, ROLE_SCHEMA.parallelism_limit).ok).toBe(true);
  });

  it('parallelism_limit=50 OK (max)', () => {
    reset();
    expect(validateField('test.md', 'parallelism_limit', 50, ROLE_SCHEMA.parallelism_limit).ok).toBe(true);
  });

  it('parallelism_limit=0 below min', () => {
    reset();
    const r = validateField('test.md', 'parallelism_limit', 0, ROLE_SCHEMA.parallelism_limit);
    expect(r.ok).toBe(false);
    expect(captured.some((s) => s.includes('below min'))).toBe(true);
  });

  it('parallelism_limit=51 above max', () => {
    reset();
    const r = validateField('test.md', 'parallelism_limit', 51, ROLE_SCHEMA.parallelism_limit);
    expect(r.ok).toBe(false);
    expect(captured.some((s) => s.includes('above max'))).toBe(true);
  });

  it('session_ttl_hours=24 within range', () => {
    reset();
    expect(validateField('test.md', 'session_ttl_hours', 24, ROLE_SCHEMA.session_ttl_hours).ok).toBe(true);
  });

  it('session_ttl_hours=500 above max', () => {
    reset();
    expect(validateField('test.md', 'session_ttl_hours', 500, ROLE_SCHEMA.session_ttl_hours).ok).toBe(false);
  });
});

describe('catalog.load happy path (real roles/*.md)', () => {
  it('loads R/H/B/C without errors', () => {
    reset();
    RoleCatalog.load();
    const names = RoleCatalog.list().map((r) => r.name).sort();
    expect(names).toEqual(['execB', 'planA-H', 'planA-R', 'testC']);
    // 有 warn 也行(未知字段历史遗留),但不能有 invalid
    const invalidWarns = captured.filter((s) => s.includes('must be') || s.includes('not in allowed') || s.includes('above max') || s.includes('below min'));
    expect(invalidWarns).toHaveLength(0);
  });

  it('exactly one role is_central', () => {
    reset();
    RoleCatalog.load();
    const centrals = RoleCatalog.list().filter((r) => r.isCentral);
    expect(centrals).toHaveLength(1);
    expect(centrals[0].name).toBe('planA-H');
  });
});
