// ============================================================================
// Supervisor 规则:queue stuck
// ----------------------------------------------------------------------------
// 消除事故 #3(ps=26 stuck 15h 才被发现)
//
// 逻辑:mate_pending_sends 排队时长超阈值 → 提示
//   - 1h+ warn:"该 flush 却没,可能触发条件漏了"
//   - 6h+ error:"必然是 bug 或错配"
//
// 建议:一键"立即派发"(接现有 UI1 endpoint)
//
// 跟 target_dead 区别:queue_stuck 目标可能活着,只是没被 flush(触发条件漏)
// ============================================================================

const { db } = require('../../db');

const RULE_ID = 'queue_stuck';
const WARN_MS = 1 * 60 * 60 * 1000;    // 1h
const ERROR_MS = 6 * 60 * 60 * 1000;   // 6h

async function check() {
  const store = require('../store');
  store.markResolvedByPredicate((f) => f.ruleId === RULE_ID);

  const findings = [];
  const now = Date.now();
  const pendings = db.prepare(`
    SELECT id, target_id, target_kind, thread_slug, project_id, enqueued_at, status, kind, reason
    FROM mate_pending_sends
    WHERE status = 'queued'
  `).all();
  for (const p of pendings) {
    const waitMs = now - p.enqueued_at;
    if (waitMs < WARN_MS) continue;
    // target_dead 那条规则会另外处理 dead 情况,这里 skip 避免重复报
    if (p.target_kind === 'instance') {
      const inst = db.prepare(`SELECT status FROM role_instances WHERE id = ?`).get(p.target_id);
      if (inst?.status === 'dead') continue;
    }
    const waitMin = Math.round(waitMs / 60000);
    const severity = waitMs > ERROR_MS ? 'error' : 'warn';
    findings.push({
      ruleId: RULE_ID,
      severity,
      threadSlug: p.thread_slug,
      instanceId: p.target_id,
      message: `⏱ pending #${p.id} queued ${waitMin}min 未派发 → ${p.target_id}(触发条件可能漏了)`,
      detectedAt: now,
      dedupKey: `${RULE_ID}:${p.id}`,
      evidence: {
        pendingSendId: p.id,
        targetId: p.target_id,
        kind: p.kind,
        reason: p.reason,
        enqueuedAt: p.enqueued_at,
        waitMinutes: waitMin,
      },
      suggestedAction: {
        label: `立即派发 pending #${p.id}(跳队)`,
        kind: 'endpoint',
        endpoint: `/api/queue/${p.id}/dispatch`,
        body: {},
      },
    });
  }
  return findings;
}

function subscribe(bus, dispatch) {
  // queue_stuck 靠时间累积触发,event 驱动意义小 — 靠 cron 每 30s 兜底即可
  return () => {};
}

module.exports = { id: RULE_ID, check, subscribe };
