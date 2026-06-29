// ============================================================================
// MODULE CONTRACT
// ----------------------------------------------------------------------------
// 层:L1 Domain
// 责任:把 thread 的 messages 流拼成 markdown 文本(给 user 阅读 / 归档)
// 公共 API:
//   - buildMarkdown(thread, messages, opts) → string
//   - filterByRange(messages, range, now) → filtered messages
//   - parseRange(rangeStr) → { ms: <millis> | null, label: string }
// 允许依赖:无(纯函数,不读 DB / 不写 FS)
// ============================================================================
//
// [需求@2026-06-29 #171] 线索导出 markdown:user 想把跟某个 thread 的对话
//   (user 提问 + R/H assistant 回答 + 关键派工事件) 导成可读 md 归档。

/**
 * Parse range string ('all' | '1d' | '3d' | '7d') → { ms, label }
 * ms = null 表示"全部"
 */
function parseRange(rangeStr) {
  const map = {
    'all': { ms: null, label: '全部' },
    '1d':  { ms: 1 * 86400_000, label: '近 1 天' },
    '3d':  { ms: 3 * 86400_000, label: '近 3 天' },
    '7d':  { ms: 7 * 86400_000, label: '近 7 天' },
  };
  return map[rangeStr] || map['all'];
}

/**
 * 按时间范围过滤 messages。msgs 必须按 ts 升序,filtered 也升序。
 * range.ms = null → 全部
 * 否则保留 now - ms <= ts <= now 的
 */
function filterByRange(messages, range, now) {
  if (!range.ms) return messages;
  const cutoff = now - range.ms;
  return messages.filter((m) => m.ts >= cutoff);
}

/**
 * 把 messages 拼成 markdown。
 *
 * @param thread {slug, title, stage, outcome, created_at, updated_at, metadata}
 * @param messages 升序 messages[]:每个 {ts, event_type, payload (parsed object), direction, instance_id}
 * @param opts { range: { ms, label }, now: ms timestamp, projectName?: string }
 * @returns markdown string
 */
