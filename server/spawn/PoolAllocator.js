// ============================================================================
// MODULE CONTRACT(架构 SSOT:docs/architecture.md §3 §4 §6)
// ----------------------------------------------------------------------------
// 层:L2 Process Control
// 责任:per-(project, role) 池槽位管理 — find/acquire/create/backfill。
//   不管 lifecycle wiring(那是 SpawnManager 的事);不管派工(那是 marker
//   dispatcher 的事)。
// 公共 API:
//   findPoolInstance(instances, projectId, roleName, slot)
//   findNextFreePoolSlot(instances, projectId, roleName, maxSlot)
//   acquire({ instances, projectId, projectRootDir, role, requestedSlot,
//             threadSlug, createPoolInstance })
//   create({ instances, projectId, projectRootDir, role, poolSlot, threadSlug,
//            checkGlobalCap, wireListeners, persistInstance })
//   backfillFromDisk({ instances, roleCatalog, stmts, db })
// 允许依赖:./RoleInstance / messageBus / db(下层模块)
// 禁止:
//   - 持有 instances Map(SpawnManager 注入)
//   - 替 LLM 决策(选 instance 用静态规则)
//   - 写 thread / message 持久化
// ============================================================================
//
// [arch §1.2 ✅ 2026-06-13] 从 SpawnManager 抽出,SpawnManager 仅做 wiring。

// [需求@2026-06-17 E2E] mock 切换跟 SpawnManager 同源
const { RoleInstance: RealRoleInstance } = require('./RoleInstance');
const { MockRoleInstance } = require('./MockRoleInstance');
const RoleInstance = process.env.MATE_MOCK_TERMS === '1' ? MockRoleInstance : RealRoleInstance;
const bus = require('../messageBus');
const { recordEvent } = require('../db');

/**
 * 在 instances Map 中查找指定 (project, role, slot) 的 instance(status != dead)
 */
function findPoolInstance(instances, projectId, roleName, slot) {
  return [...instances.values()].find(
    (i) => i.projectId === projectId && i.role.name === roleName && i.poolSlot === slot && i.status !== 'dead'
  );
}

/**
 * 在 instances Map 中找下一个空 slot(1..maxSlot)
 * @returns {number|null}
 */
function findNextFreePoolSlot(instances, projectId, roleName, maxSlot) {
  const used = new Set();
  for (const i of instances.values()) {
    if (i.projectId === projectId && i.role.name === roleName && i.poolSlot != null && i.status !== 'dead') {
      used.add(i.poolSlot);
    }
  }
  for (let s = 1; s <= maxSlot; s++) if (!used.has(s)) return s;
  return null;
}

/**
 * 池子 acquire 逻辑。返回一个 instance(可能是已存在的 idle / disconnected,
 * 或者新建的 spawning,或者池满时的任意 busy)。
 *
 * @param {Object} opts
 * @param {Map}      opts.instances
 * @param {number}   opts.projectId
 * @param {string}   opts.projectRootDir
 * @param {Object}   opts.role             RoleDefinition
 * @param {number|null} opts.requestedSlot 指定 slot(可选)
 * @param {string|null} opts.threadSlug
 * @param {Function} opts.createPoolInstance  注入 — 实际创建 instance(走 wire/cap/persist)
 * @returns {RoleInstance|null}
 */
function acquire({ instances, projectId, projectRootDir, role, requestedSlot, threadSlug, createPoolInstance }) {
  // 指定 slot
  if (requestedSlot != null) {
    if (requestedSlot < 1 || requestedSlot > role.parallelismLimit) {
      throw new Error(`slot ${requestedSlot} out of range 1..${role.parallelismLimit} for ${role.name}`);
    }
    const existing = findPoolInstance(instances, projectId, role.name, requestedSlot);
    if (existing) return existing;
    return createPoolInstance({ projectId, projectRootDir, role, poolSlot: requestedSlot, threadSlug });
  }

  // 泛型:优先用现有 idle → disconnected(lazy resurrect)→ 新分配 slot → 任意 busy
  const idle = [...instances.values()].find(
    (i) => i.projectId === projectId && i.role.name === role.name && i.status === 'idle' && i.poolSlot != null
  );
  if (idle) return idle;

  const disconnected = [...instances.values()].find(
    (i) => i.projectId === projectId && i.role.name === role.name && i.status === 'disconnected' && i.poolSlot != null
  );
  if (disconnected) return disconnected;

  const freeSlot = findNextFreePoolSlot(instances, projectId, role.name, role.parallelismLimit);
  if (freeSlot != null) {
    return createPoolInstance({ projectId, projectRootDir, role, poolSlot: freeSlot, threadSlug });
  }

  // Pool 满 — 返回任意 busy/spawning(caller / queue 后续处理)
  // [bug@2026-06-17] spawning 状态也算占着 slot(它还在 init,马上会 busy),
  //   不算的话多线索并发时 acquire 会返 null 直接 fail。
  const anyBusyOrSpawning = [...instances.values()].find(
    (i) => i.projectId === projectId && i.role.name === role.name &&
           (i.status === 'busy' || i.status === 'spawning')
  );
  return anyBusyOrSpawning || null;
}

