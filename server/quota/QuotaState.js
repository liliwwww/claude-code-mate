// ============================================================================
// MODULE CONTRACT(架构 SSOT:docs/architecture.md §3 §4 §6)
// ----------------------------------------------------------------------------
// 层:L2 Process Control
// 责任:5h / 7d quota 双轨状态机 + 持久化 + setTimer + cron 兜底
// 公共 API:单例 + `start / stop / ingest / isPaused / getPausedTypes /
//   manualOverride / snapshot`
// 允许依赖:db / messageBus
// 禁止:
//   - 直接读 stdin(只接受 ingest 的 payload)
//   - 派工逻辑(只 publish 事件,SpawnManager 监听后决定怎么做)
//   - 业务降级判断(自动 Haiku 等留下轮 phase)
// ============================================================================
//
// [需求@2026-06-12 Phase 2E §6] 全局 quota 状态机
//   5h / 7d 双轨独立,任一进 PAUSED 整个 mate 暂停派工/send
//   两个都 OK 才回正常态
//
// 数据源:claude stream-json 协议主动推送 `rate_limit_event`(已实测,schema:
//   { type: 'rate_limit_event', rate_limit_info: { status, resetsAt, rateLimitType,
//     utilization, overageStatus, isUsingOverage, overageDisabledReason } } )
//
// 状态:
//   allowed                  → 完全正常
//   allowed_warning(util≥0.6 已观察到,<0.95)→ 黄条 warning,**仍允许 send**
//   allowed_warning(util≥0.95)→ 进 PAUSED(§6 95% 预防性触发)
//   rate_limited             → 进 PAUSED(终态,真撞墙)
//   manual_override          → user 点击 banner × 强制脱离 PAUSED
//
// 持久化:每次 update 透写 mate_quota_state 表,mate 重启从表恢复
//   setTimer 重新挂上(resetsAt - now),cron 兜底每 30s 检查
//
// 接入:
//   - QuotaState.ingest(payload) :从 stream-json rate_limit_event 喂入
//   - QuotaState.isPaused() :SpawnManager 检查
//   - QuotaState.manualOverride() :user 点击 banner ×
//   - QuotaState.start() :boot 时调,启动 cron / setTimer
//   - QuotaState.snapshot() :API 返当前状态(给前端 banner / chip 用)
//
// 事件:
//   - bus.publish('system.quota_update', { type, status, utilization, resetsAt })
//     每次 update 发,前端 chip + tab 1 用
//   - bus.publish('system.quota_paused', { type, resetsAt })
//     进 PAUSED 瞬间发,前端 banner 弹
//   - bus.publish('system.quota_resumed', { type, reason })
//     reason='timer_elapsed' | 'manual_override',前端 banner 消 + 触发 flush

const bus = require('../messageBus');
const { db, stmts } = require('../db');

const PAUSE_UTIL_THRESHOLD = 0.95;
const CRON_INTERVAL_MS = 30 * 1000;

class QuotaState {
  constructor() {
    // type -> { status, utilization, resetsAt, updated_at, manual_override, timer }
    this.byType = new Map();
    this._cron = null;
  }

  // boot 时 + restoreFromDisk 之后调
  start() {
    const rows = stmts.qsList.all();
    const now = Date.now();
    for (const r of rows) {
      // 持久化数据恢复
      this.byType.set(r.rate_limit_type, {
        status: r.status,
        utilization: r.utilization,
        resetsAt: r.resets_at,
        updatedAt: r.updated_at,
        manualOverride: !!r.manual_override,
        timer: null,
      });
      // 如果 resets 时刻已过,直接 resume(可能 mate down 期间过了)
      if (r.status === 'rate_limited' || (r.status === 'allowed_warning' && r.utilization >= PAUSE_UTIL_THRESHOLD)) {
        if (now >= r.resets_at) {
          this._performResume(r.rate_limit_type, 'boot_elapsed');
        } else {
          this._scheduleTimer(r.rate_limit_type, r.resets_at - now);
        }
      }
    }
    // cron 兜底
    if (!this._cron) {
      this._cron = setInterval(() => this._cronCheck(), CRON_INTERVAL_MS);
    }
    console.log(`[QuotaState] started with ${rows.length} persisted entries, paused=${this.isPaused()}`);
  }

