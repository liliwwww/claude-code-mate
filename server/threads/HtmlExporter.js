// ============================================================================
// MODULE CONTRACT
// ----------------------------------------------------------------------------
// 层:L1 Domain
// 责任:把 thread messages 拼成 standalone HTML(inline CSS,保留 mate UI 视觉风格)
// 公共 API:
//   - buildHtml(thread, messages, opts) → string
// 允许依赖:marked(L0)、./MarkdownExporter(共享 helpers)
// 设计原则:
//   - HTML 必须 standalone — 不引外部 CDN / image,inline 所有 style
//   - 保留 mate UI 风格:role bubble 左色条、role 颜色、code 高亮、表格
//   - Word 可打开(用 Word 时 CSS 渲染降级但内容/结构完整)
// ============================================================================
//
// [需求@2026-06-29 #172] HTML 导出 — markdown 朴素,user 想要 UI 看到的字体/
//   颜色/图标保留。HTML 是 mate UI native 格式,inline CSS 可 100% 保真。

const { marked } = require('marked');
const {
  _fmtTime,
  _stripTaskTag,
  _roleLabelFromInstance,
  _summarizeToolUse,
} = require('./MarkdownExporter');

// 关键:Marked 选项 — 我们要安全 HTML(escape) + GFM 表格 + breaks(换行变 <br>)
marked.setOptions({
  gfm: true,
  breaks: false,
  headerIds: true,
});

function buildHtml(thread, messages, opts = {}) {
  const { range = { ms: null, label: '全部' }, now = Date.now(), projectName = null } = opts;
  const escapedTitle = _escapeHtml(thread.title || thread.slug);

  const headerHtml = _buildHeaderHtml(thread, range, now, projectName, messages.length);
  const bodyHtml = _buildBodyHtml(messages);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapedTitle}</title>
<style>${EMBEDDED_CSS}</style>
</head>
<body>
<div class="page">
${headerHtml}
<div class="stream">
${bodyHtml}
</div>
<footer class="footer">
  自动从 <strong>Claude Code Mate</strong> 导出 · 仅供归档参考
</footer>
</div>
</body>
</html>
`;
}

function _buildHeaderHtml(thread, range, now, projectName, msgCount) {
  const rows = [
    ['slug', `<code>${_escapeHtml(thread.slug)}</code>`],
    ...(projectName ? [['project', _escapeHtml(projectName)]] : []),
    ['stage', _escapeHtml(thread.stage || '?')],
    ...(thread.outcome ? [['outcome', _escapeHtml(thread.outcome)]] : []),
    ['created', _fmtTime(thread.created_at)],
    ['updated', _fmtTime(thread.updated_at)],
    ['导出范围', _escapeHtml(range.label)],
    ['导出时间', _fmtTime(now)],
    ['消息条数', String(msgCount)],
  ];
  const rowsHtml = rows.map(([k, v]) => `  <tr><td class="k">${k}</td><td>${v}</td></tr>`).join('\n');
  return `<header class="thread-header">
  <h1>${_escapeHtml(thread.title || thread.slug)}</h1>
  <table class="meta">
${rowsHtml}
  </table>
