// ============================================================================
// MODULE CONTRACT(2026-06-19)
// ----------------------------------------------------------------------------
// 层:L1 Domain
// 责任:派工文件落盘 — 把 marker 派工序列化成 md 文件,落在 project.root_dir/doc/dispatch/
//   - Push down (R→H, H→B/C):写新文件
//   - Callback (B/C→H):追加 ## Callback section 到对应 push 文件
//   - Done / Bounce / Reject:追加状态 section 到对应 push 文件
//   - Bounce back (H→R):写新 push 文件(独立追溯)
//
// 文件命名:<task_slug>_<NNN>_<from>_to_<to>_<YYYYMMDD>_<HHMM>.md
// 例:adr006_action_extract_001_R_to_H_20260618_0757.md
//
// 公共 API:
//   - isEnabled(project) → bool
//   - resolveTaskSlug(projectId, threadSlug, providedSlug?) → string
//     从 R 给的 marker, 或 thread.title slugify, 或 thread slug 兜底
//   - onPushDispatch({...}) — 新派工 push 时调用,写新文件
//   - onCallback({...}) — B/C→H 时调用,追加 callback section
//   - onDone / onBounce / onReject — 追加状态 section
//
// 允许依赖:./db (read project / thread) / node:fs / node:path
// 禁止:
//   - 改 MarkerDispatcher 决策(只记录)
//   - 写非 dispatch 路径文件
//   - 改业务状态
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');
const { db } = require('../db');
const log = require('../logger');
const MOD = 'DispatchLogWriter';

/**
 * 给定 project, 决定是否开启派工文件写入
 */
function isEnabled(projectId) {
  try {
    const row = db.prepare(`SELECT dispatch_log_enabled FROM projects WHERE id = ?`).get(projectId);
    return !!(row?.dispatch_log_enabled);
  } catch { return false; }
}

/**
 * slugify: 任何字符串 → safe filename slug (ascii_kebab, max 50 char)
 */
function _slugify(s) {
  if (!s) return '';
  return String(s)
    .toLowerCase()
    .replace(/[一-鿿]/g, '') // 去中文(filename 兼容性)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50);
}

/**
 * 决定 thread 的 task_slug:
 *   1. R 给的 (marker.task_slug 属性) — 持久化到 threads.task_slug
 *   2. fallback: thread.title slugify
 *   3. 兜底: thread.slug 后部分
 *
 * 一旦设置,后续 dispatches 复用同一 task_slug。
 */
function resolveTaskSlug(projectId, threadSlug, providedSlug = null) {
  // 已有 task_slug → 复用(R 第一次设了,后续 H/B 无需再写)
  try {
    const row = db.prepare(`SELECT task_slug, title, slug FROM threads WHERE project_id = ? AND slug = ?`).get(projectId, threadSlug);
    if (!row) return _slugify(threadSlug);

    if (row.task_slug) return row.task_slug;

    // 新设置
    let slug = providedSlug
      ? _slugify(providedSlug)
      : (_slugify(row.title) || _slugify(row.slug));
    if (!slug) slug = _slugify(threadSlug.slice(0, 12));

    // 持久化
    try {
      db.prepare(`UPDATE threads SET task_slug = ? WHERE project_id = ? AND slug = ?`)
        .run(slug, projectId, threadSlug);
    } catch (e) {
      log.warn({ module: MOD, event: 'task_slug_persist_failed', error: e.message });
    }
    return slug;
  } catch (e) {
    log.warn({ module: MOD, event: 'resolve_task_slug_failed', error: e.message });
    return _slugify(threadSlug);
  }
}

/**
 * 派工序号 — 该 thread 下当前是第几次 push down
 */
function _getNextSeq(projectId, threadSlug) {
  try {
    const row = db.prepare(`SELECT metadata_json FROM threads WHERE project_id = ? AND slug = ?`).get(projectId, threadSlug);
    if (!row) return 1;
    const meta = JSON.parse(row.metadata_json || '{}');
    const chain = meta.dispatch_chain || [];
    // count push down handoffs (R→H, H→B, H→C; 排除 callback B→H, C→H, bounce H→R)
    // 注:本函数在 MarkerDispatcher 的 chain append 后调用,所以当前这次 push 已在 chain 里
    // → 不 +1 直接返 count
    let n = 0;
    for (const seg of chain) {
      if (seg.kind !== 'handoff') continue;
      const f = (seg.fromRole || '').toLowerCase();
      const t = (seg.toRole || '').toLowerCase();
      const isCallback = (f.includes('mate-b') || f.includes('mate-c') || f.includes('executor') || f.includes('validator'))
                        && (t.includes('mate-h') || t.includes('orchestrator'));
      const isBounce = (f.includes('mate-h') || f.includes('orchestrator')) && (t.includes('mate-r') || t.includes('requirements'));
      if (isCallback || isBounce) continue;
      n++;
    }
    return Math.max(1, n);
  } catch { return 1; }
}