  stop() {
    if (this._cron) { clearInterval(this._cron); this._cron = null; }
    for (const s of this.byType.values()) {
      if (s.timer) { clearTimeout(s.timer); s.timer = null; }
    }
  }

  // 从 streamParser 透传过来的 rate_limit_event payload(已 JSON.parse 过的 raw object)
  ingest(rawPayload) {
    const info = rawPayload?.rate_limit_info;
    if (!info) return;
    const type = info.rateLimitType;

    // [需求@2026-06-26 边界 case] server-side 临时 throttle 推 {status:'rejected'},
    //   无 rateLimitType / 无 resetsAt。老逻辑 line 103 unknown type 直接 return →
    //   QuotaState 完全不知道发生限流,UI 没 banner,user 收 429 ERROR 全靠手动重发。
    //   修法:借用 byType['five_hour'] 的 resetsAt 当 pause 截止时间(claude 自己内部 throttle
    //   通常跟 5h 配额窗口对齐),没 five_hour 历史时 fallback 5 min 固定 backoff。
    //   走现有 _performPause 路径 → setTimer + cron 兜底 + system.quota_paused 广播 →
    //   到点 _timerFired 自动 resume + 队列 flush。
    if (info.status === 'rejected' && !type) {
      this._ingestServerReject(info);
      return;
    }

    if (type !== 'five_hour' && type !== 'seven_day') {
      console.warn(`[QuotaState] unknown rateLimitType: ${type}`);
      return;
    }
    const resetsAtMs = (info.resetsAt || 0) * 1000;  // 秒 → ms
    const util = info.utilization ?? null;
    const status = info.status || 'allowed';

    const prev = this.byType.get(type);
    const next = {
      status,
      utilization: util,
      resetsAt: resetsAtMs,
      updatedAt: Date.now(),
      manualOverride: false,  // 新 ingest 一定清掉 override
      timer: prev?.timer ?? null,
    };
    this.byType.set(type, next);

    // 持久化
    try {
      stmts.qsUpsert.run({
        rate_limit_type: type,
        status,
        utilization: util,
        resets_at: resetsAtMs,
        updated_at: next.updatedAt,
        manual_override: 0,
      });
    } catch (e) {
      console.warn(`[QuotaState] persist ${type} failed: ${e.message}`);
    }

    // 触发 PAUSED 判断
    const shouldPause = this._shouldPause(next);
    const wasPaused = prev ? this._shouldPause(prev) : false;
    if (shouldPause && !wasPaused) {
      this._performPause(type, resetsAtMs);
    }
    // status 降级也算 resume(rate_limited → allowed)
    if (!shouldPause && wasPaused && !next.manualOverride) {
      this._performResume(type, 'status_downgrade');
    }

    bus.publish('system.quota_update', this._snapshotFor(type));
  }

  // [需求@2026-06-26] server-side reject 边界处理:走 five_hour bucket(借 resetsAt)
  _ingestServerReject(info) {
    const FALLBACK_BACKOFF_MS = 5 * 60 * 1000;  // 5 分钟兜底
    const fiveHour = this.byType.get('five_hour');
    const now = Date.now();
    // 优先用 5h 周期的 resetsAt(claude 通常对齐);已过期或没有 → fallback 5min
    let resetsAtMs = fiveHour?.resetsAt && fiveHour.resetsAt > now
      ? fiveHour.resetsAt
      : now + FALLBACK_BACKOFF_MS;

    const prev = fiveHour;
    const next = {
      status: 'rate_limited',  // 借 5h bucket 标 paused
      utilization: prev?.utilization ?? null,
      resetsAt: resetsAtMs,
      updatedAt: now,
      manualOverride: false,
      timer: prev?.timer ?? null,
    };
    this.byType.set('five_hour', next);
    try {
      stmts.qsUpsert.run({
        rate_limit_type: 'five_hour',
        status: 'rate_limited',
        utilization: next.utilization,
        resets_at: resetsAtMs,
        updated_at: now,
        manual_override: 0,
      });
    } catch (e) {
      console.warn(`[QuotaState] persist server_reject failed: ${e.message}`);
    }

    const wasPaused = prev ? this._shouldPause(prev) : false;
    if (!wasPaused) {
      console.log(`[QuotaState] server-side reject ingested,fall through to five_hour pause until ${new Date(resetsAtMs).toISOString()}`);
      this._performPause('five_hour', resetsAtMs);
    }
    bus.publish('system.quota_update', this._snapshotFor('five_hour'));
  }

