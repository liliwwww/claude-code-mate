// ============================================================================
// MODULE CONTRACT(RFC: docs/discussions/2026-06-16-stack-model-rfc.md E2E)
// ----------------------------------------------------------------------------
// 层:L2 Process Control(test 替身)
// 责任:同 RoleInstance 接口,但**不真起 claude 子进程**,按预设脚本产事件。
//   用于 E2E 测试 / mock 系统流程。
//
// 公共 API(跟 RoleInstance 对齐):
//   - constructor({ role, projectId, projectRootDir, threadSlug, poolSlot, ... })
//   - on(event, handler) / _emit
//   - spawn({ resumeSessionId, suppressGreeting }) — 不真 spawn,合成 system/init
//   - sendUserText(text) — 按脚本 emit user → assistant → result
//   - switchModel / resetSession / kill — stub 立刻 resolve
//   - displayName / snapshot — 一样
//
// 跟真实 RoleInstance 区别:
//   - this.pid 始终是个假数(避开 0,让 dashboard 看不出来)
//   - sessionId 用 mock-<roleId> 格式
//   - 没有真 stream parser 链路,_handleEvent 复用真实逻辑(直接 require 同源)
//
// 注入脚本 API:
//   - setResponseScript(scripts: Array<{ match: RegExp|string, emit: Event[] }>)
//   - clearScript()
//
// 公共全局:
//   - MockRoleInstance.scriptRegistry — Map<roleName, scripts>
//     test fixture 通过 registry 一次性配好所有角色,新 spawn 实例从 registry 拷贝。
//
// [需求@2026-06-17 E2E] Phase 3 切 SSOT 前的保护网。
// ============================================================================

// 用 crypto.randomUUID(node 内置)替代 uuid 依赖
const { randomUUID } = require('node:crypto');
const uuidv4 = () => randomUUID();

// 默认脚本:任何输入都简单 ack + emit result(无 marker → mate 不会触发 dispatch)
const DEFAULT_SCRIPTS = {
  'mate-R': [
    {
      match: /.*/,
      emit: [
        { type: 'assistant', text: 'ready (mock R)' },
        { type: 'result_success' },
      ],
    },
  ],
  'mate-H': [
    {
      match: /.*/,
      emit: [
        { type: 'assistant', text: 'ready (mock H)' },
        { type: 'result_success' },
      ],
    },
  ],
  'mate-B': [
    {
      match: /.*/,
      emit: [
        { type: 'assistant', text: 'ready (mock B)' },
        { type: 'result_success' },
      ],
    },
  ],
  'mate-C': [
    {
      match: /.*/,
      emit: [
        { type: 'assistant', text: 'ready (mock C)' },
        { type: 'result_success' },
      ],
    },
  ],
};

// 全局脚本 registry — 测试 fixture 注入,新 spawn 实例 attached
const scriptRegistry = new Map();
for (const [roleName, scripts] of Object.entries(DEFAULT_SCRIPTS)) {
  scriptRegistry.set(roleName, scripts);
}

class MockRoleInstance {
  constructor({ role, projectId, projectRootDir, threadSlug = null, customGreeting = null, poolSlot = null, restoreState = null }) {
    if (restoreState) {
      this.id = restoreState.id;
      this.role = role;
      this.projectId = restoreState.projectId;
      this.projectRootDir = restoreState.projectRootDir;
      this.threadSlug = restoreState.threadSlug || null;
      this.poolSlot = restoreState.poolSlot ?? null;
      this.status = 'disconnected';
      this.pid = null;
      this.sessionId = restoreState.sessionId || null;
      this.createdAt = restoreState.createdAt || Date.now();
      this.lastActiveAt = restoreState.lastActiveAt || Date.now();
      this.diedAt = null;
    } else {
      if (!projectId) throw new Error('MockRoleInstance requires projectId');
      this.id = `${role.name}.m${Math.random().toString(36).slice(2, 8)}`;
      this.role = role;
      this.projectId = projectId;
      this.projectRootDir = projectRootDir || '/mock';
      this.threadSlug = threadSlug;
      this.poolSlot = poolSlot;
      this.status = 'spawning';
      this.pid = null;
      this.sessionId = null;
      this.createdAt = Date.now();
      this.lastActiveAt = Date.now();
      this.diedAt = null;
    }
    this.exitCode = null;
    this.exitSignal = null;
    this.sessionStats = { turns: 0, inputTokens: 0, outputTokens: 0, totalCostUsd: 0 };
    this.currentModel = 'mock-model';
    this.claudeCodeVersion = 'mock-1.0';
    this.currentTaskSlug = null;
    this.preferredModel = null;
    this._softKillForRestart = false;
    this._listeners = new Map();
    this._customGreeting = customGreeting;
    this._mockAlive = false;
    this._sentCounter = 0;
    // per-instance script override(otherwise fall back to registry)
    this._scriptOverride = null;
  }

