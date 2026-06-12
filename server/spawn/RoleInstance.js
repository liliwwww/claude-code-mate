// One live claude child process bound to a RoleDefinition.
// Owns: spawn argv construction, stdin write, stdout/stderr parsing, lifecycle events.
//
// Status state machine:
//   spawning      -> idle    (system/init seen)
//   idle          -> busy    (user msg sent, awaiting result)
//   busy          -> idle    (result event received)
//   any           -> dead    (process exited)
//   disconnected  -> spawning (lazy resurrection — sendUserText triggers spawn+resume)
//
// [需求@2026-06-10] lazy resurrection — user 反馈"程序重启不应导致数据/状态丢失"。
//   重启后 SQLite 里活着的实例被重新水化为 disconnected RoleInstance(无 child process),
//   sendUserText 触发自动 spawn + --resume <session_id> --fork-session 续上对话。
//
// [需求@2026-06-10] 角色定义对用户透明 — user 拍定 Q2:角色 body 通过 --append-system-prompt
//   注入,sibling project 不需要装 .claude/commands/<role>.md,mate 全套接管。

const { spawn, execSync } = require('node:child_process');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const { StreamParser } = require('./streamParser');

function buildUserMessage(text) {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

function buildSpawnArgs({ role, sessionId, resumeSessionId, forkSession, cwd }) {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--replay-user-messages',
    '--include-hook-events',
    '--permission-mode', role.permissionMode,
  ];
  if (role.allowedTools.length) {
    args.push('--tools', role.allowedTools.join(' '));
  }
  if (role.allowRules.length) {
    args.push('--settings', JSON.stringify({
      permissions: { allow: role.allowRules },
    }));
  }
  if (resumeSessionId) {
    args.push('--resume', resumeSessionId);
    if (forkSession) args.push('--fork-session');
  } else if (sessionId) {
    args.push('--session-id', sessionId);
  }
  if (cwd) {
    args.push('--add-dir', cwd);
  }
  // Append role body as system prompt (skill_command-based discovery happens via
  // first stdin message). Always append the body for safety in case slash commands
  // are disabled by user settings.
  if (role.body) {
    args.push('--append-system-prompt', role.body);
  }
  return args;
}

class RoleInstance {
  constructor({ role, projectId, projectRootDir, threadSlug = null, customGreeting = null, poolSlot = null, restoreState = null }) {
    // [需求@2026-06-10] 每个实例归属一个 project (user Q3/Q4),
    // cwd 用 project.root_dir,不再用全局 config.siblingProjectDir。
    // [需求@2026-06-12 §8.3] poolSlot: 1..N for pooled roles (H/execB/testC/mateBot),
    //   null for per-thread R. Stable across restarts.
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
      if (!projectId) throw new Error('RoleInstance requires projectId');
      if (!projectRootDir) throw new Error('RoleInstance requires projectRootDir');
      this.id = `${role.name}.${Math.random().toString(36).slice(2, 8)}`;
      this.role = role;
      this.projectId = projectId;
      this.projectRootDir = projectRootDir;
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
    this._listeners = new Map(); // event -> Set<handler>
    this._customGreeting = customGreeting;
    this._spawnArgs = null;
    this._child = null;
    this._parser = null;
  }

