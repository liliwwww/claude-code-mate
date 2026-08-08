// ============================================================================
// Supervisor 规则:chain 悬空 (stalled)
// ----------------------------------------------------------------------------
// 消除事故 #7 类(role 完成实际工作但漏 marker,mate 视角 chain 悬空)
//
// 逻辑:栈非空(chain 派生栈顶不是 R)+ 栈顶 role idle 且 > 5min 无新 chain seg
//   → 疑似悬空,建议 user 手动 unstick(现 UI1 按钮)或 inject 补 marker
//
// 跟 missing_marker 的区别:
//   - missing_marker:关键字触发,可能是"role 想 handoff 但漏 marker"
//   - chain_stalled:结构触发,不看文本,只看"栈顶应该干活但没动"
//
// 触发:30s cron 扫全库
// ============================================================================

const { db } = require('../../db');

const RULE_ID = 'chain_stalled';
const STALL_THRESHOLD_MS = 5 * 60 * 1000;      // 5min:开始关注
// [bug@2026-08-08] 超过 24h 的悬空基本是"user 早忘了 archive 的老线索",
//   反复报只会污染顶栏。真正 in-flight 卡死不会超过 24h user 没察觉。
const STALL_MAX_AGE_MS = 24 * 60 * 60 * 1000;   // 24h:超过不报

// 从 chain 简易派生栈(不引入 replayChain 依赖,只算够用的)
//   push:handoff · pop:done · handoff(B/C→H)也 pop(callback)
//   返回栈顶 { role, instanceId } 或 null(空栈)
function _deriveStackTop(chain) {
  const stack = [];
  const isPop = (from, to) => {
    const f = String(from||'').toLowerCase();
    const t = String(to||'').toLowerCase();
    return (f.includes('mate-b') || f.includes('mate-c') || f.includes('executor') || f.includes('validator'))
        && (t.includes('mate-h') || t.includes('orchestrator'));
  };
  for (const c of chain) {
    if (c.kind === 'handoff') {
      if (isPop(c.fromRole, c.toRole)) {
        stack.pop();  // B/C → H callback,pop B/C
      } else {
        stack.push({ role: c.toRole, instanceId: c.toInstanceId, ts: c.ts });
      }
    } else if (c.kind === 'done') {
      stack.pop();
    } else if (c.kind === 'reject') {
      stack.pop();
    }
    // blocked 不 pop(仍在栈上等 user)
  }
  return stack.length ? stack[stack.length - 1] : null;
}

async function check() {
  const store = require('../store');
  // 每次 check 前清自己所有旧 findings(状态快照类型)
  store.markResolvedByPredicate((f) => f.ruleId === RULE_ID);

  const findings = [];
  const rows = db.prepare(`SELECT slug, project_id, metadata_json, updated_at FROM threads`).all();
  const now = Date.now();
  for (const r of rows) {
    try {
      const meta = JSON.parse(r.metadata_json || '{}');
      // blocked 状态另有规则(blocked_question)管,skip
      if (meta.has_pending_question) continue;
      // verified 已终态,skip
      const chain = meta.dispatch_chain || [];
      if (!chain.length) continue;
      const top = _deriveStackTop(chain);
      if (!top || !top.instanceId) continue;  // 空栈或栈顶是 R(逻辑上 R 是 stack 底)
      // R 在栈顶意味着完工,skip
      const topRole = String(top.role || '').toLowerCase();
      if (topRole.includes('mate-r') || topRole.includes('requirements')) continue;

      // 栈顶 inst 的最近 event 时间(用 messages 最鲜活,#199 教训)
      const lastMsg = db.prepare(`
        SELECT MAX(ts) as mx FROM messages WHERE instance_id = ?
      `).get(top.instanceId);
      const lastActTs = Math.max(lastMsg?.mx || 0, top.ts);
      const idleMs = now - lastActTs;
      if (idleMs < STALL_THRESHOLD_MS) continue;
      if (idleMs > STALL_MAX_AGE_MS) continue;  // 太老,视为脏数据不报

      // 栈顶 inst 当前状态 — 只报 idle/disconnected(busy 意味着还在跑,不算悬空)
      const inst = db.prepare(`SELECT status FROM role_instances WHERE id = ?`).get(top.instanceId);
      if (!inst) continue;
      if (inst.status === 'busy' || inst.status === 'spawning') continue;

      const idleMin = Math.floor(idleMs / 60000);
      findings.push({
        ruleId: RULE_ID,
        severity: idleMs > 30 * 60 * 1000 ? 'error' : 'warn',  // > 30min 升 error
        threadSlug: r.slug,
        instanceId: top.instanceId,
        message: `⏸ chain 悬空:${top.role} 栈顶 ${inst.status} ${idleMin}min 无动作(应干活但没 emit marker)`,
        detectedAt: now,
        dedupKey: `${RULE_ID}:${r.slug}:${top.instanceId}`,
        evidence: {
          topFrame: top,
          instStatus: inst.status,
          lastActTs,
          lastActIso: new Date(lastActTs).toISOString(),
          idleMinutes: idleMin,
          projectId: r.project_id,
        },
        suggestedAction: {
          label: `跳到线索 ${r.slug} 检查栈顶 ${top.role}`,
          kind: 'focus_thread',
          body: { projectId: r.project_id, threadSlug: r.slug },
        },
      });
    } catch {}
  }
  return findings;
}

// event 驱动:handoff / done / reject 追加时都重跑一次(不等 cron)
function subscribe(bus, dispatch) {
  const rerun = async () => {
    try {
      const findings = await check();
      for (const f of findings) dispatch(f);
    } catch {}
  };
  const u1 = bus.subscribe('thread.handoff', rerun);
  const u2 = bus.subscribe('thread.done', rerun);
  const u3 = bus.subscribe('dispatch.rejected', rerun);
  return () => { [u1, u2, u3].forEach((u) => { try { if (typeof u === 'function') u(); } catch {} }); };
}

module.exports = { id: RULE_ID, check, subscribe };
