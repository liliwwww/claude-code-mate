// [需求@2026-06-10 §5] System Agent — mate 自己的 LLM 服务
//   见 docs/discussions/2026-06-10-phase-2c-needs.md §5
//
// 用例(三类 task):
//   1. title-summary — 首轮对话结束后摘要线索标题(2C.5)
//   2. reply-template — 每条 assistant final 后判断 + 生成回答模板(2C.6)
//   3. blocked-detection — 判断 assistant 是否输出了 BLOCKED 信号(2C.7 兜底)
//
// 启动模式:每次 query 短命 spawn,完事死。
//   claude -p <input> --output-format json --no-session-persistence \
//     --permission-mode dontAsk --tools "" --json-schema <schema> \
//     --max-budget-usd 0.10 --append-system-prompt <system-prompt>
//
// [bug@2026-06-10] 不能用 `--bare`:它要求 ANTHROPIC_API_KEY,不读 OAuth 登录。
//   Max 订阅 user 没 API key,只能走默认 OAuth path。
//   隔离策略改用:
//     - cwd = mate 自己根目录(不是 sibling 项目),避免污染 sibling jsonl pool
//     - `--no-session-persistence` 不留 jsonl
//     - `--tools ""` 禁所有工具(SystemAgent 是纯文本判断,不需要工具)

const { spawn } = require('node:child_process');
const config = require('../config');
const { recordEvent } = require('../db');

// -------------------- Task definitions --------------------

const TASKS = {
  'title-summary': {
    systemPrompt: `You are a helper that summarizes a Claude Code conversation thread into a short Chinese title.

Given the user's first message and the assistant's first reply, output a concise Chinese title (12 Chinese characters or fewer) that captures the conversation's topic.

CRITICAL: Your entire response must be a single JSON object matching the given schema. No prose, no explanation, just the JSON.`,

    schema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 24 },
      },
      required: ['title'],
      additionalProperties: false,
    },

    buildInput(payload) {
      // payload = { firstUserText: string, firstAssistantText: string }
      return [
        `[User's first message]`,
        payload.firstUserText || '(empty)',
        ``,
        `[Assistant's first reply]`,
        payload.firstAssistantText || '(empty)',
      ].join('\n');
    },
  },

  // [需求@2026-06-11] reply-template 改成"列出问题清单",而不是给答案模板
  //   user 反馈:她要看到所有需要回答的问题,自己填答案,不是 mate 给猜的答案
  //   所以 schema 输出 questions: [{question}],前端格式化成 Q1/答 模板预填输入框
  'reply-template': {
    systemPrompt: `You analyze the last assistant message in a conversation between a user and a specialized Claude Code agent (R/H/execB/testC).

Your job: extract ALL distinct questions the assistant asked the user. A question is anything that genuinely needs the user's input/decision to proceed — direct questions, multiple-choice, requests to confirm, etc.

NOT questions:
- Progress reports (e.g. "I have completed X")
- Statements (e.g. "I will proceed with X")
- Rhetorical questions in the assistant's own reasoning

Output the questions in CHINESE (translate if needed), short and concrete, one per item. Preserve the original meaning. If the assistant asks 3 distinct things, output 3 items. If none, set has_questions=false and questions=[].

CRITICAL: Your entire response must be a single JSON object matching the given schema. No prose.`,

    schema: {
      type: 'object',
      properties: {
        has_questions: { type: 'boolean' },
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string' },
            },
            required: ['question'],
            additionalProperties: false,
          },
        },
      },
      required: ['has_questions', 'questions'],
      additionalProperties: false,
    },

    buildInput(payload) {
      return [
        `[Last assistant message]`,
        payload.assistantText || '(empty)',
      ].join('\n');
    },
  },

  'blocked-detection': {
    systemPrompt: `You analyze the last assistant message from a specialized Claude Code agent (R/H/execB/testC).

Decide whether the agent is in a BLOCKED state — meaning it cannot proceed autonomously and needs a business/requirements decision from the human user.

BLOCKED examples:
- Ambiguous requirements that can't be resolved technically
- Business choice between alternatives that user must make
- Missing information that only the user knows

NOT BLOCKED:
- Technical errors (the agent should debug)
- Progress reports
- Normal conversation back-and-forth

CRITICAL: Your entire response must be a single JSON object matching the given schema. No prose.`,

    schema: {
      type: 'object',
      properties: {
        is_blocked: { type: 'boolean' },
        question: { type: 'string' },
        severity: { enum: ['low', 'mid', 'high'] },
      },
      required: ['is_blocked'],
      additionalProperties: false,
    },

    buildInput(payload) {
      return [
        `[Last assistant message from agent]`,
        payload.assistantText || '(empty)',
      ].join('\n');
    },
  },
};