// R/H singleton 不带 slot,只 B/C 区分(B-1 vs B-2 是真有意义的)
function _roleShort(inst) {
  if (!inst) return '?';
  const roleName = inst.role?.name || inst.roleName || '';
  const slot = inst.poolSlot;
  const displayName = inst.displayName || '';

  const n = String(roleName).toLowerCase();
  if (n.includes('mate-r') || n.includes('requirements')) return 'R';
  if (n.includes('mate-h') || n.includes('orchestrator')) return 'H';
  if (n.includes('mate-b') || n.includes('executor')) {
    // 从 displayName 抓 slot,fallback poolSlot
    const m = displayName.match(/mate-b-?(\d+)/i);
    const s = m ? m[1] : slot;
    return s ? `B-${s}` : 'B';
  }
  if (n.includes('mate-c') || n.includes('validator')) {
    const m = displayName.match(/mate-c-?(\d+)/i);
    const s = m ? m[1] : slot;
    return s ? `C-${s}` : 'C';
  }
  // fallback: 用 displayName
  const m2 = displayName.match(/mate-([rhbc])-?(\d+)?/i);
  if (m2) {
    const letter = m2[1].toUpperCase();
    if (letter === 'B' || letter === 'C') return m2[2] ? `${letter}-${m2[2]}` : letter;
    return letter;
  }
  return n || '?';
}

