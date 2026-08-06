// ============================================================================
// MODULE CONTRACT(架构 SSOT:docs/architecture.md §3 §4 §6)
// ----------------------------------------------------------------------------
// 层:L3 Business Hooks
// 责任:result event 后触发的 metadata 自动化(标题摘要 / reply-template /
//   has_pending_question)— 所有调用 fire-and-forget,不阻塞 result 主流程
// 公共 API:onResultEvent({ projectId, threadSlug, instanceId })
// 允许依赖:db / SystemAgent / ThreadStore / messageBus
// 禁止:
//   - 阻塞主流程(必须 async fire-and-forget)
//   - **反向 require** spawn/SpawnManager(L3 → L2 循环依赖)
//     当前可能有违例,见 arch-debt §5
//   - 持久化 message(只更 thread.metadata)
// ============================================================================
//
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
const log = require('../logger');
const MOD = 'ThreadHooks';

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
      log.warn({ module: MOD, event: 'turn_count_update_failed', error: e.message });
    }

    // 取最近一轮 user+assistant 文本(用于 title 摘要 + reply 模板)
    const exchange = this._fetchRecentExchange(projectId, threadSlug);

    // [§1.4] 首轮 / 每 5 轮触发 title 摘要 — 异步,不阻塞
    if (newCount === 1 || (newCount > 1 && (newCount - 1) % TITLE_REFRESH_INTERVAL === 0)) {
      this._summarizeTitleAsync(projectId, threadSlug, exchange).catch((e) => {
        log.warn({ module: MOD, event: 'title_summary_failed', threadSlug, error: e.message });
      });
    }

    // [§1.6] 总是触发 reply-template — 异步
    if (exchange.lastAssistantText) {
      this._generateReplyTemplateAsync(projectId, threadSlug, exchange.lastAssistantText).catch((e) => {
        log.warn({ module: MOD, event: 'reply_template_failed', threadSlug, error: e.message });
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

    // [需求@2026-06-15] user 显式设过 title → metadata.title_locked=true,跳过自动摘要
    //   (避免 user 取的名字第一轮就被 SystemAgent 摘要覆盖)
    const current = ThreadStore.get(projectId, threadSlug);
    if (current?.metadata?.title_locked) {
      return;
    }

    const title = await SystemAgent.summarizeTitle(exchange.lastUserText, exchange.lastAssistantText);
    if (!title) return;

    // Update DB(fromUser=false:不动 title_locked,以便 user 之后还能手改并 lock)
    try {
      ThreadStore.setTitle(projectId, threadSlug, title, { fromUser: false });
    } catch (e) {
      log.warn({ module: MOD, event: 'set_title_failed', error: e.message });
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

  // [需求@2026-06-11 §1+§4] reply-template 改成问题清单 + 同步设黄灯状态
  //   - has_questions=true 时:
  //     1. thread.metadata.has_pending_question = true → 前端 computeStateLight 黄闪
  //     2. WS 推 questions 给前端 → 前端格式化成"Q1: ...\n答:\n\nQ2: ..."填入输入框
  //   - has_questions=false 时:
  //     1. 清除 thread.metadata.has_pending_question(R 自答完了,等下一条 user 输入)
  async _generateReplyTemplateAsync(projectId, threadSlug, assistantText) {
    const r = await SystemAgent.generateReplyTemplate(assistantText);

    // Patch thread.metadata.has_pending_question
    const thread = ThreadStore.get(projectId, threadSlug);
    if (thread) {
      const meta = thread.metadata || {};
      const wasPending = !!meta.has_pending_question;
      if (r.hasQuestions) {
        meta.has_pending_question = true;
        meta.pending_questions = r.questions;
        meta.pending_questions_at = Date.now();
        // [需求@2026-06-12 §6.2 Gap 1] 记 last_questioner = 当前角色的实例 id
        //   user 在该 thread 回复时 sendToThread 用 last_questioner 找回路由(role.type)
        meta.last_questioner_role_type = thread.metadata?._current_role_type || null;
      } else if (wasPending) {
        delete meta.has_pending_question;
        delete meta.pending_questions;
        delete meta.pending_questions_at;
        delete meta.last_questioner_role_type;
      }
      if (r.hasQuestions || wasPending) {
        try {
          db.prepare(`UPDATE threads SET metadata_json = ?, updated_at = ? WHERE project_id = ? AND slug = ?`)
            .run(JSON.stringify(meta), Date.now(), projectId, threadSlug);
        } catch (e) {
          log.warn({ module: MOD, event: 'pending_question_persist_failed', error: e.message });
        }
        // Publish updated thread so front-end recomputes state light
        bus.publish('thread.metadata_updated', {
          projectId,
          threadSlug,
          thread: ThreadStore.get(projectId, threadSlug),
        });
      }
    }

    // Push the questions list to the focused input (FE decides format)
    if (r.hasQuestions && r.questions.length > 0) {
      bus.publish('thread.suggested_reply', {
        projectId,
        threadSlug,
        questions: r.questions,
      });
    }
  },
};

module.exports = ThreadHooks;
