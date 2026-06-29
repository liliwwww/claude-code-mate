// [需求@2026-06-29 #171] MarkdownExporter 单测
const { describe, it, expect } = require('../_framework');
const { parseRange, filterByRange, buildMarkdown } = require('../../server/threads/MarkdownExporter');

describe('parseRange', () => {
  it('all → ms=null', () => {
    expect(parseRange('all').ms).toBe(null);
  });
  it('1d / 3d / 7d → 对应毫秒', () => {
    expect(parseRange('1d').ms).toBe(86400_000);
    expect(parseRange('3d').ms).toBe(3 * 86400_000);
    expect(parseRange('7d').ms).toBe(7 * 86400_000);
  });
  it('unknown range fallback to all', () => {
    expect(parseRange('xyz').ms).toBe(null);
    expect(parseRange(undefined).ms).toBe(null);
  });
});

describe('filterByRange', () => {
  const now = 1000_000_000;
  const msgs = [
    { ts: now - 10 * 86400_000, event_type: 'user', payload: {} }, // 10天前
    { ts: now - 5 * 86400_000, event_type: 'user', payload: {} },  // 5天前
    { ts: now - 2 * 86400_000, event_type: 'user', payload: {} },  // 2天前
    { ts: now - 6 * 3600_000, event_type: 'user', payload: {} },   // 6h前
  ];
  it('all 返回全部', () => {
    expect(filterByRange(msgs, parseRange('all'), now).length).toBe(4);
  });
  it('1d 只保留 24h 内', () => {
    expect(filterByRange(msgs, parseRange('1d'), now).length).toBe(1);
  });
  it('3d 保留 3 天内', () => {
    expect(filterByRange(msgs, parseRange('3d'), now).length).toBe(2);
  });
  it('7d 保留 7 天内', () => {
    expect(filterByRange(msgs, parseRange('7d'), now).length).toBe(3);
  });
});

describe('buildMarkdown', () => {
  const thread = {
    slug: 't-test-x',
    title: 'TiDB 简介',
    stage: 'discussing',
    outcome: null,
    created_at: 1700_000_000_000,
    updated_at: 1700_001_000_000,
  };

  it('空消息 → 含"无消息"提示', () => {
    const md = buildMarkdown(thread, [], { range: { ms: null, label: '全部' } });
    expect(md.includes('# TiDB 简介')).toBe(true);
    expect(md.includes('该时间范围内无消息')).toBe(true);
  });

  it('user + assistant 配对正确拼接', () => {
    const msgs = [
      {
        ts: 1700_000_500_000,
        event_type: 'user',
        direction: 'user_to_role',
        instance_id: 'mate-R.aaa',
        payload: { message: { content: [{ type: 'text', text: '什么是 TiDB?' }] } },
      },
      {
        ts: 1700_000_600_000,
        event_type: 'assistant',
        direction: 'role_to_user',
        instance_id: 'mate-R.aaa',
        payload: { message: { content: [{ type: 'text', text: 'TiDB 是分布式 NewSQL...' }] } },
      },
    ];
    const md = buildMarkdown(thread, msgs, { range: { ms: null, label: '全部' } });
    expect(md.includes('👤 user')).toBe(true);
    expect(md.includes('什么是 TiDB?')).toBe(true);
    expect(md.includes('🤖 mate-R (需求)')).toBe(true);
    expect(md.includes('TiDB 是分布式 NewSQL...')).toBe(true);
  });

  it('剥离 task tag 前缀', () => {
    const msgs = [
      {
        ts: 1700_000_500_000,
        event_type: 'user',
        direction: 'user_to_role',
        instance_id: 'mate-R.aaa',
        payload: { message: { content: [{ type: 'text', text: '[Thread: t-test-x | Project: 7]\n\n真实问题内容' }] } },
      },
    ];
    const md = buildMarkdown(thread, msgs, { range: { ms: null, label: '全部' } });
    expect(md.includes('真实问题内容')).toBe(true);
    expect(md.includes('[Thread: t-test-x')).toBe(false);
  });

  it('Header 含 outcome / range 标签', () => {
    const thread2 = { ...thread, outcome: 'verified' };
    const md = buildMarkdown(thread2, [], { range: { ms: 86400_000, label: '近 1 天' } });
    expect(md.includes('| **outcome** | verified |')).toBe(true);
    expect(md.includes('| **导出范围** | 近 1 天 |')).toBe(true);
  });
});