/**
 * 创建新池槽实例 — 走 ctor + 注入 instances Map + wire listener + persist + emit。
 *
 * @param {Object} opts
 * @param {Map}      opts.instances
 * @param {number}   opts.projectId
 * @param {string}   opts.projectRootDir
 * @param {Object}   opts.role
 * @param {number}   opts.poolSlot
 * @param {string|null} opts.threadSlug
 * @param {Function} opts.checkGlobalCap      可选,调用方在 spawn 前检 cap
 * @param {Function} opts.wireListeners       inst → void:绑事件桥接
 * @param {Function} opts.persistInstance     inst → void:upsert SQLite
 * @returns {RoleInstance}
 */
function create({ instances, projectId, projectRootDir, role, poolSlot, threadSlug, checkGlobalCap, wireListeners, persistInstance }) {
  if (checkGlobalCap) checkGlobalCap();
  const inst = new RoleInstance({
    role, projectId, projectRootDir, threadSlug, poolSlot,
  });
  instances.set(inst.id, inst);
  if (wireListeners) wireListeners(inst);
  if (persistInstance) persistInstance(inst);
  bus.publish('instance.spawned', inst.snapshot());
  recordEvent('pool.allocated', { roleName: role.name, poolSlot, instanceId: inst.id },
              { projectId, threadSlug, instanceId: inst.id });
  return inst;
}

/**
 * 启动时回填:非 R 角色但没有 pool_slot 的实例,按 createdAt 顺序分配 slot,
 * 超过 pool 上限的 excess 实例标 dead。
 *
 * @param {Object} opts
 * @param {Map}    opts.instances
 * @param {Object} opts.roleCatalog   { get(name) → role }
 * @param {Object} opts.stmts         db prepared statements (need setInstanceDied)
 * @param {Object} opts.db            for inline UPDATE
 * @returns {number}                  backfilled count
 */
function backfillFromDisk({ instances, roleCatalog, stmts, db }) {
  const groups = new Map();
  for (const inst of instances.values()) {
    if (inst.role.type === 'requirements') continue;  // R 不池化
    if (inst.poolSlot != null) continue;
    const key = `${inst.projectId}|${inst.role.name}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(inst);
  }

  let backfilled = 0;
  for (const [key, insts] of groups) {
    insts.sort((a, b) => a.createdAt - b.createdAt);
    const [projectIdStr, roleName] = key.split('|');
    const projectId = parseInt(projectIdStr, 10);
    const role = roleCatalog.get(roleName);
    if (!role) continue;

    const used = new Set();
    for (const i of instances.values()) {
      if (i.projectId === projectId && i.role.name === roleName && i.poolSlot != null && i.status !== 'dead') {
        used.add(i.poolSlot);
      }
    }

    for (const inst of insts) {
      let assigned = null;
      for (let s = 1; s <= role.parallelismLimit; s++) {
        if (!used.has(s)) { assigned = s; used.add(s); break; }
      }
      if (assigned != null) {
        inst.poolSlot = assigned;
        try {
          db.prepare(`UPDATE role_instances SET pool_slot = ? WHERE id = ?`).run(assigned, inst.id);
          backfilled++;
        } catch (e) {
          console.warn(`[PoolAllocator] backfill pool_slot for ${inst.id} failed:`, e.message);
        }
      } else {
        console.warn(`[PoolAllocator] excess ${roleName} instance ${inst.id} — no free slot (pool ${role.parallelismLimit} full), marking dead`);
        inst._setStatus('dead');
        inst.diedAt = Date.now();
        try { stmts.setInstanceDied.run(Date.now(), inst.id); } catch {}
        instances.delete(inst.id);
      }
    }
  }
  return backfilled;
}

module.exports = {
  findPoolInstance,
  findNextFreePoolSlot,
  acquire,
  create,
  backfillFromDisk,
};
