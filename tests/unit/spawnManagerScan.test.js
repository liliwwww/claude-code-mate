// [需求@2026-06-12 Phase 2E §4 §13] _runTtlScan stuck busy unstick + disconnected 老化单测
//
// SpawnManager 跟 db / bus / RoleInstance 耦合较紧,这里只测 _runTtlScan 内部分支逻辑。
// 用 mock instances Map + mock bus.publish 验证状态翻转 + 事件发布。

const path = require('node:path');
const { describe, it, expect } = require('../_framework');

// stub messageBus + db
const busCalls = [];
const fakeBus = { publish: (topic, payload) => busCalls.push({ topic, payload }) };
const fakeDb = {
  db: {},
  stmts: {
    setInstanceDied: { run: () => {} },
  },
  recordMessage: () => 1,
  recordEvent: () => {},
};
const fakeConfig = {
  ttlScanIntervalMin: 5,
  ttlWarnBeforeMin: 15,
  stuckBusyThresholdMin: 5,
  disconnectedKeepPerGroup: 3,
  globalMaxClaudeProcesses: 8,
};

const busPath = path.resolve(__dirname, '../../server/messageBus.js');
const dbPath = path.resolve(__dirname, '../../server/db.js');
const configPath = path.resolve(__dirname, '../../server/config.js');

require.cache[busPath] = { exports: fakeBus };
require.cache[dbPath] = { exports: fakeDb };
require.cache[configPath] = { exports: fakeConfig };

// 也要 mock roleCatalog 和 RoleInstance (SpawnManager 依赖)
const rcPath = path.resolve(__dirname, '../../server/roles/RoleCatalog.js');
require.cache[rcPath] = { exports: { get: () => null, list: () => [], central: () => null, load: () => {} } };
const tsPath = path.resolve(__dirname, '../../server/threads/ThreadStore.js');
require.cache[tsPath] = { exports: { get: () => null, list: () => [], setStage: () => null, bindInstance: () => {}, touch: () => {} } };
const thPath = path.resolve(__dirname, '../../server/system-agent/ThreadHooks.js');
require.cache[thPath] = { exports: { onResultEvent: async () => null } };
const mdPath = path.resolve(__dirname, '../../server/system-agent/MarkerDetector.js');
require.cache[mdPath] = { exports: { detect: () => [] } };
const qsPath = path.resolve(__dirname, '../../server/quota/QuotaState.js');
require.cache[qsPath] = { exports: { ingest: () => null, isPaused: () => false } };

// 清缓存,fresh require
const smPath = path.resolve(__dirname, '../../server/spawn/SpawnManager.js');
delete require.cache[smPath];
const spawnManager = require(smPath);

function makeMockInstance({ id, status, projectId = 1, roleName = 'planA-R', sessionTtlHours = 8, lastActiveAt = Date.now() }) {
  return {
    id,
    status,
    projectId,
    role: { name: roleName, sessionTtlHours },
    displayName: id,
    lastActiveAt,
    diedAt: null,
    _setStatus(s) { this.status = s; this.lastActiveAt = Date.now(); },
    snapshot() { return { id: this.id, status: this.status }; },
  };
}

function reset() {
  spawnManager.instances.clear();
  busCalls.length = 0;
}

describe('SpawnManager._runTtlScan stuck busy unstick', () => {
  it('busy < 5min → no unstick', () => {
    reset();
    const inst = makeMockInstance({ id: 'A', status: 'busy', lastActiveAt: Date.now() - 2 * 60 * 1000 });
    spawnManager.instances.set('A', inst);
    spawnManager._runTtlScan();
    expect(inst.status).toBe('busy');
    expect(busCalls.some((c) => c.topic === 'instance.unstuck')).toBe(false);
  });

  it('busy > 5min → unstick (status flipped to idle + event)', () => {
    reset();
    const inst = makeMockInstance({ id: 'B', status: 'busy', lastActiveAt: Date.now() - 6 * 60 * 1000 });
    spawnManager.instances.set('B', inst);
    spawnManager._runTtlScan();
    expect(inst.status).toBe('idle');
    expect(busCalls.some((c) => c.topic === 'instance.unstuck' && c.payload.instanceId === 'B')).toBe(true);
  });

  it('idle inst not affected by stuck busy rule', () => {
    reset();
    const inst = makeMockInstance({ id: 'C', status: 'idle', lastActiveAt: Date.now() - 99 * 60 * 1000 });
    spawnManager.instances.set('C', inst);
    spawnManager._runTtlScan();
    expect(inst.status).toBe('idle');
    expect(busCalls.some((c) => c.topic === 'instance.unstuck')).toBe(false);
  });
});