  on(event, handler) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(handler);
    return () => this._listeners.get(event)?.delete(handler);
  }

  _emit(event, payload) {
    const handlers = this._listeners.get(event);
    if (!handlers) return;
    for (const h of handlers) {
      try { h(payload); } catch (e) { console.error(`[RoleInstance ${this.id}] listener error on ${event}:`, e); }
    }
  }

  _setStatus(newStatus) {
    if (this.status === newStatus) return;
    const old = this.status;
    this.status = newStatus;
    this.lastActiveAt = Date.now();
    this._emit('status_change', { from: old, to: newStatus });
  }

  spawn({ resumeSessionId = null, suppressGreeting = false } = {}) {
    // If resuming, don't preallocate session-id (resume uses the saved one).
    // [需求@2026-06-10] cwd 取自 projectRootDir(per-project),不再用全局配置
    const cwd = this.projectRootDir;
    this._spawnArgs = buildSpawnArgs({
      role: this.role,
      sessionId: resumeSessionId ? null : uuidv4(),
      resumeSessionId,
      forkSession: !!resumeSessionId,
      cwd,
    });
    this._setStatus('spawning');

    const env = {
      ...process.env,
      HTTP_PROXY: config.httpProxy,
      HTTPS_PROXY: config.httpsProxy,
      NO_PROXY: config.noProxy,
    };

    this._child = spawn(config.claudeBin, this._spawnArgs, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (!this._child.pid) {
      // spawn failed synchronously
      this._setStatus('dead');
      this.diedAt = Date.now();
      this._emit('exited', { error: 'spawn returned no pid' });
      return this;
    }
    this.pid = this._child.pid;

    // CRITICAL (findings §2): write first stdin SYNCHRONOUSLY. Don't wait for init.
    // Role identity already loaded via --append-system-prompt; greeting is just to
    // avoid claude's 3s no-stdin auto-exit. For lazy resurrection, suppressGreeting
    // is true and the pendingUserText (queued by sendUserText) will be flushed instead.
    if (!suppressGreeting) {
      const greetingText =
        this._customGreeting ||
        `You are now active. Reply with just "ready" to confirm initialization.`;
      try {
        this._child.stdin.write(JSON.stringify(buildUserMessage(greetingText)) + '\n');
      } catch (e) {
        console.error(`[RoleInstance ${this.id}] greeting write failed:`, e);
      }
    } else if (this._pendingUserText) {
      // Lazy resurrection path: flush the queued user message as first stdin
      try {
        this._child.stdin.write(JSON.stringify(buildUserMessage(this._pendingUserText)) + '\n');
        this._pendingUserText = null;
      } catch (e) {
        console.error(`[RoleInstance ${this.id}] pending stdin write failed:`, e);
      }
    }

    this._parser = new StreamParser({
      onEvent: ({ eventType, raw }) => this._handleEvent(eventType, raw),
      onParseError: (line, err) => {
        console.warn(`[RoleInstance ${this.id}] parse error: ${err.message}; line head: ${line.slice(0, 200)}`);
      },
      onLineOverflow: (size) => {
        console.warn(`[RoleInstance ${this.id}] dropped oversized line buffer: ${size} bytes`);
      },
    });

    this._child.stdout.on('data', (chunk) => this._parser.feed(chunk));
    this._child.stderr.on('data', (chunk) => {
      const s = chunk.toString('utf8');
      this._emit('stderr', s);
    });

    this._child.on('error', (err) => {
      console.error(`[RoleInstance ${this.id}] spawn error:`, err);
      this._setStatus('dead');
      this.diedAt = Date.now();
      this._emit('exited', { error: err.message });
    });

    this._child.on('exit', (code, signal) => {
      this.exitCode = code;
      this.exitSignal = signal;
      this.diedAt = Date.now();
      this._setStatus('dead');
      this._emit('exited', { code, signal });
    });

    return this;
  }

  _handleEvent(eventType, raw) {
    if (eventType === 'system/init') {
      // session_id is reported here — overrides the preallocated one
      this.sessionId = raw.session_id;
      this._setStatus('idle');
    } else if (eventType === 'user') {
      // stdin echo — confirms our message was consumed (we go busy)
      this._setStatus('busy');
    } else if (eventType === 'result') {
      // terminal of this turn — back to idle (or surface error)
      const isErr = raw.is_error === true;
      this._emit(isErr ? 'turn_error' : 'turn_done', raw);
      this._setStatus('idle');
    }
    // Always forward the parsed event
    this._emit('event', { eventType, raw });
    this.lastActiveAt = Date.now();
  }

  sendUserText(text) {
    if (this.status === 'dead') {
      throw new Error(`Cannot send to dead instance ${this.id}`);
    }
    // Lazy resurrection: if disconnected, queue the message and spawn now.
    if (this.status === 'disconnected') {
      if (!this.sessionId) {
        throw new Error(`Cannot resume ${this.id}: no saved session_id`);
      }
      this._pendingUserText = text;
      this.spawn({ resumeSessionId: this.sessionId, suppressGreeting: true });
      this._setStatus('busy');
      return;
    }
    if (!this._child) {
      throw new Error(`Cannot send: instance ${this.id} has no child process`);
    }
    const line = JSON.stringify(buildUserMessage(text)) + '\n';
    this._child.stdin.write(line);
    this._setStatus('busy');
  }

  async kill() {
    if (this.status === 'dead' || !this._child) return 'already-dead';
    const child = this._child;
    const pid = this.pid;

    // L1: stdin.end
    try { child.stdin.end(); } catch {}
    if (await this._waitExit(child, 2000)) return 'L1';

    // L2: SIGTERM
    try { child.kill('SIGTERM'); } catch {}
    if (await this._waitExit(child, 2000)) return 'L2';

    // L3: taskkill /F /T
    try { execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'pipe' }); } catch (e) {
      console.warn(`[RoleInstance ${this.id}] taskkill failed: ${e.message}`);
    }
    if (await this._waitExit(child, 2000)) return 'L3';

    console.error(`[RoleInstance ${this.id}] kill escalation exhausted, marking orphan`);
    this._setStatus('dead');
    this.diedAt = Date.now();
    return 'orphan';
  }

  _waitExit(child, ms) {
    return new Promise((resolve) => {
      if (child.exitCode !== null || this.status === 'dead') return resolve(true);
      let timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, ms);
      const onExit = () => { cleanup(); resolve(true); };
      const cleanup = () => {
        clearTimeout(timer);
        child.off('exit', onExit);
      };
      child.on('exit', onExit);
    });
  }

  // [需求@2026-06-12 §8.3] displayName 给 UI 用:
  //   pooled 角色:`execB-2`(稳定,跨重启)
  //   per-thread R:`planA-R.xy3z2k`(原 id)
  get displayName() {
    if (this.poolSlot != null) return `${this.role.name}-${this.poolSlot}`;
    return this.id;
  }

  snapshot() {
    return {
      id: this.id,
      projectId: this.projectId,
      roleName: this.role.name,
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
    };
  }
}

module.exports = { RoleInstance, buildUserMessage };