  _shouldPause(state) {
    if (state.manualOverride) return false;
    if (state.status === 'rate_limited') return true;
    if (state.status === 'allowed_warning' && (state.utilization ?? 0) >= PAUSE_UTIL_THRESHOLD) return true;
    return false;
  }

  _performPause(type, resetsAtMs) {
    const ms = Math.max(0, resetsAtMs - Date.now());
    this._scheduleTimer(type, ms);
    console.log(`[QuotaState] PAUSED ${type}, resetsAt=${new Date(resetsAtMs).toISOString()} (in ${Math.round(ms/1000)}s)`);
    bus.publish('system.quota_paused', { type, resetsAt: resetsAtMs });
  }

  _performResume(type, reason) {
    const cur = this.byType.get(type);
    if (cur?.timer) { clearTimeout(cur.timer); cur.timer = null; }
    console.log(`[QuotaState] RESUMED ${type} (reason=${reason})`);
    bus.publish('system.quota_resumed', { type, reason });
  }

  _scheduleTimer(type, ms) {
    const cur = this.byType.get(type);
    if (!cur) return;
    if (cur.timer) clearTimeout(cur.timer);
    cur.timer = setTimeout(() => this._timerFired(type), ms);
  }

  _timerFired(type) {
    console.log(`[QuotaState] timer fired for ${type}`);
    const cur = this.byType.get(type);
    if (!cur) return;
    // resets 到了 → 但状态字段还没收到新 rate_limit_event 告诉我们已 reset
    // 直接乐观降级为 allowed,等下次 user send 时 claude 推新事件再修正
    cur.status = 'allowed';
    cur.utilization = null;
    cur.manualOverride = false;
    try {
      stmts.qsUpsert.run({
        rate_limit_type: type,
        status: 'allowed',
        utilization: null,
        resets_at: cur.resetsAt,
        updated_at: Date.now(),
        manual_override: 0,
      });
    } catch {}
    this._performResume(type, 'timer_elapsed');
  }

  _cronCheck() {
    const now = Date.now();
    for (const [type, state] of this.byType) {
      if (this._shouldPause(state) && now >= state.resetsAt) {
        // setTimer 应该 fire 了但没 — 兜底
        this._timerFired(type);
      }
    }
  }

  // user 点击 banner × 手动 abort
  manualOverride(type = null) {
    const types = type ? [type] : ['five_hour', 'seven_day'];
    for (const t of types) {
      const cur = this.byType.get(t);
      if (!cur) continue;
      if (!this._shouldPause(cur)) continue;
      cur.manualOverride = true;
      if (cur.timer) { clearTimeout(cur.timer); cur.timer = null; }
      try {
        stmts.qsUpsert.run({
          rate_limit_type: t,
          status: cur.status,
          utilization: cur.utilization,
          resets_at: cur.resetsAt,
          updated_at: Date.now(),
          manual_override: 1,
        });
      } catch {}
      this._performResume(t, 'manual_override');
      // events 表记审计
      try {
        const { recordEvent } = require('../db');
        recordEvent('system.quota_manual_override', { type: t, resetsAt: cur.resetsAt });
      } catch {}
    }
  }

  // 任一 type PAUSED → 整个 mate paused
  isPaused() {
    for (const state of this.byType.values()) {
      if (this._shouldPause(state)) return true;
    }
    return false;
  }

  getPausedTypes() {
    const list = [];
    for (const [type, state] of this.byType) {
      if (this._shouldPause(state)) list.push({ type, resetsAt: state.resetsAt, status: state.status, utilization: state.utilization });
    }
    return list;
  }

  // API / WS payload
  snapshot() {
    return {
      paused: this.isPaused(),
      five_hour: this._snapshotFor('five_hour'),
      seven_day: this._snapshotFor('seven_day'),
    };
  }

  _snapshotFor(type) {
    const s = this.byType.get(type);
    if (!s) return null;
    return {
      type,
      status: s.status,
      utilization: s.utilization,
      resetsAt: s.resetsAt,
      updatedAt: s.updatedAt,
      manualOverride: s.manualOverride,
      paused: this._shouldPause(s),
    };
  }
}

module.exports = new QuotaState();
