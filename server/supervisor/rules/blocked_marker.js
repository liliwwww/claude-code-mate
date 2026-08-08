// ============================================================================
// Supervisor 规则:blocked marker 检测
// ----------------------------------------------------------------------------
// 现象:H(或其他 role)emit <mate:blocked question="..." /> 触发 blocked marker
//   时,mate 记 thread.metadata.has_pending_question=true 等 user 拍板。
//
// 盲区:supervisor MVP 3 条规则不覆盖 blocked,顶栏灯不亮 → user 若不切到该
//   线索看,可能长时间没意识到"H 在等答话"。
//
// 触发:
//   - event: 'thread.blocked' 直接立即拉 finding
//   - cron: 30s 扫全库 threads WHERE metadata.has_pending_question=true
//
// suggestedAction:kind='focus_thread' — 前端接线跳到该线索
// ============================================================================

const { db } = require('../../db');

const RULE_ID = 'blocked_question';

function _fetchBlockedThreads() {
  // 全库 threads,metadata_json 里带 has_pending_question=true 的
  const rows = db.prepare(`
    SELECT slug, project_id, title, metadata_json, updated_at
    FROM threads
    WHERE archived_at IS NULL
  `).all();
  const blocked = [];
  for (const r of rows) {
    try {
      const meta = JSON.parse(r.metadata_json || '{}');
      if (meta.has_pending_question && meta.blocked) {
        blocked.push({
          slug: r.slug,
          projectId: r.project_id,
          title: r.title || '(no title)',
          question: meta.blocked.question,
          severity: meta.blocked.severity || 'mid',
          raisedBy: meta.blocked.raisedBy,
          blockedTs: meta.blocked.ts,
          updatedAt: r.updated_at,
        });
      }
    } catch {}
  }
  return blocked;
}

function _makeFinding(b) {
  // blocked 的 severity(mid/high/low)→ supervisor severity 映射
  const svMap = { high: 'error', mid: 'warn', low: 'info' };
  const sev = svMap[b.severity] || 'warn';
  const qPreview = String(b.question || '').replace(/\n/g, ' ').slice(0, 120);
  const ageMin = b.blockedTs ? Math.round((Date.now() - b.blockedTs) / 60000) : 0;
  return {
    ruleId: RULE_ID,
    severity: sev,
    threadSlug: b.slug,
    instanceId: null,
    message: `⚠ ${b.raisedBy || 'H'} 在线索 ${b.slug} 触发 blocked · 等 user 答话 ${ageMin}min`
           + ` · 问题: ${qPreview}${qPreview.length >= 120 ? '…' : ''}`,
    detectedAt: Date.now(),
    dedupKey: `${RULE_ID}:${b.slug}:${b.blockedTs || 0}`,  // 同 thread 同 blocked 只报一次
    evidence: {
      projectId: b.projectId,
      threadTitle: b.title,
      question: b.question,
      severity: b.severity,
      raisedBy: b.raisedBy,
      blockedTs: b.blockedTs,
      blockedTsIso: b.blockedTs ? new Date(b.blockedTs).toISOString() : null,
      ageMinutes: ageMin,
    },
    suggestedAction: {
      label: `跳到线索 ${b.slug} 看问题`,
      kind: 'focus_thread',
      // 前端 handler:api('/supervisor/apply/:id') 拿到 action.body,
      //   看 kind='focus_thread' → 调 focusThread(threadSlug)(切 project + 切 thread)
      body: {
        projectId: b.projectId,
        threadSlug: b.slug,
      },
    },
  };
}

async function check() {
  const blocked = _fetchBlockedThreads();
  // cron 前清所有旧 blocked_question findings,再重新根据当前状态生成
  //   (跟 restart_gate 一样,是"当前状态快照"不是"持久问题")
  const store = require('../store');
  store.markResolvedByPredicate((f) => f.ruleId === RULE_ID);
  return blocked.map(_makeFinding);
}

// 事件驱动:thread.blocked 立即生成 finding(不等 cron)
function subscribe(bus, dispatch) {
  const handler = (payload) => {
    if (!payload || !payload.threadSlug) return;
    const finding = _makeFinding({
      slug: payload.threadSlug,
      projectId: payload.projectId,
      title: payload.thread?.title || '(no title)',
      question: payload.question,
      severity: payload.severity || 'mid',
      raisedBy: payload.raisedBy,
      blockedTs: Date.now(),
    });
    dispatch(finding);
  };
  const unsub = bus.subscribe('thread.blocked', handler);
  return typeof unsub === 'function' ? unsub : (() => {});
}

module.exports = { id: RULE_ID, check, subscribe };
