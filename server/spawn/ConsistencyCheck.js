// ============================================================================
// MODULE CONTRACT
// ----------------------------------------------------------------------------
// 层:L2 Process Control
// 责任:定期扫全库,查系统 state 一致性异常,发 alert 事件 + WS 广播 + 自愈。
//   目的:race bug 发生后 5min 内有告警,不用等用户 15h 后才发现。
//   来源:docs/优化建议backlog.md #X1
//
// 检查项:
//   1. orphan_pending  — pending_sends 指向不存在的 instance
//   2. stack_drift     — DB call_stack_json != replayChain(chain) 派生结果(自愈)
//   3. stuck_queue     — pending_sends status=queued 且 enqueued > 1h(#X4 兜底 24h auto-cancel)
//   4. stuck_busy     — instance status=busy 且 last_active > 15min
//
// [bug@2026-08-06] Check 5 chain_crossings 已退休 — 原本文本匹配 reason/summary
//   里出现别的 thread slug,但用户合理跨线索引用(如"参考上一个 thread
//   t-mrwwnh63-8g3f 里的做法")会一直触发假警。真"走串"信号已被 X2 audit
//   (debug.instance_threadslug_flip events)覆盖:每次 threadSlug 翻转都有
//   caller stack。要查手动跨线索文本引用仍可 GET /api/chain-crossings。
//
// 公共 API:start() / stop() / runOnce()
// 允许依赖:db / messageBus / replayChain / ThreadCallStack / PendingSends
// 禁止:
//   - 替 LLM 决策
//   - 派工 / 发消息(只诊断 + 自愈 stack)
//   - 修改业务实体(pending_sends auto-cancel 是唯一例外,受 X4 保护)
// ============================================================================
//
// [需求@2026-07-30 X1] 一致性检查 cron

const bus = require('../messageBus');
const { db, recordEvent } = require('../db');
const { replayChain } = require('../threads/replayChain');
const TCS = require('../threads/ThreadCallStack');
const PendingSends = require('./PendingSends');
const log = require('../logger');
const MOD = 'ConsistencyCheck';

const INTERVAL_MS = 5 * 60 * 1000;              // 5 分钟一扫
const STUCK_QUEUE_WARN_MS = 60 * 60 * 1000;     // 排队 1h 未处理 → warn
const STUCK_QUEUE_CANCEL_MS = 24 * 60 * 60 * 1000; // 24h 未处理 → auto-cancel(X4)
const STUCK_BUSY_MS = 15 * 60 * 1000;           // busy > 15min 无活动 → warn
const CHAIN_CROSSING_WINDOW_MS = 24 * 60 * 60 * 1000; // 只报最近 24h 新走串
const BASELINE_META_KEY = 'consistency_check.crossings_baseline_ts'; // meta 表存基线

// 从 meta 表读 baseline(user "确认已知走串"的时间戳,只报之后的新走串)
function _getBaselineTs() {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(BASELINE_META_KEY);
    return row?.value ? parseInt(row.value, 10) : 0;
  } catch { return 0; }
}
function _setBaselineTs(ts) {
  try {
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(BASELINE_META_KEY, String(ts));
    return true;
  } catch (e) {
    log.warn({ module: MOD, event: 'baseline_set_failed', error: e.message });
    return false;
  }
}

let _interval = null;
let _lastAlertKey = null;  // 避免重复告警刷屏,同 key 5min 内不 repeat

function start() {
  if (_interval) return;
  _interval = setInterval(() => {
    runOnce().catch((e) => log.warn({ module: MOD, event: 'run_failed', phase: 'periodic', error: e.message }));
  }, INTERVAL_MS);
  log.info({ module: MOD, event: 'started', intervalMinutes: INTERVAL_MS / 60000 });
  // 启动时立即跑一次(不等 5 分钟)
  setImmediate(() => {
    runOnce().catch((e) => log.warn({ module: MOD, event: 'run_failed', phase: 'boot', error: e.message }));
  });
}

function stop() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

/**
 * 执行一次全库一致性检查。
 * @returns { inconsistencies: [], selfHealed: N }
 */