function _formatTs(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function _ensureDispatchDir(projectRootDir) {
  const dispatchDir = path.join(projectRootDir, 'doc', 'dispatch');
  try {
    fs.mkdirSync(dispatchDir, { recursive: true });
  } catch (e) {
    log.warn({ module: MOD, event: 'mkdir_failed', dispatchDir, error: e.message });
  }
  return dispatchDir;
}

/**
 * push 派工 (R→H 或 H→B/C) 时调用,写新文件
 *
 * @returns {string|null} 写入的文件绝对路径(成功)或 null(失败/未启用)
 */
function onPushDispatch({
  projectId,
  projectRootDir,
  threadSlug,
  fromInst,
  toInst,
  reason,
  taskSlug,
  recentContext, // 可选 — H 派工时的最近 N 条 conversation context
}) {
  if (!isEnabled(projectId)) return null;
  if (!projectRootDir) return null;

  try {
    const resolvedSlug = resolveTaskSlug(projectId, threadSlug, taskSlug);
    const seq = _getNextSeq(projectId, threadSlug);
    const fromShort = _roleShort(fromInst);
    const toShort = _roleShort(toInst);
    const ts = Date.now();
    const tsStr = _formatTs(ts);

    const filename = `${resolvedSlug}_${String(seq).padStart(3, '0')}_${fromShort}_to_${toShort}_${tsStr}.md`;
    const dispatchDir = _ensureDispatchDir(projectRootDir);
    const filepath = path.join(dispatchDir, filename);

    const lines = [
      `# 派工 #${String(seq).padStart(3, '0')} — ${fromShort} → ${toShort}`,
      ``,
      `**task_slug**: \`${resolvedSlug}\``,
      `**thread**: \`${threadSlug}\``,
      `**timestamp**: ${new Date(ts).toISOString()}`,
      `**from**: \`${fromInst?.id || '?'}\` (${fromInst?.role?.name || fromInst?.roleName || '?'})`,
      `**to**: \`${toInst?.id || '?'}\` (${toInst?.role?.name || toInst?.roleName || '?'})`,
      ``,
      `## Reason (marker reason 字段)`,
      ``,
      reason || '_(none)_',
      ``,
    ];

    if (recentContext) {
      lines.push('## Recent conversation context');
      lines.push('');
      lines.push('```');
      lines.push(String(recentContext).slice(0, 8000));
      lines.push('```');
      lines.push('');
    }

    lines.push('---');
    lines.push('');
    lines.push('_后续 callback / done / bounce / reject 会追加到本文件末尾_');
    lines.push('');

    fs.writeFileSync(filepath, lines.join('\n'), 'utf8');

    // 在 thread.metadata 记一下文件路径,callback 时能找到对应 push 文件
    try {
      const row = db.prepare(`SELECT metadata_json FROM threads WHERE project_id = ? AND slug = ?`).get(projectId, threadSlug);
      const meta = JSON.parse(row.metadata_json || '{}');
      if (!meta.dispatch_files) meta.dispatch_files = [];
      meta.dispatch_files.push({
        seq, file: filename, fromRoleType: fromInst?.role?.type, toRoleType: toInst?.role?.type, ts,
      });
      db.prepare(`UPDATE threads SET metadata_json = ?, updated_at = ? WHERE project_id = ? AND slug = ?`)
        .run(JSON.stringify(meta), Date.now(), projectId, threadSlug);
    } catch (e) {
      log.warn({ module: MOD, event: 'track_dispatch_file_failed', error: e.message });
    }

    return filepath;
  } catch (e) {
    log.warn({ module: MOD, event: 'on_push_dispatch_failed', error: e.message });
    return null;
  }
}

/**
 * 找最近一个 push 文件(给当前 callback / done 等做追加)
 */
function _findLatestPushFile(projectId, threadSlug, projectRootDir) {
  try {
    const row = db.prepare(`SELECT metadata_json FROM threads WHERE project_id = ? AND slug = ?`).get(projectId, threadSlug);
    if (!row) return null;
    const meta = JSON.parse(row.metadata_json || '{}');
    const files = meta.dispatch_files || [];
    if (!files.length) return null;
    const latest = files[files.length - 1];
    const filepath = path.join(projectRootDir, 'doc', 'dispatch', latest.file);
    if (fs.existsSync(filepath)) return filepath;
    return null;
  } catch { return null; }
}

/**
 * 追加 section 到最近一个 push 文件
 */
function _appendSection({ projectId, projectRootDir, threadSlug, title, body }) {
  if (!isEnabled(projectId)) return null;
  const filepath = _findLatestPushFile(projectId, threadSlug, projectRootDir);
  if (!filepath) return null;
  try {
    const lines = [
      '',
      `## ${title}`,
      `_at ${new Date().toISOString()}_`,
      '',
      body,
      '',
    ];
    fs.appendFileSync(filepath, lines.join('\n'), 'utf8');
    return filepath;
  } catch (e) {
    log.warn({ module: MOD, event: 'append_failed', error: e.message });
    return null;
  }
}

function onCallback({ projectId, projectRootDir, threadSlug, fromInst, summary }) {
  const fromShort = _roleShort(fromInst);
  return _appendSection({
    projectId, projectRootDir, threadSlug,
    title: `Callback — ${fromShort} 返回结果`,
    body: summary || '_(no summary)_',
  });
}

function onDone({ projectId, projectRootDir, threadSlug, fromInst, summary, isTerminal }) {
  const fromShort = _roleShort(fromInst);
  return _appendSection({
    projectId, projectRootDir, threadSlug,
    title: `Done${isTerminal ? ' (terminal — thread verified)' : ''} — ${fromShort}`,
    body: summary || '_(no summary)_',
  });
}

function onBounce({ projectId, projectRootDir, threadSlug, fromInst, reason }) {
  const fromShort = _roleShort(fromInst);
  return _appendSection({
    projectId, projectRootDir, threadSlug,
    title: `Bounce — ${fromShort} 弹回 R`,
    body: reason || '_(no reason)_',
  });
}

function onReject({ projectId, projectRootDir, threadSlug, fromInst, reason }) {
  const fromShort = _roleShort(fromInst);
  return _appendSection({
    projectId, projectRootDir, threadSlug,
    title: `Reject — ${fromShort}`,
    body: reason || '_(no reason)_',
  });
}

function onBlocked({ projectId, projectRootDir, threadSlug, fromInst, question, severity }) {
  const fromShort = _roleShort(fromInst);
  return _appendSection({
    projectId, projectRootDir, threadSlug,
    title: `Blocked — ${fromShort} 问 user (${severity || 'mid'})`,
    body: question || '_(no question)_',
  });
}

module.exports = {
  isEnabled,
  resolveTaskSlug,
  onPushDispatch,
  onCallback,
  onDone,
  onBounce,
  onReject,
  onBlocked,
};