function buildMarkdown(thread, messages, opts = {}) {
  const { range = { ms: null, label: '全部' }, now = Date.now(), projectName = null } = opts;
  const lines = [];

  // ===== Header =====
  lines.push(`# ${thread.title || thread.slug}`);
  lines.push('');
  lines.push('> 自动从 Claude Code Mate 导出 — 仅供归档参考');
  lines.push('');
  lines.push('| | |');
  lines.push('|---|---|');
  lines.push(`| **slug** | \`${thread.slug}\` |`);
  if (projectName) lines.push(`| **project** | ${projectName} |`);
  lines.push(`| **stage** | ${thread.stage || '?'} |`);
  if (thread.outcome) lines.push(`| **outcome** | ${thread.outcome} |`);
  lines.push(`| **created** | ${_fmtTime(thread.created_at)} |`);
  lines.push(`| **updated** | ${_fmtTime(thread.updated_at)} |`);
  lines.push(`| **导出范围** | ${range.label} |`);
  lines.push(`| **导出时间** | ${_fmtTime(now)} |`);
  lines.push(`| **消息条数** | ${messages.length} |`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // ===== Body =====
  if (!messages.length) {
    lines.push('_(该时间范围内无消息)_');
    return lines.join('\n');
  }

  let lastSpeaker = null;
  for (const m of messages) {
    const p = m.payload || {};
    const ts = _fmtTime(m.ts);
    const evt = m.event_type;

    if (evt === 'user' && m.direction === 'user_to_role') {
      // user 提问(可能是真 user,也可能是 marker 注入的 [<delegate ...>] 消息)
      const content = p.message?.content || [];
      const texts = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      if (!texts.trim()) continue;
      // 跳过纯 task tag(`[Thread: xxx | Project: N]\n\n...`),用 user 真意图部分
      const cleaned = _stripTaskTag(texts);
      const isMarkerInject = cleaned.startsWith('[<') || /^Thread handoff from /m.test(cleaned);
      const speaker = isMarkerInject ? '⚙ 系统 (派工注入)' : '👤 user';
      _maybeBlankLine(lines, lastSpeaker, speaker);
      lines.push(`### ${speaker} · ${ts}`);
      lines.push('');
      lines.push(cleaned.trim());
      lines.push('');
      lastSpeaker = speaker;
    } else if (evt === 'assistant' && m.direction === 'role_to_user') {
      // R/H/B/C 回答
      const content = p.message?.content || [];
      const parts = [];
      let hasText = false;
      for (const c of content) {
        if (c.type === 'text' && c.text) {
          parts.push(c.text);
          hasText = true;
        } else if (c.type === 'tool_use') {
          // 简短摘要,不展开 input 防 noise
          const summary = _summarizeToolUse(c);
          parts.push(`> 🔧 _${summary}_`);
        }
      }
      if (!parts.length) continue;
      const roleLabel = _roleLabelFromInstance(m.instance_id);
      const speaker = `🤖 ${roleLabel}`;
      _maybeBlankLine(lines, lastSpeaker, speaker);
      lines.push(`### ${speaker} · ${ts}`);
      lines.push('');
      lines.push(parts.join('\n\n').trim());
      lines.push('');
      lastSpeaker = speaker;
    } else if (evt === 'user' && m.direction === 'role_to_role') {
      // 角色间消息(handoff 注入) — 简化展示,只标方向
      const content = p.message?.content || [];
      const texts = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      const cleaned = _stripTaskTag(texts);
      if (!cleaned.trim()) continue;
      const speaker = '🔁 角色间派工';
      _maybeBlankLine(lines, lastSpeaker, speaker);
      lines.push(`### ${speaker} · ${ts}`);
      lines.push('');
      // 折叠成 detail 防长 marker reason 占太大版面
      lines.push('<details><summary>展开</summary>');
      lines.push('');
      lines.push(cleaned.trim());
      lines.push('');
      lines.push('</details>');
      lines.push('');
      lastSpeaker = speaker;
    }
    // 其它 event_type (result / system_init / tool_use / tool_result / partial / rate_limit_event) 不导出
  }

  return lines.join('\n');
}

// helpers ---------------------------------------------------------------

function _fmtTime(ts) {
  if (!ts) return '?';
  const d = new Date(ts);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function _stripTaskTag(text) {
  // 去掉 mate 注入的 `[Thread: t-xxx | Project: N]\n\n` 前缀
  return String(text).replace(/^\[Thread:\s*[^|\]]+(\s*\|\s*Project:\s*\d+)?\]\s*\n+/, '');
}

function _roleLabelFromInstance(instId) {
  if (!instId) return '助手';
  const s = String(instId);
  if (s.includes('mate-R')) return 'mate-R (需求)';
  if (s.includes('mate-H')) return 'mate-H (编排)';
  if (s.includes('mate-B')) return 'mate-B (执行)';
  if (s.includes('mate-C')) return 'mate-C (验证)';
  return s;
}

function _summarizeToolUse(c) {
  const name = c.name || '?';
  const input = c.input || {};
  // 取关键参数当摘要
  if (name === 'Read' && input.file_path) return `Read ${input.file_path}`;
  if (name === 'Edit' && input.file_path) return `Edit ${input.file_path}`;
  if (name === 'Write' && input.file_path) return `Write ${input.file_path}`;
  if (name === 'Bash' && input.command) return `Bash: ${String(input.command).slice(0, 80)}`;
  if (name === 'Grep' && input.pattern) return `Grep: ${input.pattern}`;
  if (name === 'Glob' && input.pattern) return `Glob: ${input.pattern}`;
  if (name === 'TodoWrite') return `TodoWrite (${(input.todos || []).length} 项)`;
  return name;
}

function _maybeBlankLine(lines, prev, next) {
  if (prev && prev !== next && lines.length && lines[lines.length - 1] !== '') {
    lines.push('');
  }
}

module.exports = {
  parseRange,
  filterByRange,
  buildMarkdown,
  // 共享 helpers(HtmlExporter 复用,避免重复实现)
  _fmtTime,
  _stripTaskTag,
  _roleLabelFromInstance,
  _summarizeToolUse,
};