async function runOnce() {
  const inconsistencies = [];
  let selfHealed = 0;

  // ============ Check 1: orphan_pending ============
  try {
    const orphan = db.prepare(`
      SELECT ps.id, ps.target_id, ps.thread_slug, ps.enqueued_at
      FROM mate_pending_sends ps
      WHERE ps.target_kind = 'instance'
        AND ps.processed_at IS NULL
        AND ps.cancelled_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM role_instances WHERE id = ps.target_id)
    `).all();
    if (orphan.length) {
      inconsistencies.push({ kind: 'orphan_pending', count: orphan.length, items: orphan });
    }
  } catch (e) { log.warn({ module: MOD, event: 'check_failed', check: 'orphan_pending', error: e.message }); }

  // ============ Check 2: stack_drift(自愈)============
  try {
    const threads = db.prepare(`
      SELECT slug, project_id, metadata_json, call_stack_json
      FROM threads WHERE stage != 'closed'
    `).all();
    const drifts = [];
    for (const t of threads) {
      let chain, dbStack;
      try {
        chain = JSON.parse(t.metadata_json || '{}').dispatch_chain || [];
        dbStack = t.call_stack_json ? JSON.parse(t.call_stack_json) : { frames: [] };
      } catch { continue; }
      const lookup = (id) => {
        if (!id) return null;
        try {
          const r = db.prepare('SELECT claude_session_id FROM role_instances WHERE id = ?').get(id);
          return r?.claude_session_id || null;
        } catch { return null; }
      };
      const derived = replayChain(chain, { lookupSessionId: lookup });
      const dbKey = _framesToKey(dbStack.frames || []);
      const derivedKey = _framesToKey(derived.stack.frames || []);
      if (dbKey !== derivedKey) {
        drifts.push({
          slug: t.slug,
          projectId: t.project_id,
          dbFrames: dbStack.frames?.length || 0,
          derivedFrames: derived.stack.frames.length,
        });
        // 自愈:直接写派生结果(replayChain 是权威)
        try {
          TCS.save(t.project_id, t.slug, derived.stack);
          selfHealed++;
        } catch (e) {
          log.warn({ module: MOD, event: 'self_heal_failed', threadSlug: t.slug, error: e.message });
        }
      }
    }
    if (drifts.length) {
      inconsistencies.push({ kind: 'stack_drift', count: drifts.length, items: drifts, selfHealed: drifts.length });
    }
  } catch (e) { log.warn({ module: MOD, event: 'check_failed', check: 'stack_drift', error: e.message }); }

  // ============ Check 3: stuck_queue(warn > 1h,auto-flush 尝试,auto-cancel > 24h)============
  // [需求@2026-07-30 #196] 加 auto-flush 尝试 — 补 boot 时错过或从没触发过的 pending
  try {
    const now = Date.now();
    const stuck = db.prepare(`
      SELECT id, target_id, target_kind, thread_slug, enqueued_at, reason
      FROM mate_pending_sends
      WHERE status = 'queued'
        AND processed_at IS NULL AND cancelled_at IS NULL
        AND enqueued_at < ?
      ORDER BY enqueued_at ASC
    `).all(now - STUCK_QUEUE_WARN_MS);
    const warnItems = [];
    const autoCancelled = [];
    const autoFlushed = [];
    // 尝试主动 flush 每个 stuck 项(避免"target disconnected 永不 flush"的洞)
    // 只 flush 一次每个 target(_tryFlushFor 会按 FIFO 挑最老的)
    let spawnManager = null;
    try { spawnManager = require('./SpawnManager'); } catch {}
    const QueueDispatcher = require('./QueueDispatcher');
    const flushTriedTargets = new Set();
    for (const p of stuck) {
      if (p.enqueued_at < now - STUCK_QUEUE_CANCEL_MS) {
        // > 24h Auto-cancel(X4)
        try {
          PendingSends.markCancelled(p.id, 'auto-cancel: stuck > 24h (ConsistencyCheck X4)');
          autoCancelled.push(p);
          bus.publish('queue.auto_cancelled', {
            pendingSendId: p.id, threadSlug: p.thread_slug, reason: 'stuck_24h', ts: Date.now(),
          });
        } catch (e) {
          log.warn({ module: MOD, event: 'auto_cancel_failed', pendingSendId: p.id, error: e.message });
        }
      } else {
        warnItems.push({ ...p, stuckMinutes: Math.round((now - p.enqueued_at) / 60000) });
        // 尝试主动 flush
        if (spawnManager && p.target_kind === 'instance') {
          const targetKey = p.target_id;
          if (!flushTriedTargets.has(targetKey)) {
            flushTriedTargets.add(targetKey);
            const inst = spawnManager.instances.get(p.target_id);
            if (inst) {
              try {
                await QueueDispatcher.onInstanceIdle(inst, { dispatchCb: spawnManager._queueDispatchCb });
                autoFlushed.push({ target: targetKey });
              } catch (e) {
                // 尝试失败无所谓(可能 inst busy),下次 cron 再试
              }
            }
          }
        }
      }
    }
    if (warnItems.length) {
      inconsistencies.push({
        kind: 'stuck_queue', count: warnItems.length, items: warnItems,
        autoFlushAttempts: autoFlushed.length,
      });
    }
    if (autoCancelled.length) {
      inconsistencies.push({
        kind: 'stuck_queue_auto_cancelled', count: autoCancelled.length, items: autoCancelled,
      });
    }
  } catch (e) { log.warn({ module: MOD, event: 'check_failed', check: 'stuck_queue', error: e.message }); }

  // ============ Check 4: stuck_busy ============
  // [bug@2026-08-02 X1 修复] role_instances.last_active_at 只在 status_change 时持久化
  //   (busy 期间不更新)→ 长任务(19min turn / 59 sub-turn / cost $45)会误报 stuck。
  //   改用 messages 表最新事件 ts 判断真"活性":如果 15min 内有过 stream event
  //   (任何 kind:assistant/user/thinking/status),就是活着不算 stuck。
  try {
    const cutoff = Date.now() - STUCK_BUSY_MS;
    const busyRows = db.prepare(`
      SELECT id, role_name, project_id, last_active_at, bound_thread_slug
      FROM role_instances WHERE status = 'busy'
    `).all();
    const stuck = [];
    for (const s of busyRows) {
      // 拿 messages 表这个 inst 最新事件 ts(权威活性)
      const lastMsg = db.prepare(`
        SELECT MAX(ts) mx FROM messages WHERE instance_id = ?
      `).get(s.id);
      const realLastAct = Math.max(s.last_active_at || 0, lastMsg?.mx || 0);
      if (realLastAct < cutoff) {
        stuck.push({
          ...s,
          idleMinutes: Math.round((Date.now() - realLastAct) / 60000),
          realLastActiveAt: realLastAct,
        });
      }
    }
    if (stuck.length) {
      inconsistencies.push({ kind: 'stuck_busy', count: stuck.length, items: stuck });
    }
  } catch (e) { log.warn({ module: MOD, event: 'check_failed', check: 'stuck_busy', error: e.message }); }

  // [bug@2026-08-06] Check 5 chain_crossings 已退休 — 见文件顶部注释。
  //   真"走串"信号看 X2 audit:GET /api/audit/threadslug-flips
  //   文本引用扫描仍在 /api/chain-crossings(dashboard "Chain 自检" tab 手动用)

  // ============ 汇总 + 告警 ============
  if (inconsistencies.length) {
    const summary = {
      totalKinds: inconsistencies.length,
      kinds: inconsistencies.map((x) => x.kind),
      totalItems: inconsistencies.reduce((s, x) => s + x.count, 0),
      selfHealed,
      ts: Date.now(),
    };
    // 去重:同 kinds 组合 5 分钟内不重复 log(但仍会 broadcast,让 UI 更新计数)
    const alertKey = summary.kinds.sort().join(',');
    const now = Date.now();
    const isFresh = !_lastAlertKey || _lastAlertKey.key !== alertKey || (now - _lastAlertKey.ts > INTERVAL_MS);
    if (isFresh) {
      _lastAlertKey = { key: alertKey, ts: now };
      log.warn({ module: MOD, event: 'alert', totalItems: summary.totalItems, kinds: summary.kinds, selfHealed });
      try {
        recordEvent('system.consistency_alert', {
          summary, inconsistencies,
        });
      } catch (e) { log.warn({ module: MOD, event: 'record_event_failed', error: e.message }); }
    }
    // WS 广播每次都发,UI 显示实时红条
    bus.publish('system.consistency_alert', { summary, inconsistencies });
  } else {
    // 无异常时也 broadcast 一次让 UI 关掉红条(空 summary)
    bus.publish('system.consistency_ok', { ts: Date.now() });
    _lastAlertKey = null;
  }

  return { inconsistencies, selfHealed };
}

function _framesToKey(frames) {
  return frames.map((f) => `${f.role}:${f.instanceId || 'null'}:${f.status}`).join('|');
}

// [X1] user "确认已知走串" — 设 baseline 时间戳,之后只报新的
function acknowledgeCrossings() {
  const now = Date.now();
  const ok = _setBaselineTs(now);
  if (ok) {
    try {
      recordEvent('system.consistency_baseline_set', { baselineTs: now });
    } catch {}
  }
  return { ok, baselineTs: now };
}

function getBaselineTs() { return _getBaselineTs(); }

module.exports = { start, stop, runOnce, acknowledgeCrossings, getBaselineTs };
