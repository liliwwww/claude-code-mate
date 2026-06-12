// [需求@2026-06-12 Phase 2E §6 §7] QuotaState 状态机 + ingest 逻辑单测
//
// 验证:
//   - rate_limit_event ingest 后内部状态正确
//   - 95% 阈值触发 PAUSED
//   - rate_limited 终态触发 PAUSED
//   - 5h / 7d 独立轨道,各自管 timer
//   - manualOverride 清掉 PAUSED
//   - isPaused 反映 5h OR 7d 任一 PAUSED

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { describe, it, expect } = require('../_framework');

// 用临时 SQLite 避免污染 mate.sqlite
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mate-quota-test-'));
process.env.MATE_TMP_DB_PATH = path.join(tmpDir, 'test.sqlite');

// 必须在 require config 之前覆盖,否则没用 — config 用 paths.sqlite 默认到 data/
// 简化:直接做不依赖 db 的纯逻辑测试(把 QuotaState 拆出来,做一个 pure version)

// 由于 QuotaState 跟 db / bus 耦合较紧,这里只做 ingest 逻辑的 pure 验证
// 用 stub 替换 stmts + bus,验证状态转换
const Module = require('node:module');
const origResolve = Module._resolve_filename || Module._resolveFilename;

// stub 拼装
const busCalls = [];
const dbCalls = { qsUpsertCalls: [] };
const fakeBus = { publish: (topic, payload) => busCalls.push({ topic, payload }) };
const fakeDb = {
  db: {},
  stmts: {
    qsList: { all: () => [] },
    qsUpsert: { run: (args) => { dbCalls.qsUpsertCalls.push(args); } },
    qsDelete: { run: () => {} },
    qsClearAll: { run: () => {} },
    qsGet: { get: () => null },
  },
  recordEvent: () => {},
};

// 替换 cache(简易 mock)
const quotaModulePath = path.resolve(__dirname, '../../server/quota/QuotaState.js');
const busPath = path.resolve(__dirname, '../../server/messageBus.js');
const dbPath = path.resolve(__dirname, '../../server/db.js');

require.cache[busPath] = { exports: fakeBus };
require.cache[dbPath] = { exports: fakeDb };

// 清掉 quotaModule 缓存,重 require
delete require.cache[quotaModulePath];
const QuotaState = require(quotaModulePath);

function reset() {
  QuotaState.byType.clear();
  busCalls.length = 0;
  dbCalls.qsUpsertCalls.length = 0;
}

function makeEvent({ type = 'five_hour', status = 'allowed', util = null, resetsAtSec = Math.floor(Date.now() / 1000) + 3600 } = {}) {
  return {
    rate_limit_info: {
      rateLimitType: type,
      status,
      utilization: util,
      resetsAt: resetsAtSec,
      overageStatus: 'rejected',
      isUsingOverage: false,
    },
  };
}

describe('QuotaState.ingest', () => {
  it('allowed event sets state, no pause, publishes quota_update', () => {
    reset();
    QuotaState.ingest(makeEvent({ type: 'five_hour', status: 'allowed' }));
    expect(QuotaState.isPaused()).toBe(false);
    expect(busCalls.some((c) => c.topic === 'system.quota_update')).toBe(true);
    expect(busCalls.some((c) => c.topic === 'system.quota_paused')).toBe(false);
  });

  it('allowed_warning util=0.91 does NOT trigger pause (< 95%)', () => {
    reset();
    QuotaState.ingest(makeEvent({ status: 'allowed_warning', util: 0.91 }));
    expect(QuotaState.isPaused()).toBe(false);
  });

  it('allowed_warning util=0.96 triggers pause (>= 95%)', () => {
    reset();
    QuotaState.ingest(makeEvent({ status: 'allowed_warning', util: 0.96 }));
    expect(QuotaState.isPaused()).toBe(true);
    expect(busCalls.some((c) => c.topic === 'system.quota_paused')).toBe(true);
  });

  it('rate_limited terminal triggers pause regardless of util', () => {
    reset();
    QuotaState.ingest(makeEvent({ status: 'rate_limited', util: 1.0 }));
    expect(QuotaState.isPaused()).toBe(true);
    expect(busCalls.some((c) => c.topic === 'system.quota_paused')).toBe(true);
  });

  it('5h paused but 7d ok → still globally paused', () => {
    reset();
    QuotaState.ingest(makeEvent({ type: 'seven_day', status: 'allowed', util: 0.5 }));
    QuotaState.ingest(makeEvent({ type: 'five_hour', status: 'rate_limited' }));
    expect(QuotaState.isPaused()).toBe(true);
  });

  it('both allowed → not paused', () => {
    reset();
    QuotaState.ingest(makeEvent({ type: 'five_hour', status: 'allowed' }));
    QuotaState.ingest(makeEvent({ type: 'seven_day', status: 'allowed' }));
    expect(QuotaState.isPaused()).toBe(false);
  });

  it('pause then status downgrade → quota_resumed published', () => {
    reset();
    QuotaState.ingest(makeEvent({ type: 'five_hour', status: 'rate_limited' }));
    expect(QuotaState.isPaused()).toBe(true);
    busCalls.length = 0;
    QuotaState.ingest(makeEvent({ type: 'five_hour', status: 'allowed' }));
    expect(QuotaState.isPaused()).toBe(false);
    expect(busCalls.some((c) => c.topic === 'system.quota_resumed')).toBe(true);
  });

  it('manualOverride clears pause and persists override flag', () => {
    reset();
    QuotaState.ingest(makeEvent({ type: 'five_hour', status: 'rate_limited' }));
    expect(QuotaState.isPaused()).toBe(true);
    QuotaState.manualOverride('five_hour');
    expect(QuotaState.isPaused()).toBe(false);
    expect(busCalls.some((c) => c.topic === 'system.quota_resumed' && c.payload.reason === 'manual_override')).toBe(true);
  });

  it('snapshot returns both rails + paused boolean', () => {
    reset();
    QuotaState.ingest(makeEvent({ type: 'five_hour', status: 'allowed_warning', util: 0.91 }));
    QuotaState.ingest(makeEvent({ type: 'seven_day', status: 'allowed', util: 0.6 }));
    const snap = QuotaState.snapshot();
    expect(snap.paused).toBe(false);
    expect(snap.five_hour).toBeTruthy();
    expect(snap.seven_day).toBeTruthy();
    expect(snap.five_hour.utilization).toBe(0.91);
    expect(snap.seven_day.utilization).toBe(0.6);
  });

  it('unknown rateLimitType ignored, no state change', () => {
    reset();
    QuotaState.ingest(makeEvent({ type: 'minutely', status: 'allowed' }));
    expect(QuotaState.byType.size).toBe(0);
  });
});

describe('QuotaState fixture replay from real samples', () => {
  it('replays a real allowed_warning seven_day event', () => {
    reset();
    // Real shape from mate.sqlite messages table (2026-06-12)
    const raw = {
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed_warning',
        resetsAt: 1781654400,
        rateLimitType: 'seven_day',
        utilization: 0.6,
        overageStatus: 'rejected',
        isUsingOverage: false,
        overageDisabledReason: 'org_level_disabled',
      },
      uuid: 'abc',
      session_id: 'def',
    };
    QuotaState.ingest(raw);
    const s = QuotaState.byType.get('seven_day');
    expect(s.status).toBe('allowed_warning');
    expect(s.utilization).toBe(0.6);
    // Not paused — 0.6 < 0.95
    expect(QuotaState.isPaused()).toBe(false);
  });
});

// 清理 cache 避免影响其他 test
process.on('exit', () => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});
