// ============================================================================
// Supervisor 规则:漏 marker 检测
// ----------------------------------------------------------------------------
// 触发场景:role 从 busy 转 idle 后,若上段 role_to_user 文本有 handoff-like
//   关键字(如"交你决定"/"请裁决"/"上报"...)但无 <mate:*/> marker → 疑似漏 marker
//
// 消除事故 #7(2026-08-07 C.jhkfgv 输出 4269 字报告漏 marker,chain 悬空 10h)
//
// 触发:
//   - event: instance.status_change to='idle'(5s 后检查,给 role 时间输出最后消息)
//   - cron: 每 30s 扫全库 idle role,检查是否漏 marker
// ============================================================================

const { db } = require('../../db');

const RULE_ID = 'missing_marker';

// handoff-like 关键字(中英文)—— 触发疑似漏 marker 检测
const HANDOFF_LIKE_KEYWORDS = [
  // 中文
  '交你决定', '请裁决', '请复核', '请你决定', '请你裁决', '请审核', '请验收',
  '上报', '汇报', '交给你', '给你处理', '请处理',
  '完工', '完成', '搞定', '已完成', '实施完成',
  '按 STOP 条件', '请你裁定', '交由你', '你决定',
  // 英文
  'handoff', 'over to', 'passing to', 'please review', 'please verify',
  'please decide', 'ready for', 'awaiting your', 'submit to',
  'complete', 'finished', 'done with', 'implemented',
];

// marker 正则(简版,匹配 <mate:xxx/> 或 <mate:xxx>...</mate:xxx>)
const MARKER_RE = /<mate:(handoff|done|blocked|reject|bounce)\b[^>]*\/?>/i;

function _hasMarker(text) {
  return MARKER_RE.test(text || '');
}

function _hitsKeyword(text) {
  const lower = String(text || '').toLowerCase();
  return HANDOFF_LIKE_KEYWORDS.filter((k) => lower.includes(k.toLowerCase()));
}

// 查该 inst 最近一段 role_to_user 消息完整 text
function _fetchLastRoleMsg(instanceId) {
  const row = db.prepare(`
    SELECT ts, payload_json FROM messages
    WHERE instance_id = ? AND direction = 'role_to_user'
    ORDER BY ts DESC LIMIT 1
  `).get(instanceId);
  if (!row) return null;
  let text = '';
  try {
    const p = JSON.parse(row.payload_json);
    const content = p.message?.content || [];
    for (const c of content) {
      if (c.type === 'text' && c.text) text += c.text;
    }
  } catch {}
  return { ts: row.ts, text };
}

// 从 chain 推断该 inst 该 handoff 给谁(chain 上一步 target)
function _inferHandoffTarget(threadSlug) {
  const t = db.prepare(`SELECT metadata_json FROM threads WHERE slug = ?`).get(threadSlug);
  if (!t) return null;
  try {
    const chain = JSON.parse(t.metadata_json).dispatch_chain || [];
    // 从末尾往前,找最后一个 kind='handoff' seg,它的 fromRole 就是"该 inst 该回给谁"
    for (let i = chain.length - 1; i >= 0; i--) {
      const seg = chain[i];
      if (seg.kind === 'handoff' && seg.fromRole) {
        return { role: seg.fromRole, inferredFromChainIdx: i };
      }
    }
  } catch {}
  return null;
}

function _checkOne(instanceId, threadSlug, roleName) {
  const msg = _fetchLastRoleMsg(instanceId);
  if (!msg || !msg.text) return null;
  if (_hasMarker(msg.text)) return null;
  const hits = _hitsKeyword(msg.text);
  if (!hits.length) return null;
  // 忽略太老的消息(> 24h,可能是 stale idle)
  if (Date.now() - msg.ts > 24 * 3600 * 1000) return null;

  const target = _inferHandoffTarget(threadSlug);
  const targetRole = target?.role || 'mate-H';  // fallback: 大概率 handoff 回 H

  return {
    ruleId: RULE_ID,
    severity: 'warn',
    threadSlug,
    instanceId,
    message: `${roleName || instanceId} 疑似漏 marker(上段有 "${hits[0]}" 但无 <mate:*/>)`,
    detectedAt: Date.now(),
    dedupKey: `${RULE_ID}:${threadSlug}:${instanceId}:${msg.ts}`,  // 同一段消息只报一次
    evidence: {
      lastMsgTs: msg.ts,
      lastMsgTsIso: new Date(msg.ts).toISOString(),
      textPreview: msg.text.slice(-300),  // 末尾 300 字(通常 handoff-like signal 在末尾)
      keywordsHit: hits,
      inferredTarget: target,
    },
    suggestedAction: {
      label: `补 marker 给 ${roleName || instanceId} → 转派 ${targetRole}`,
      kind: 'inject',
      endpoint: `/api/instances/${instanceId}/inject`,
      body: {
        label: 'handoff',
        text: `你上一段消息(${new Date(msg.ts).toISOString().slice(11,19)}) `
            + `末尾提到 "${hits[0]}",看起来是要转交下一步但漏了 <mate:handoff/> marker,`
            + `导致 mate 视角你没结束,chain 悬空。\n\n`
            + `请你现在**只输出一行 marker**(不用重复原报告)转回 ${targetRole}:\n\n`
            + `<mate:handoff target="${targetRole}" reason="<你的一句话摘要>" />\n\n`
            + `只回这一行 marker(前面可加 1-2 句简短说明),不要重新分析。`,
      },
    },
  };
}

async function check() {
  // 扫全库 idle role_instances
  const rows = db.prepare(`
    SELECT id, role_name, bound_thread_slug FROM role_instances
    WHERE status = 'idle' AND bound_thread_slug IS NOT NULL
  `).all();
  const findings = [];
  for (const r of rows) {
    const f = _checkOne(r.id, r.bound_thread_slug, r.role_name);
    if (f) findings.push(f);
  }
  return findings;
}

// 事件驱动:role 转 idle 5s 后跑一次(给它时间完成最后 message)
function subscribe(bus, dispatch) {
  const handler = (payload) => {
    if (payload.to !== 'idle' || payload.from === 'idle') return;
    if (!payload.instanceId || !payload.threadSlug) return;
    setTimeout(() => {
      const f = _checkOne(payload.instanceId, payload.threadSlug, payload.roleName);
      if (f) dispatch(f);
    }, 5000);  // 5s 缓冲
  };
  const unsub = bus.subscribe('instance.status_change', handler);
  return typeof unsub === 'function' ? unsub : (() => {});
}

module.exports = { id: RULE_ID, check, subscribe };