describe('SpawnManager._runTtlScan disconnected aging', () => {
  it('5 disconnected (= keep limit) → no aging', () => {
    reset();
    for (let i = 0; i < 5; i++) {
      spawnManager.instances.set(`d${i}`, makeMockInstance({
        id: `d${i}`, status: 'disconnected', lastActiveAt: Date.now() - (i + 1) * 86400000,
      }));
    }
    // keep limit = 3 in fakeConfig — 但 default 测试是 5。改用 3 keep。
    // Actually fakeConfig 设了 3,所以应该老化 2 个。
    spawnManager._runTtlScan();
    // 留 3,老化 2
    expect(spawnManager.instances.size).toBe(3);
    expect(busCalls.filter((c) => c.topic === 'instance.aged_out').length).toBe(2);
  });

  it('3 disconnected (= keep limit) → no aging', () => {
    reset();
    for (let i = 0; i < 3; i++) {
      spawnManager.instances.set(`x${i}`, makeMockInstance({
        id: `x${i}`, status: 'disconnected', lastActiveAt: Date.now() - i * 86400000,
      }));
    }
    spawnManager._runTtlScan();
    expect(spawnManager.instances.size).toBe(3);
    expect(busCalls.some((c) => c.topic === 'instance.aged_out')).toBe(false);
  });

  it('aging respects (project, role) group independence', () => {
    reset();
    // 4 个 R in proj 1 + 4 个 H in proj 1 → 各保留 3,各老化 1
    for (let i = 0; i < 4; i++) {
      spawnManager.instances.set(`r${i}`, makeMockInstance({
        id: `r${i}`, status: 'disconnected', roleName: 'planA-R', projectId: 1, lastActiveAt: Date.now() - i * 86400000,
      }));
    }
    for (let i = 0; i < 4; i++) {
      spawnManager.instances.set(`h${i}`, makeMockInstance({
        id: `h${i}`, status: 'disconnected', roleName: 'planA-H', projectId: 1, lastActiveAt: Date.now() - i * 86400000,
      }));
    }
    spawnManager._runTtlScan();
    expect(spawnManager.instances.size).toBe(6);  // 3 R + 3 H
    expect(busCalls.filter((c) => c.topic === 'instance.aged_out').length).toBe(2);
  });

  it('aging keeps most-recent (highest lastActiveAt)', () => {
    reset();
    // 5 个 R,lastActiveAt 0/-1/-2/-3/-4 day,keep=3 → 留 0,-1,-2;老化 -3, -4
    const recents = [];
    for (let i = 0; i < 5; i++) {
      const inst = makeMockInstance({
        id: `r${i}`, status: 'disconnected', roleName: 'planA-R', projectId: 1,
        lastActiveAt: Date.now() - i * 86400000,
      });
      spawnManager.instances.set(`r${i}`, inst);
      recents.push(`r${i}`);
    }
    spawnManager._runTtlScan();
    // 留下应该是 r0, r1, r2(最近)
    expect(spawnManager.instances.has('r0')).toBe(true);
    expect(spawnManager.instances.has('r1')).toBe(true);
    expect(spawnManager.instances.has('r2')).toBe(true);
    expect(spawnManager.instances.has('r3')).toBe(false);
    expect(spawnManager.instances.has('r4')).toBe(false);
  });
});
