// ============================================================================
// MODULE CONTRACT
// ----------------------------------------------------------------------------
// 层:L3 Business Logic
// 责任:H session reset with handover memo · Phase 2 of "H session bloat 治理"
//
// 用途:H 是 project singleton,长时间跑一个 session 会累积巨大 conversation
//   history(见 h_session_bloat 规则)。此模块提供"reset with continuity":
//   kill 老 H → 起新 H → 首消息注入 memo(项目所有 active thread 的当前状态)
//   新 H 一上来就有全局视角,不用等 mate 再次 dispatch。
//
// 公共 API:
//   resetHSession(projectId, spawnManager) → Promise<{oldInstanceIds, newInstanceId, memo}>
//   generateHandoverMemo(projectId) → string
// 允许依赖:db / ThreadStore / replayChain / spawnManager (via caller)
// ============================================================================

const { db } = require('../db');
const { replayChain } = require('../threads/replayChain');

/**
 * 生成给新 H 的接班 memo — 一段 markdown user message,当作 customGreeting 注入。
 */
function generateHandoverMemo(projectId) {
  // 拿 project active threads(stage 不是 terminal)
  const threads = db.prepare(`
    SELECT slug, title, stage, metadata_json, updated_at
    FROM threads
    WHERE project_id = ? AND stage NOT IN ('verified', 'aborted')
    ORDER BY updated_at DESC
    LIMIT 30
  `).all(projectId);

  const projectRow = db.prepare(`SELECT name FROM projects WHERE id = ?`).get(projectId);
  const projectName = projectRow?.name || `project-${projectId}`;

  const lines = [];
  lines.push(`<system:h-handover>`);
  lines.push(`# 新 H session 接班 memo · ${new Date().toISOString()}`);
  lines.push(``);
  lines.push(`你是 project ${projectName}(id=${projectId})的 mate-H,上一个 H session 因为 conversation history 累积过大被 reset。以下是**你需要立即上手的所有 active thread**。`);
  lines.push(``);
  lines.push(`**重要**:这条 memo 是 mate 系统注入的,不是 user 输入。看完你不用回复"ready",直接 standby 等真实 handoff。之后每次 handoff 你都会拿到该线索的 chain 摘要,不需要依赖这份 memo 的记忆。`);
  lines.push(``);
  lines.push(`## Active threads (${threads.length})`);
  lines.push(``);

  if (threads.length === 0) {
    lines.push(`(项目目前无 active thread)`);
  } else {
    for (const t of threads) {
      let meta;
      try { meta = JSON.parse(t.metadata_json || '{}'); } catch { meta = {}; }
      const chain = meta.dispatch_chain || [];
      let stackDesc = '(empty)';
      try {
        const { stack } = replayChain(chain);
        if (stack.frames.length) {
          stackDesc = stack.frames.map((f) => `${f.role}(${(f.instanceId || '').slice(-6)})`).join(' → ');
        }
      } catch {}
      const lastSeg = chain[chain.length - 1];
      const lastActivity = lastSeg
        ? `${new Date(lastSeg.ts).toISOString().slice(11, 19)} ${lastSeg.kind} ${lastSeg.fromRole || '-'}→${lastSeg.toRole || lastSeg.toDisplayName || '-'}`
        : '(no chain seg)';
      const lastReason = ((lastSeg?.reason || lastSeg?.summary || lastSeg?.question || '') + '').replace(/\n/g, ' ').slice(0, 240);
      const pendingQ = meta.has_pending_question ? ` · ⚠ 等 user 答话` : '';

      lines.push(`### ${t.slug} · ${t.title || '(no title)'}`);
      lines.push(`- **stage**: ${t.stage}${pendingQ}`);
      lines.push(`- **stack**: ${stackDesc}`);
      lines.push(`- **last activity**: ${lastActivity}`);
      if (lastReason) lines.push(`- **last reason**: ${lastReason}${lastReason.length >= 240 ? '…' : ''}`);
      lines.push(``);
    }
  }

  lines.push(`---`);
  lines.push(``);
  lines.push(`**规则同 role prompt**:`);
  lines.push(`- 每次 R→H handoff 你会拿到完整 handoff brief(reason 字段)——你的主要输入源是那个,不是本 memo`);
  lines.push(`- 想查线索状态请 curl mate API,不要凭本 memo 记忆(可能 stale)`);
  lines.push(`- 现在只需 standby,等真实 handoff 或者 user 直接触发`);
  lines.push(``);
  lines.push(`</system:h-handover>`);

  return lines.join('\n');
}

/**
 * Reset H session — kill 老 H,起新 H(带 memo)
 *
 * @param {number} projectId
 * @param {SpawnManager} spawnManager  (调用方注入)
 * @returns {Promise<{oldInstanceIds: string[], newInstanceId: string, memo: string, memoPreview: string}>}
 */
async function resetHSession(projectId, spawnManager) {
  if (!projectId) throw new Error('projectId required');
  if (!spawnManager) throw new Error('spawnManager required');

  // 1. 找项目所有 live H
  const hRows = db.prepare(`
    SELECT id FROM role_instances
    WHERE role_name = 'mate-H' AND project_id = ? AND status != 'dead'
  `).all(projectId);

  // 2. 拒 busy(避免打断 in-progress)
  for (const r of hRows) {
    const inst = spawnManager.getInstance(r.id);
    if (inst?.status === 'busy' || inst?.status === 'spawning') {
      throw new Error(`cannot reset: ${r.id} is ${inst.status} (in-progress)`);
    }
  }

  // 3. kill 所有 live H
  const oldInstanceIds = [];
  for (const r of hRows) {
    const inst = spawnManager.getInstance(r.id);
    if (inst) {
      try { await inst.kill(); } catch {}
      oldInstanceIds.push(r.id);
    }
  }

  // 4. 拿 project root_dir
  const proj = db.prepare(`SELECT root_dir FROM projects WHERE id = ?`).get(projectId);
  if (!proj) throw new Error(`project ${projectId} not found`);

  // 5. 生成 memo
  const memo = generateHandoverMemo(projectId);

  // 6. 起新 H,customGreeting = memo(会作为首 stdin 写给 claude CLI)
  const newInst = spawnManager.spawnInstance({
    projectId,
    projectRootDir: proj.root_dir,
    roleName: 'mate-H',
    threadSlug: null,        // pool 角色不绑单一 thread
    customGreeting: memo,
  });

  return {
    oldInstanceIds,
    newInstanceId: newInst.id,
    memo,
    memoPreview: memo.slice(0, 500),
  };
}

module.exports = { resetHSession, generateHandoverMemo };