</header>`;
}

function _buildBodyHtml(messages) {
  if (!messages.length) {
    return `<div class="empty"><em>(该时间范围内无消息)</em></div>`;
  }
  const blocks = [];
  for (const m of messages) {
    const block = _renderMessageBlock(m);
    if (block) blocks.push(block);
  }
  return blocks.join('\n');
}

function _renderMessageBlock(m) {
  const p = m.payload || {};
  const ts = _fmtTime(m.ts);
  const evt = m.event_type;

  if (evt === 'user' && m.direction === 'user_to_role') {
    const content = p.message?.content || [];
    const texts = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (!texts.trim()) return null;
    const cleaned = _stripTaskTag(texts);
    const isMarkerInject = cleaned.startsWith('[<') || /^Thread handoff from /m.test(cleaned);
    if (isMarkerInject) {
      // 系统注入(派工 callback) — 折叠 details
      return _renderRole('system-inject', '⚙ 系统 (派工注入)', ts, _renderFolded(cleaned));
    }
    // 真 user 输入 — 等宽 / 保留空白
    return _renderRole('user', '👤 user', ts, `<pre class="user-text">${_escapeHtml(cleaned.trim())}</pre>`);
  }

  if (evt === 'assistant' && m.direction === 'role_to_user') {
    const content = p.message?.content || [];
    const partsHtml = [];
    for (const c of content) {
      if (c.type === 'text' && c.text) {
        // 用 marked 把 markdown 渲染成 HTML
        partsHtml.push(`<div class="md-content">${marked.parse(c.text)}</div>`);
      } else if (c.type === 'tool_use') {
        const summary = _summarizeToolUse(c);
        partsHtml.push(`<div class="tool-hint">🔧 <em>${_escapeHtml(summary)}</em></div>`);
      }
    }
    if (!partsHtml.length) return null;
    const roleLabel = _roleLabelFromInstance(m.instance_id);
    const roleCls = _roleCssClassFromInstance(m.instance_id);
    return _renderRole(roleCls, `🤖 ${_escapeHtml(roleLabel)}`, ts, partsHtml.join(''));
  }

  if (evt === 'user' && m.direction === 'role_to_role') {
    const content = p.message?.content || [];
    const texts = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    const cleaned = _stripTaskTag(texts);
    if (!cleaned.trim()) return null;
    return _renderRole('role2role', '🔁 角色间派工', ts, _renderFolded(cleaned));
  }

  return null;
}

function _renderRole(cls, speakerLabel, ts, innerHtml) {
  return `<div class="msg msg-${cls}">
  <div class="msg-meta"><span class="speaker">${speakerLabel}</span> <span class="ts">${ts}</span></div>
  <div class="msg-body">${innerHtml}</div>
</div>`;
}

function _renderFolded(text) {
  return `<details><summary>展开内容</summary><pre>${_escapeHtml(text)}</pre></details>`;
}

function _roleCssClassFromInstance(instId) {
  const s = String(instId || '');
  if (s.includes('mate-R')) return 'role-r';
  if (s.includes('mate-H')) return 'role-h';
  if (s.includes('mate-B')) return 'role-b';
  if (s.includes('mate-C')) return 'role-c';
  return 'role-x';
}

function _escapeHtml(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ============================================================================
// Embedded CSS — 精炼版 mate UI 风格(只取 #stream / .msg.* 必要规则)
// resolved CSS variables 成 hex(脱离 :root vars 依赖 — Word 也能渲染)
// ============================================================================

const EMBEDDED_CSS = `
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 24px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Microsoft YaHei", "微软雅黑", sans-serif;
  background: #1a1a1c;
  color: #e8e8ea;
  font-size: 14px;
  line-height: 1.6;
}
.page { max-width: 980px; margin: 0 auto; }

