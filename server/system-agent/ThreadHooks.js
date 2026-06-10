// [需求@2026-06-10 §1.4, §1.6] Thread 级 hook,在每轮 (result event) 结束后:
//   1. 自增 metadata.assistant_turn_count
//   2. 首轮(count==1)或 count in [6,11,16,...] → 异步触发 title 摘要
//   3. 始终异步触发 reply-template 生成,通过 WS 推给前端预填输入框
//   4. 始终异步触发 blocked-detection,通过 WS 推黄灯闪烁状态(2C.7 用)
//
// 所有调用都是 fire-and-forget(不阻塞主流程)。SystemAgent 异常被吞掉 + log。

const SystemAgent = require('./SystemAgent');
const ThreadStore = require('../threads/ThreadStore');
const bus = require('../messageBus');
const { db } = require('../db');

const TITLE_REFRESH_INTERVAL = 5;  // 首轮 + 每 5 轮 refresh

const ThreadHooks = {
  // 调用方:SpawnManager._wireListeners 在 inst.on('event') 收到 result 事件时触发
  async onResultEvent({ projectId, threadSlug, instanceId }) {
    if (!projectId || !threadSlug) return;
    const thread = ThreadStore.get(projectId, threadSlug);
    if (!thread) return;

    const meta = thread.metadata || {};
    const prevCount = meta.assistant_turn_count || 0;
    const newCount = prevCount + 1;

    // 增计数器(同步,小事务)
    try {
      const merged = { ...meta, assistant_turn_count: newCount };
      db.prepare(`UPDATE threads SET metadata_json = ?, updated_at = ? WHERE project_id = ? AND slug = ?`)
        .run(JSON.stringify(merged), Date.now(), projectId, threadSlug);
    } catch (e) {
      console.warn(`[ThreadHooks] turn_count update failed: ${e.message}`);
    }

    // 取最近一轮 user+assistant 文本(用于 title 摘要 + reply 模板)
    const exchange = this._fetchRecentExchange(projectId, threadSlug);

    // [§1.4] 首轮 / 每 5 轮触发 title 摘要 — 异步,不阻塞
    if (newCount === 1 || (newCount > 1 && (newCount - 1) % TITLE_REFRESH_INTERVAL === 0)) {
      this._summarizeTitleAsync(projectId, threadSlug, exchange).catch((e) => {
        console.warn(`[ThreadHooks] title summary failed (${threadSlug}):`, e.message);
      });
    }

    // [§1.6] 总是触发 reply-template — 异步
    if (exchange.lastAssistantText) {
      this._generateReplyTemplateAsync(projectId, threadSlug, exchange.lastAssistantText).catch((e) => {
        console.warn(`[ThreadHooks] reply template failed (${threadSlug}):`, e.message);
      });
    }
  },

  // 取最近一条 user message + 最近一条 assistant message 的文本
  _fetchRecentExchange(projectId, threadSlug) {
    const userRow = db.prepare(`
      SELECT payload_json FROM messages
      WHERE project_id = ? AND thread_slug = ? AND event_type = 'user'
      ORDER BY ts DESC LIMIT 1
    `).get(projectId, threadSlug);
    const assistantRow = db.prepare(`
      SELECT payload_json FROM messages
      WHERE project_id = ? AND thread_slug = ? AND event_type = 'assistant'
      ORDER BY ts DESC LIMIT 1
    `).get(projectId, threadSlug);

    const extractText = (row) => {
      if (!row) return '';
      try {
        const p = JSON.parse(row.payload_json);
        const content = p.message?.content;
        if (Array.isArray(content)) {
          return content.filter((c) => c.type === 'text').map((c) => c.text).join('');
        }
        if (typeof content === 'string') return content;
      } catch {}
      return '';
    };

    return {
      lastUserText: extractText(userRow),
      lastAssistantText: extractText(assistantRow),
    };
  },

  async _summarizeTitleAsync(projectId, threadSlug, exchange) {
    if (!exchange.lastUserText && !exchange.lastAssistantText) return;
    const title = await SystemAgent.summarizeTitle(exchange.lastUserText, exchange.lastAssistantText);
    if (!title) return;

    // Update DB
    try {
      ThreadStore.setTitle(projectId, threadSlug, title);
    } catch (e) {
      console.warn(`[ThreadHooks] setTitle failed:`, e.message);
      return;
    }

    // Publish to FE
    const updated = ThreadStore.get(projectId, threadSlug);
    bus.publish('thread.title_updated', {
      projectId,
      threadSlug,
      title,
      thread: updated,
    });
  },

  async _generateReplyTemplateAsync(projectId, threadSlug, assistantText) {
    const r = await SystemAgent.generateReplyTemplate(assistantText);
    if (!r.hasQuestion) return;  // 没问题就不推
    if (!r.template) return;

    bus.publish('thread.suggested_reply', {
      projectId,
      threadSlug,
      template: r.template,
      reasoning: r.reasoning,
    });
  },
};

module.exports = ThreadHooks;