  // 同 RoleInstance.on
  on(event, handler) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(handler);
    return () => this._listeners.get(event)?.delete(handler);
  }

  _emit(event, payload) {
    const handlers = this._listeners.get(event);
    if (!handlers) return;
    for (const h of handlers) {
      try { h(payload); } catch (e) { console.error(`[MockRoleInstance ${this.id}] listener error on ${event}:`, e); }
    }
  }

  _setStatus(newStatus) {
    if (this.status === newStatus) return;
    const old = this.status;
    this.status = newStatus;
    this.lastActiveAt = Date.now();
    this._emit('status_change', { from: old, to: newStatus });
  }

  // 同 RoleInstance.spawn — 合成 init,不开真子进程
  spawn({ resumeSessionId = null, suppressGreeting = false } = {}) {
    this._setStatus('spawning');
    this._mockAlive = true;
    this.pid = 100000 + Math.floor(Math.random() * 10000); // fake pid

    if (resumeSessionId) {
      this.sessionId = resumeSessionId;
    } else if (!this.sessionId) {
      this.sessionId = `mock-${this.id}`;
    }

    // 同步 emit system/init(模拟 claude 启动初始化)
    setImmediate(() => {
      const initEvent = {
        type: 'system',
        subtype: 'init',
        session_id: this.sessionId,
        model: this.currentModel,
        claude_code_version: this.claudeCodeVersion,
      };
      this._emit('event', { eventType: 'system/init', raw: initEvent });
      this._setStatus('idle');

      // 处理 greeting / pending msg
      if (!suppressGreeting) {
        const greeting = this._customGreeting || 'ready confirmation';
        this._processMockInput(greeting);
      } else if (this._pendingUserText) {
        const text = this._pendingUserText;
        this._pendingUserText = null;
        this._processMockInput(text);
      }
    });

    return this;
  }

  sendUserText(text) {
    if (this.status === 'dead') {
      throw new Error(`Cannot send to dead mock instance ${this.id}`);
    }
    if (this.status === 'disconnected') {
      // lazy resurrection — 重新 spawn
      this._pendingUserText = text;
      this.spawn({ suppressGreeting: true, resumeSessionId: this.sessionId });
      this._setStatus('busy');
      return;
    }
    this._processMockInput(text);
  }

  // 核心:按脚本回响 events
  _processMockInput(text) {
    this._setStatus('busy');
    this._sentCounter++;

    // 1. echo user event
    setImmediate(() => {
      const userEvent = {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
        session_id: this.sessionId,
        uuid: uuidv4(),
        timestamp: new Date().toISOString(),
      };
      this._emit('event', { eventType: 'user', raw: userEvent });
    });

    // 2. lookup script (per-instance override > registry default)
    const scripts = this._scriptOverride || scriptRegistry.get(this.role.name) || [];
    const matched = scripts.find((s) => _matchTest(s.match, text));
    const events = matched?.emit || [
      { type: 'assistant', text: `(mock ${this.role.name} default)` },
      { type: 'result_success' },
    ];

    // 3. emit each scripted event with slight async delays
    //   累积 assistant text(含 marker) — 给 result 事件的 result 字段用
    //   (MarkerDetector 从 result.result 抽取 marker,不是 assistant content)
    this._turnAssistantBuffer = '';
    let delay = 5;
    for (const ev of events) {
      setTimeout(() => this._emitMockEvent(ev), delay);
      delay += 5;
    }
    // 4. 最后 set idle 由 result event 触发(同 RoleInstance _handleEvent)
  }

  _emitMockEvent(ev) {
    if (ev.type === 'assistant') {
      const text = typeof ev.text === 'string' ? ev.text : '';
      const marker = ev.marker || null;
      const fullText = marker ? `${text}\n${marker}` : text;
      // 累积到 turn buffer(给 result event 用)
      this._turnAssistantBuffer = (this._turnAssistantBuffer || '') + (this._turnAssistantBuffer ? '\n' : '') + fullText;
      const assistantEvent = {
        type: 'assistant',
        message: {
          model: this.currentModel,
          id: `msg_${uuidv4().slice(0, 24)}`,
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: fullText }],
          stop_reason: 'end_turn',
        },
        session_id: this.sessionId,
        timestamp: new Date().toISOString(),
      };
      this._emit('event', { eventType: 'assistant', raw: assistantEvent });
    } else if (ev.type === 'tool_use') {
      const event = {
        type: 'assistant',
        message: {
          model: this.currentModel,
          id: `msg_${uuidv4().slice(0, 24)}`,
          type: 'message',
          role: 'assistant',
          content: [{ type: 'tool_use', name: ev.tool || 'Bash', input: ev.input || {} }],
        },
        session_id: this.sessionId,
      };
      this._emit('event', { eventType: 'assistant', raw: event });
    } else if (ev.type === 'tool_result') {
      const event = {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: ev.tool_use_id || 'tu_mock', content: ev.content || 'ok' }],
        },
        session_id: this.sessionId,
      };
      this._emit('event', { eventType: 'user', raw: event });
    } else if (ev.type === 'result_success') {
      this.sessionStats.turns += 1;
      const resultEvent = {
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 100,
        total_cost_usd: 0.001,
        session_id: this.sessionId,
        usage: { input_tokens: 10, output_tokens: 20 },
        // [需求@2026-06-17 E2E] mate MarkerDetector 从 raw.result 抽 marker —
        //   把 turn 累积的 assistant text(含 marker)一并放进去
        result: this._turnAssistantBuffer || '',
      };
      this._turnAssistantBuffer = '';
      this._emit('event', { eventType: 'result/success', raw: resultEvent });
      this._emit('turn_done', resultEvent);
      this._setStatus('idle');
    } else if (ev.type === 'result_error') {
      this.sessionStats.turns += 1;
      const resultEvent = {
        type: 'result',
        subtype: 'error',
        is_error: true,
        duration_ms: 50,
        error: ev.error || 'mock error',
        session_id: this.sessionId,
      };
      this._emit('event', { eventType: 'result/error', raw: resultEvent });
      this._emit('turn_error', resultEvent);
      this._setStatus('idle');
    } else {
      console.warn(`[MockRoleInstance ${this.id}] unknown script ev type: ${ev.type}`);
    }
  }

  // stubs for production methods
  async switchModel(newModel) {
    this.currentModel = newModel;
    this.preferredModel = newModel;
    this._setStatus('disconnected');
    this.sessionId = null;
    return { ok: true, mock: true };
  }

  async resetSession() {
    this.sessionId = null;
    this.sessionStats = { turns: 0, inputTokens: 0, outputTokens: 0, totalCostUsd: 0 };
    this._setStatus('disconnected');
    return { ok: true, mock: true };
  }

  async kill() {
    if (!this._mockAlive) return { code: 0, level: 'never-alive' };
    this._mockAlive = false;
    this.exitCode = 0;
    this.diedAt = Date.now();
    if (this._softKillForRestart) {
      this._softKillForRestart = false;
      this.sessionId = null;
      this._setStatus('disconnected');
      this.pid = null;
      this._emit('exited', { code: 0, signal: null, softRestart: true });
    } else {
      this._setStatus('dead');
      this._emit('exited', { code: 0, signal: null });
    }
    return { code: 0, level: 'stdin_end' };
  }

  get displayName() {
    if (this.poolSlot != null) return `${this.role.name}-${this.poolSlot}`;
    return this.id;
  }

  snapshot() {
    return {
      id: this.id,
      projectId: this.projectId,
      roleName: this.role.name,
      roleType: this.role.type,
      poolSlot: this.poolSlot,
      displayName: this.displayName,
      pid: this.pid,
      sessionId: this.sessionId,
      status: this.status,
      threadSlug: this.threadSlug,
      createdAt: this.createdAt,
      lastActiveAt: this.lastActiveAt,
      diedAt: this.diedAt,
      exitCode: this.exitCode,
      displayColor: this.role.displayColor,
      currentTaskSlug: this.currentTaskSlug || null,
      currentModel: this.currentModel,
      sessionStats: { ...this.sessionStats },
      preferredModel: this.preferredModel,
      roleDefaultModel: this.role.model || null,
      claudeCodeVersion: this.claudeCodeVersion,
      _mock: true,
    };
  }

  // 测试注入接口 — per-instance 脚本
  setResponseScript(scripts) {
    this._scriptOverride = scripts;
  }

  clearScript() {
    this._scriptOverride = null;
  }
}

// 全局工具
function setRegistryScript(roleName, scripts) {
  scriptRegistry.set(roleName, scripts);
}

function resetRegistry() {
  scriptRegistry.clear();
  for (const [roleName, scripts] of Object.entries(DEFAULT_SCRIPTS)) {
    scriptRegistry.set(roleName, scripts);
  }
}

function getRegistry() {
  const out = {};
  for (const [k, v] of scriptRegistry) out[k] = v;
  return out;
}

function _matchTest(matcher, text) {
  if (matcher instanceof RegExp) return matcher.test(text);
  if (typeof matcher === 'string') return text.includes(matcher);
  if (typeof matcher === 'function') return !!matcher(text);
  return false;
}

module.exports = {
  MockRoleInstance,
  scriptRegistry,
  setRegistryScript,
  resetRegistry,
  getRegistry,
};
