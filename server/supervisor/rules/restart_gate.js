// ============================================================================
// Supervisor 规则:重启前门控
// ----------------------------------------------------------------------------
// 消除事故 #5 后半(2026-08-07 用户重启打断 in-progress task)
//
// 逻辑:统计当前 busy inst / processing pending / 近期活跃 → 3 色裁决:
//   🔴 block:有 processing pending · OR · 有 role 30s 内有 tool_use
//   🟡 caution:有 busy > 90s 静默(可能真卡了,重启相对安全但会打断)
//   🟢 ok:全 idle/disc/dead
//
// UI 强门控:🔴 时"我要重启"按钮 disabled
// ============================================================================

const { db } = require('../../db');

const RULE_ID = 'restart_gate';
const RECENT_ACTIVITY_MS = 30 * 1000;
const LONG_SILENCE_MS = 90 * 1000;

function _lastEventTs(instanceId) {
  const row = db.prepare(`SELECT MAX(ts) as mx FROM messages WHERE instance_id = ?`).get(instanceId);
  return row?.mx || 0;
}

async function check() {
  const findings = [];
  const now = Date.now();

  // 1. busy insts 每个都产 finding
  const busyInsts = db.prepare(`
    SELECT id, role_name, bound_thread_slug FROM role_instances WHERE status = 'busy'
  `).all();
  for (const i of busyInsts) {
    const lastTs = _lastEventTs(i.id);
    const silentMs = now - lastTs;
    const isRecentActive = silentMs < RECENT_ACTIVITY_MS;
    findings.push({
      ruleId: RULE_ID,
      severity: isRecentActive ? 'error' : (silentMs < LONG_SILENCE_MS ? 'warn' : 'warn'),
      threadSlug: i.bound_thread_slug,
      instanceId: i.id,
      message: isRecentActive
        ? `⛔ ${i.role_name} busy · 最近 ${Math.floor(silentMs/1000)}s 有事件 · 重启会打断`
        : `⚠ ${i.role_name} busy · 静默 ${Math.floor(silentMs/1000)}s · 可能长思考中`,
      detectedAt: now,
      dedupKey: `${RULE_ID}:busy:${i.id}`,
      evidence: {
        kind: 'busy_inst',
        instanceId: i.id,
        roleName: i.role_name,
        threadSlug: i.bound_thread_slug,
        lastEventTs: lastTs,
        silentMs,
        isRecentActive,
      },
    });
  }

  // 2. processing queue items 每个都产 finding
  const procQueue = db.prepare(`
    SELECT id, target_id, thread_slug, enqueued_at FROM mate_pending_sends
    WHERE status = 'processing'
  `).all();
  for (const p of procQueue) {
    findings.push({
      ruleId: RULE_ID,
      severity: 'error',
      threadSlug: p.thread_slug,
      instanceId: p.target_id,
      message: `⛔ pending #${p.id} processing 中 → ${p.target_id}(排队 ${Math.floor((now - p.enqueued_at)/1000)}s)`,
      detectedAt: now,
      dedupKey: `${RULE_ID}:proc:${p.id}`,
      evidence: {
        kind: 'processing_queue',
        pendingSendId: p.id,
        targetId: p.target_id,
        threadSlug: p.thread_slug,
        enqueuedAt: p.enqueued_at,
        waitMs: now - p.enqueued_at,
      },
    });
  }

  // 3. queued(未 processing 也算注意项,不阻塞)
  const queuedCount = db.prepare(`
    SELECT COUNT(*) as n FROM mate_pending_sends WHERE status = 'queued'
  `).get()?.n || 0;
  if (queuedCount > 0) {
    findings.push({
      ruleId: RULE_ID,
      severity: 'info',
      message: `${queuedCount} 项在 queue 排队(未 flush,重启不影响,恢复后自动派发)`,
      detectedAt: now,
      dedupKey: `${RULE_ID}:queued_count`,
      evidence: { kind: 'queued_count', count: queuedCount },
    });
  }

  return findings;
}

// 从 findings 汇总裁决(供 getRestartVerdict 用)
function deriveVerdict(findings) {
  const blockers = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity === 'warn');
  const infos = findings.filter((f) => f.severity === 'info');
  const verdict = blockers.length > 0 ? 'block'
                : warnings.length > 0 ? 'caution'
                : 'ok';
  return {
    verdict,
    verdictText: verdict === 'block' ? '🔴 请勿重启(有 in-progress task)'
               : verdict === 'caution' ? '🟡 可以重启但可能打断长思考'
               : '🟢 安全,可以重启',
    blockers,
    warnings,
    infos,
  };
}

// 事件驱动:每次 status_change / dispatch.completed 都可能改变裁决 → 都主动重跑一次
function subscribe(bus, dispatch) {
  const rerun = async () => {
    try {
      const findings = await check();
      // MVP: 让 cron 也扫,event 只加速。这里的 dispatch 给每条 finding push
      for (const f of findings) dispatch(f);
    } catch {}
  };
  const u1 = bus.subscribe('instance.status_change', rerun);
  const u2 = bus.subscribe('dispatch.completed', rerun);
  const u3 = bus.subscribe('queue.added', rerun);
  return () => { [u1, u2, u3].forEach((u) => { try { if (typeof u === 'function') u(); } catch {} }); };
}

module.exports = { id: RULE_ID, check, subscribe, deriveVerdict };
