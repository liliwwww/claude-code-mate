// ============================================================================
// MODULE CONTRACT(架构 SSOT:docs/architecture.md §3 §4 §6)
// ----------------------------------------------------------------------------
// 层:L2 Process Control
// 责任:后台 TTL scanner — 周期性扫所有 instance,3 个分支:
//   1. TTL 临近 / 过期 warn(instance.ttl_soon / .ttl_expired)
//   2. 卡死 busy 自动 unstick(idle > N min 翻 idle + emit instance.unstuck)
//   3. disconnected 老化(每 (project, role) 留 N 个最近,其余 setStatus dead)
// 公共 API:start({ instances, getStmts, getRecordEvent }) / stop() /
//   runOnce({ instances, getStmts, getRecordEvent })  (单测用)
// 允许依赖:config / messageBus
// 禁止:
//   - 自己持有 instances Map(由 SpawnManager 注入)
//   - 替 LLM 决策
//   - 写业务实体到 db(只改 instance.status + emit 事件)
// ============================================================================
//
// [arch §1.1 ✅ 2026-06-13] 从 SpawnManager 抽出,SpawnManager 仅做 wiring。

const bus = require('../messageBus');
const config = require('../config');

let _interval = null;
let _deps = null;  // { instances, getStmts, getRecordEvent }

function start(deps) {
  if (_interval) return;
  _deps = deps;
  const intervalMs = (config.ttlScanIntervalMin || 5) * 60 * 1000;
  _interval = setInterval(() => runOnce(_deps), intervalMs);
  console.log(`[ScanRecycler] started (every ${config.ttlScanIntervalMin}m)`);
}

function stop() {
  if (_interval) { clearInterval(_interval); _interval = null; }
  _deps = null;
}

/**
 * 执行一次扫描。供 setInterval / 单测调用。
 *
 * @param {Object} deps
 * @param {Map}    deps.instances           instance.id → RoleInstance
 * @param {Function} deps.getStmts          () → db.stmts(避免循环 require)
 * @param {Function} deps.getRecordEvent    () → recordEvent fn
 */
function runOnce(deps) {
  if (!deps) return;
  const { instances, getStmts, getRecordEvent } = deps;
  const now = Date.now();
  const warnAheadMs = (config.ttlWarnBeforeMin || 15) * 60 * 1000;
  const STUCK_BUSY_THRESHOLD_MS = (config.stuckBusyThresholdMin || 5) * 60 * 1000;
  const DISC_KEEP_PER_GROUP = config.disconnectedKeepPerGroup || 5;

  // 分支 1+2:TTL warn / stuck busy unstick
  for (const inst of instances.values()) {
    if (inst.status === 'dead') continue;

    // [需求@2026-06-12 Phase 2E §4] 卡死 busy 自动 unstick
    if (inst.status === 'busy' && (now - inst.lastActiveAt) > STUCK_BUSY_THRESHOLD_MS) {
      const stuckMin = Math.round((now - inst.lastActiveAt) / 60000);
      console.warn(`[ScanRecycler] stuck busy ${inst.id} (idle ${stuckMin}m) → forcing idle`);
      inst._setStatus('idle');
      bus.publish('instance.unstuck', {
        instanceId: inst.id,
        displayName: inst.displayName,
        roleName: inst.role.name,
        projectId: inst.projectId,
        stuckMinutes: stuckMin,
        ts: now,
      });
      try { getRecordEvent()('instance.unstuck', { stuckMinutes: stuckMin }, { projectId: inst.projectId, instanceId: inst.id }); } catch {}
      continue;
    }

    const ttlMs = (inst.role.sessionTtlHours || 4) * 3600 * 1000;
    const expiresAt = inst.lastActiveAt + ttlMs;
    const remainMs = expiresAt - now;
    if (remainMs < 0) {
      if (!inst._ttlExpiredWarned) {
        inst._ttlExpiredWarned = true;
        inst._ttlSoonWarned = false;
        bus.publish('instance.ttl_expired', {
          instanceId: inst.id,
          displayName: inst.displayName,
          roleName: inst.role.name,
          projectId: inst.projectId,
          idleHours: +(((now - inst.lastActiveAt) / 3600000)).toFixed(1),
          ttlHours: inst.role.sessionTtlHours,
          ts: now,
        });
      }
    } else if (remainMs < warnAheadMs) {
      if (!inst._ttlSoonWarned) {
        inst._ttlSoonWarned = true;
        bus.publish('instance.ttl_soon', {
          instanceId: inst.id,
          displayName: inst.displayName,
          roleName: inst.role.name,
          projectId: inst.projectId,
          minutesUntilExpiry: Math.round(remainMs / 60000),
          ttlHours: inst.role.sessionTtlHours,
          ts: now,
        });
      }
    } else {
      inst._ttlSoonWarned = false;
      inst._ttlExpiredWarned = false;
    }
  }

  // 分支 3:[需求@2026-06-12 Phase 2E §13] disconnected 老化
  const discGroups = new Map();
  for (const inst of instances.values()) {
    if (inst.status !== 'disconnected') continue;
    const key = `${inst.projectId}|${inst.role.name}`;
    if (!discGroups.has(key)) discGroups.set(key, []);
    discGroups.get(key).push(inst);
  }
  let agedOut = 0;
  for (const [, list] of discGroups) {
    if (list.length <= DISC_KEEP_PER_GROUP) continue;
    list.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    const expired = list.slice(DISC_KEEP_PER_GROUP);
    for (const inst of expired) {
      try { getStmts().setInstanceDied.run(now, inst.id); } catch {}
      inst._setStatus('dead');
      inst.diedAt = now;
      instances.delete(inst.id);
      agedOut++;
      bus.publish('instance.aged_out', {
        instanceId: inst.id,
        displayName: inst.displayName,
        roleName: inst.role.name,
        projectId: inst.projectId,
        ageDays: +(((now - inst.lastActiveAt) / 86400000)).toFixed(1),
        ts: now,
      });
    }
  }
  if (agedOut > 0) {
    console.log(`[ScanRecycler] aged out ${agedOut} disconnected instances`);
    try { getRecordEvent()('disconnected.aged_out', { count: agedOut, keep: DISC_KEEP_PER_GROUP }); } catch {}
  }
}

module.exports = { start, stop, runOnce };