.thread-header { margin-bottom: 24px; }
.thread-header h1 { font-size: 22px; color: #e8e8ea; margin: 0 0 12px; border-bottom: 2px solid #4a8cff; padding-bottom: 8px; }
.thread-header .meta { font-size: 12px; border-collapse: collapse; }
.thread-header .meta td { padding: 3px 12px 3px 0; vertical-align: top; color: #b0b0b5; }
.thread-header .meta td.k { color: #888; width: 80px; }
.thread-header .meta code { background: #2a2a2e; padding: 1px 6px; border-radius: 3px; font-size: 11px; color: #d8a33a; }

.stream { display: flex; flex-direction: column; gap: 10px; }

.msg { padding: 10px 12px; border-radius: 6px; border-left: 3px solid transparent; background: #232327; word-wrap: break-word; }
.msg-meta { font-size: 11px; color: #888; margin-bottom: 6px; display: flex; gap: 10px; align-items: center; }
.msg-meta .speaker { font-weight: 600; text-transform: none; }
.msg-meta .ts { color: #666; font-size: 10px; }
.msg-body { font-size: 13.5px; }

/* user: 等宽,深蓝边 */
.msg-user { background: #1e2a3a; border-left-color: #4a8cff; }
.msg-user .speaker { color: #6ab1ff; }
.msg-user .user-text {
  margin: 0;
  font-family: ui-monospace, "Cascadia Code", Consolas, "JetBrains Mono", monospace;
  font-size: 12.5px;
  white-space: pre-wrap;
  background: transparent;
  border: none;
  padding: 0;
  color: #e8e8ea;
}

/* role-r (R/需求): 浅蓝 */
.msg-role-r { background: #1e2738; border-left-color: #88ccff; }
.msg-role-r .speaker { color: #88ccff; }

/* role-h (H/编排): 橙 */
.msg-role-h { background: #2e2618; border-left-color: #ffcc66; }
.msg-role-h .speaker { color: #ffcc66; }

/* role-b (B/执行): 绿 */
.msg-role-b { background: #1e2a1e; border-left-color: #aaffaa; }
.msg-role-b .speaker { color: #aaffaa; }

/* role-c (C/验证): 粉 */
.msg-role-c { background: #2a1e2a; border-left-color: #ffaaff; }
.msg-role-c .speaker { color: #ffaaff; }

/* role 间派工 / 系统注入: 灰底 */
.msg-role2role, .msg-system-inject { background: #1c1c20; border-left-color: #555; font-size: 12px; }
.msg-role2role .speaker, .msg-system-inject .speaker { color: #999; }
.msg-role2role details, .msg-system-inject details { font-size: 12px; color: #aaa; }
.msg-role2role details summary, .msg-system-inject details summary { cursor: pointer; padding: 2px 0; user-select: none; }
.msg-role2role pre, .msg-system-inject pre { background: #14141a; padding: 8px; border-radius: 4px; overflow-x: auto; }

.tool-hint { color: #888; font-size: 12px; padding: 2px 0; }

/* Markdown content */
.md-content > :first-child { margin-top: 0; }
.md-content > :last-child { margin-bottom: 0; }
.md-content h1 { font-size: 20px; margin: 18px 0 10px; color: #e8e8ea; border-bottom: 1px solid #333; padding-bottom: 4px; }
.md-content h2 { font-size: 17px; margin: 16px 0 8px; color: #e8e8ea; }
.md-content h3 { font-size: 15px; margin: 14px 0 6px; color: #d0d0d5; }
.md-content h4 { font-size: 14px; margin: 12px 0 6px; color: #c0c0c5; }
.md-content p { margin: 8px 0; }
.md-content ul, .md-content ol { padding-left: 24px; margin: 8px 0; }
.md-content li { margin: 3px 0; }
.md-content strong { color: #ffd88a; font-weight: 600; }
.md-content em { color: #d0d0d5; }
.md-content a { color: #6ab1ff; text-decoration: none; }
.md-content a:hover { text-decoration: underline; }
.md-content code {
  font-family: ui-monospace, Consolas, "Cascadia Code", monospace;
  background: #14141a;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 12px;
  color: #ff9e6a;
}
.md-content pre {
  background: #14141a;
  border: 1px solid #2a2a2e;
  border-radius: 5px;
  padding: 10px 12px;
  overflow-x: auto;
  font-size: 12.5px;
  line-height: 1.5;
}
.md-content pre code {
  background: transparent;
  padding: 0;
  color: #d8d8dc;
  font-size: inherit;
}
.md-content blockquote {
  border-left: 3px solid #555;
  padding: 4px 12px;
  margin: 8px 0;
  color: #b0b0b5;
  background: rgba(80, 80, 90, 0.12);
}
.md-content table {
  border-collapse: collapse;
  width: auto;
  margin: 10px 0;
  font-size: 13px;
}
.md-content th, .md-content td {
  border: 1px solid #3a3a3e;
  padding: 6px 12px;
  text-align: left;
  vertical-align: top;
}
.md-content th { background: #2a2a2e; color: #ffd88a; font-weight: 600; }
.md-content tr:nth-child(even) td { background: rgba(255, 255, 255, 0.02); }
.md-content hr { border: none; border-top: 1px solid #333; margin: 16px 0; }
.md-content img { max-width: 100%; }

.empty { padding: 40px; text-align: center; color: #666; font-style: italic; }

.footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #333; font-size: 11px; color: #888; text-align: center; }

/* Word/Light viewer 兼容 — @media print 用浅色,避免黑底打不出来 */
@media print {
  body { background: #fff; color: #000; }
  .msg { background: #f5f5f5 !important; border: 1px solid #ddd; }
  .msg-meta .speaker { color: #000 !important; }
  .md-content pre, .md-content code { background: #f0f0f0 !important; color: #000 !important; }
  .md-content table th { background: #e0e0e0 !important; color: #000 !important; }
  .md-content strong { color: #000 !important; }
}
`;

module.exports = {
  buildHtml,
};