// -------------------- Core query function --------------------

class SystemAgent {
  /**
   * Run a single SystemAgent query.
   * @returns {Promise<{result, costUsd, durationMs, isError, rawOutput}>}
   */
  async query({ task, payload, maxBudgetUsd = 0.10 }) {
    const def = TASKS[task];
    if (!def) throw new Error(`Unknown SystemAgent task: ${task}`);

    const input = def.buildInput(payload || {});
    const schema = def.schema;
    const systemPrompt = def.systemPrompt;

    // [bug@2026-06-10] 强制 Haiku — 这些结构化微任务用 Opus 浪费 cost(单次 $0.12 太贵)
    //   Haiku 4.5 单次约 $0.001-0.003,延迟 1-2s,准确率对 schema-validated 任务完全够
    const args = [
      '-p', input,
      '--output-format', 'json',
      '--model', 'claude-haiku-4-5',
      '--no-session-persistence',
      '--permission-mode', 'dontAsk',
      '--tools', '',
      '--json-schema', JSON.stringify(schema),
      '--max-budget-usd', String(maxBudgetUsd),
      '--append-system-prompt', systemPrompt,
    ];

    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const child = spawn(config.claudeBin, args, {
        // [bug@2026-06-10] cwd 用 mate 根目录,避免污染 sibling project session pool
        cwd: config.root,
        env: {
          ...process.env,
          HTTP_PROXY: config.httpProxy,
          HTTPS_PROXY: config.httpsProxy,
          NO_PROXY: config.noProxy,
        },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

      child.on('error', (err) => reject(new Error(`SystemAgent spawn error: ${err.message}`)));
      child.on('exit', (code) => {
        const durationMs = Date.now() - t0;
        if (code !== 0) {
          recordEvent('system_agent.error', { task, code, stderr: stderr.slice(0, 500) });
          return reject(new Error(`SystemAgent exit ${code}: ${stderr.slice(0, 300) || stdout.slice(0, 300)}`));
        }
        try {
          const parsed = JSON.parse(stdout);
          // [bug@2026-06-10] claude --json-schema 模式下,schema 化输出在
          //   `structured_output` 字段(不是 `result`)。`result` 在 schema 模式下是
          //   plain text 的辅助说明(常为空字符串)。fallback: 如果 structured_output
          //   缺失,尝试从 result 文本里 JSON.parse 兜底。
          let result = parsed.structured_output;
          if (result === undefined || result === null) {
            const rawResultText = parsed.result;
            if (typeof rawResultText === 'string' && rawResultText.length) {
              try {
                result = JSON.parse(rawResultText);
              } catch {
                result = null;
              }
            }
          }
          const costUsd = parsed.total_cost_usd ?? 0;
          recordEvent('system_agent.query', { task, costUsd, durationMs, isError: parsed.is_error === true });
          resolve({
            result,
            costUsd,
            durationMs,
            isError: parsed.is_error === true,
            rawOutput: parsed,
          });
        } catch (e) {
          recordEvent('system_agent.parse_error', { task, error: e.message, stdoutHead: stdout.slice(0, 300) });
          reject(new Error(`SystemAgent parse error (${task}): ${e.message}; stdout head: ${stdout.slice(0, 300)}`));
        }
      });

      // Safety timeout
      setTimeout(() => {
        if (child.exitCode === null) {
          try { child.kill(); } catch {}
          reject(new Error(`SystemAgent timeout (${task}, 60s)`));
        }
      }, 60000);
    });
  }

  // Convenience wrappers
  async summarizeTitle(firstUserText, firstAssistantText) {
    const r = await this.query({
      task: 'title-summary',
      payload: { firstUserText, firstAssistantText },
    });
    return r.result?.title || null;
  }

  async generateReplyTemplate(assistantText) {
    const r = await this.query({
      task: 'reply-template',
      payload: { assistantText },
    });
    const questions = Array.isArray(r.result?.questions)
      ? r.result.questions.map((q) => q.question).filter(Boolean)
      : [];
    return {
      hasQuestions: !!r.result?.has_questions && questions.length > 0,
      questions,
    };
  }

  async detectBlocked(assistantText) {
    const r = await this.query({
      task: 'blocked-detection',
      payload: { assistantText },
    });
    return {
      isBlocked: !!r.result?.is_blocked,
      question: r.result?.question || '',
      severity: r.result?.severity || 'low',
    };
  }
}

module.exports = new SystemAgent();
