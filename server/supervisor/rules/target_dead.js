// ============================================================================
// Supervisor 规则:target dead
// ----------------------------------------------------------------------------
// 场景:mate_pending_sends 里有 queued/processing 项,但 target instance 已 dead
//   (mate 重启 / 强 kill / role crash 后)。这类 pending 永远不会 flush 成功。
//
// 触发:
//   - event: queue.added / instance.status_change to='dead'
//   - cron: 30s 扫全库 pending_sends
//
// 建议动作:cancel 该 pending(前端 confirm)+ 提示 user 重新派发
// ============================================================================

const { db } = require('../../db');

const RULE_ID = 'target_dead';

async function check() {
  const store = require('../store');
  store.markResolvedByPredicate((f) => f.ruleId === RULE_ID);

  const findings = [];
  const pendings = db.prepare(`
    SELECT id, target_id, target_kind, thread_slug, project_id, enqueued_at, status
    FROM mate_pending_sends
    WHERE status IN ('queued', 'processing', 'backlog', 'waiting_user')
  `).all();
  for (const p of pendings) {
    if (p.target_kind !== 'instance') continue;  // thread 类型 target 无所谓 dead
    const inst = db.prepare(`SELECT status FROM role_instances WHERE id = ?`).get(p.target_id);
    if (!inst) {
      // Instance 完全不在 DB(极端情况)
      findings.push(_makeFinding(p, 'missing'));
      continue;
    }
    if (inst.status === 'dead') {
      findings.push(_makeFinding(p, 'dead'));
    }
  }
  return findings;
}

function _makeFinding(pending, reason) {
  const ageMin = Math.round((Date.now() - pending.enqueued_at) / 60000);
  return {
    ruleId: RULE_ID,
    severity: 'error',
    threadSlug: pending.thread_slug,
    instanceId: pending.target_id,
    message: `⛔ pending #${pending.id} 目标 ${pending.target_id} 已 ${reason === 'dead' ? 'dead' : 'missing'} · 排队 ${ageMin}min,永远不会 flush`,
    detectedAt: Date.now(),
    dedupKey: `${RULE_ID}:${pending.id}`,
    evidence: {
      pendingSendId: pending.id,
      targetId: pending.target_id,
      status: pending.status,
      enqueuedAt: pending.enqueued_at,
      ageMinutes: ageMin,
      reason,
    },
    suggestedAction: {
      label: `取消 pending #${pending.id}(target 已 dead 无法 flush)`,
      kind: 'endpoint',
      endpoint: `/api/queue/${pending.id}/cancel`,
      body: { reason: 'target_dead_auto_cancel_by_supervisor' },
    },
  };
}

function subscribe(bus, dispatch) {
  const rerun = async () => {
    try {
      const findings = await check();
      for (const f of findings) dispatch(f);
    } catch {}
  };
  const u1 = bus.subscribe('queue.added', rerun);
  const u2 = bus.subscribe('instance.status_change', (p) => {
    if (p.to === 'dead') rerun();
  });
  return () => { [u1, u2].forEach((u) => { try { if (typeof u === 'function') u(); } catch {} }); };
}

module.exports = { id: RULE_ID, check, subscribe };
