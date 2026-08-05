# Mate 优化建议 Backlog

**创建**:2026-07-30
**来源**:`docs/设计状态更新20260730.md` 架构评审
**用法**:有时间就挑一项做,做完在 status 打勾

---

## 稳定性核心风险(按危害排序)

### 🚨 #1 (架构级) `inst.threadSlug` mutable — race 靶心

**status**: ⬜ pending

**为什么危险**:
- 4 次修 chain 走串(#187/#188/#191/#194)都是绕这个字段的时序,没根治
- 每次以为修好,下一个 race 场景又暴露

**证据**:
- #187 补翻 → #188 暴露"flush 抢跑 markers"
- #188 修 setImmediate 顺序 → #191 暴露"status_change 也 flush"
- #191 屏蔽 status_change flush → #194 暴露"直发 turn 不 flush"

**根治方案(蓝图)**:

```javascript
// 目标:让 inst.threadSlug 不再是 mutable 字段
class RoleInstance {
  // 移除:this.threadSlug
  // 加:
  this._activeContext = null;  // { threadSlug, projectId, pendingSendId } | null

  // 送 stdin 前 pin context;result event 后清
  beginTurn(context) {
    if (this._activeContext) throw new Error('turn already in progress');
    this._activeContext = Object.freeze(context);  // frozen,任何路径都改不了
  }
  endTurn() { this._activeContext = null; }

  get currentTurnThreadSlug() { return this._activeContext?.threadSlug; }
}

// 所有 recordMessage / marker 处理 / 派工链路都读 inst.currentTurnThreadSlug
```

**风险**:改这个是伤筋动骨,需要重写 SpawnManager 大部分。但这是唯一能根治的路。

**预估工作量**:2-3 天

---

### 🚨 #2 (工程级) SpawnManager god class

**status**: ⬜ pending

**证据**:1365 行,9 个职责(注释里都承认了)。每次修一处影响其它:
- #191 修 chain 走串 → #194 破坏 queue flush
- 我修 #187 时没预见 #188 的 setImmediate race,因为要看的 code 太多

**根治方案**:拆(渐进,一次一个模块):

```
SpawnManager (god)          →

                            → InstanceRegistry(instances Map + persist)
                            → TurnLifecycle(status transitions + turn context)
                            → DispatchGateway(sendToThread + sendDirect,只做路由)
                            → EventRouter(claude stream → 派发 marker/hooks/quota)
                            → QueueOrchestrator(flush 触发时机)
                            → PoolAllocator(已抽出 ✅)
                            → HandoffTracker(已抽出 ✅)
                            → ScanRecycler(已抽出 ✅)
```

**风险**:大改工作量大。至少先抽 TurnLifecycle(结合 #1),因为它跟根因 #1 强相关。

**预估工作量**:每个模块 1-2 天,全部拆完约 1-2 周

---

### 🚨 #3 (测试级) 无并发 E2E 测试

**status**: ⬜ pending(X5 是最小起步)

**证据**:所有 4 次 chain 走串都是用户在生产撞出来的。

**建议**:创建 `tests/e2e/dispatch_race.test.js` — 用现有 `MockRoleInstance`,模拟场景:

```javascript
// Scenario 1: 两条线索并行,H 在跑 A 时收到 B 的派工
it('chain 不走串:H 在处理 thread A 时,thread B 的 handoff 应记录到 B 的 chain', async () => {
  // ...
});

// Scenario 2: quota resume 期间 flush 冲突
// Scenario 3: session-lost 触发时 R 也在派工
// Scenario 4: mid-turn 429 时 pending queue 有其它项
```

**收益**:未来任何 race 修改必须过这些测试才能合并,不会再回归。

**预估工作量**:每个 scenario 1-2 小时,先起 1 个奠基础

---

## 可立即做的加固(不动核心,做防御 + 观测)

### 加固 X1:一致性检查 cron ⭐️

**status**: 🚧 **本周启动**

**收益**:15 分钟能写完,每次 race 发生 5 分钟内就有告警,顺便自愈。

**实现位置**:`server/spawn/ConsistencyCheck.js`(新建)

**Check 项**:

1. **orphan_pending** — pending_sends target 指向不存在的 instance
2. **stack_drift** — DB stack != replayChain(chain)
3. **stuck_queue** — pending_sends 排队 > 1h 未派发
4. **stuck_busy** — instance status='busy' 但 last_active > 15min
5. **chain_crossings** — 复用 /api/chain-crossings 逻辑,扫最近 24h

**告警**:
- `recordEvent('system.consistency_alert', ...)` 落 events 表
- `bus.publish('system.consistency_alert', ...)` WS 广播
- 顶栏红条自动显示
- 自愈:stack_drift 直接 `TCS.save(replayChain 派生的)` 修

**运行频率**:每 5 分钟

**预估工作量**:半天(含 UI 告警条)

---

### 加固 X2:关键 mutation 审计

**status**: ✅ **done** (2026-08-04, #200)

`server/spawn/RoleInstance.js` 加 setter,记录所有 `threadSlug` 变化到 events 表:

```javascript
set threadSlug(newVal) {
  if (this._threadSlug !== newVal) {
    try {
      recordEvent('debug.instance_threadslug_flip', {
        from: this._threadSlug,
        to: newVal,
        stack: new Error().stack.split('\n').slice(1, 6).join('\n'),
      }, {instanceId: this.id});
    } catch {}
  }
  this._threadSlug = newVal;
}
get threadSlug() { return this._threadSlug; }
```

**收益**:下次 chain 走串,查 events 表就能看到谁翻了 threadSlug、什么时候翻的、调用栈。目前只能靠推理猜测。

**预估工作量**:半天

---

### 加固 X3:结构化 warning

**status**: ⬜ pending

引入轻量 logger(pino 或自写 30 行),替换 `console.warn`:

```javascript
const log = require('./logger');
log.warn({module:'SpawnManager', event:'queue_flush_failed', pendingSendId:next.id, error:e.message});
```

**收益**:生产可以 grep 类型统计 bug 频率。

**预估工作量**:1 天(改所有现有 console.warn)

---

### 加固 X4:pending_sends 死循环兜底

**status**: ⬜ pending

排队超过 24h 自动 cancel + 通知:

```javascript
// 加入 cron
const stuckPending = db.prepare(`
  SELECT id FROM mate_pending_sends
  WHERE status='queued' AND enqueued_at < ?
`).all(Date.now() - 24*60*60*1000);
for (const p of stuckPending) {
  PendingSends.markCancelled(p.id, 'auto-cancel: stuck > 24h');
  bus.publish('queue.auto_cancelled', {pendingSendId: p.id, reason: 'stuck_24h'});
}
```

**收益**:如果下次改代码引入新的 flush miss,不会像 ps=26 那样 stuck 15 小时才被发现。

**预估工作量**:30 分钟(可以合到 X1 的 cron 里)

---

### 加固 X5:并发单测最小起步

**status**: ⬜ pending

至少写 1 个:"两线索并行不走串"。基于 mock,内存跑,10 秒能过。

以后每次改 SpawnManager 的 async 路径必须过。**规则:改代码之前先扩测试**。

**预估工作量**:1 天

---

## UI/UX 加固

### 加固 UI1:排队面板加"手动 flush 此项"按钮

**status**: ⬜ pending

今天 ps=26 stuck 15h,只能等 mate 内部逻辑触发。加个"立即派发"按钮,直接调 dispatchCb(不等 idle 事件)。

**预估工作量**:半天

---

### 加固 UI2:Chain 走串历史迁移工具

**status**: ⬜ pending

t-mrwwnh63-8g3f 上还有 6 段老走串脏数据,视觉上误导 R 判断。

加 SQL 工具:识别走串 seg → 生成迁移计划(用户手动 confirm 后执行 SQL move)。保留原 seg 添加 `deleted: true` 标记,或直接删。

**预估工作量**:1 天

---

### 加固 UI3:Session-lost 恢复的 diff 报告

**status**: ⬜ pending

目前 `_handleSessionLost` 直接删死实例、重派,用户没感知。

建议:UI ticker 一条明显提示 "🔄 <name> session lost,已重派 pending" + 展开可看差异。

**预估工作量**:半天

---

### 加固 UI4:mate-R 权限精细化

**status**: ⬜ pending

`allow_rules: [Bash]` 裸声明覆盖不到 curl 这种敏感子命令(见早期"R 想 curl mate API 被拒"事件)。

建议:显式列 `Bash(curl:*)`, `Bash(grep:*)` 等,不用裸 `Bash`。

**预估工作量**:1 小时(改 4 个 roles/*.md)

---

### 加固 UI5:附件上传的进度条

**status**: ⬜ pending

#184 支持了附件,但 2MB 图片上传时前端没反馈。加进度指示。

**预估工作量**:半天

---

### 加固 UI6:Dashboard "Chain 自检" 滚动扫描历史统计

**status**: ⬜ pending

目前只查一次 = 一个静态数字。加个 24h 滚动图,让"最近 chain 走串数"变时间序列可看趋势。走串 = 0 应该是常态,涨了就是回归。

**预估工作量**:1 天

---

### 加固 UI7:前端 UI 状态一致性问诊工具

**status**: ⬜ pending

今天现场加的 `📊 诊断` 按钮(在 Graph tab)一击命中 SVG 渲染 bug。类似诊断按钮该扩散到:
- 线索面板
- 队列面板
- chip

**统一每个复杂视图加"诊断此视图"入口,输出机器可 copy 的 markdown**。

**预估工作量**:1-2 天

---

## 长远重构(不急)

### D1:派工引擎抽象化

**status**: ⬜ backlog

现在 marker 语义硬编码在 MarkerDispatcher(handoff/done/blocked/reject/bounce)。

长期:加"派工计划树"数据结构,让 R 可以 emit 完整计划而非单跳 marker(RFC 里提过 `<mate:plan>` 但未实现)。

---

### D2:mate 消息给 LLM 的 prompt 层测试

**status**: ⬜ backlog

#175 死循环 bug 就是 mate 给 R 的系统消息末尾"if 满意 emit done" 被 LLM 误读。

建议:mate 给 LLM 的伪 user message 应该视为 prompt engineering,单独测试语义健壮性(至少手工 review checklist)。

---

### D3:inst.threadSlug 命名清晰化

**status**: ⬜ backlog (归入 #1 重构)

当前含糊:是"当前正在跑哪个线索"还是"绑定的线索"?对 R(per-thread)和 H(pooled)语义不同。

建议:R 用 `.boundThread`,pool 用 `.currentTurn` 明确区分。

---

## 优先级建议

**本周做**(1-2 天):
- ⭐️ **X1 一致性 cron**(收益最大,今天启动)
- X4 pending_sends 兜底(30 分钟,可合到 X1)
- X5 一个 mock 并发单测(奠基础)

**下周做**(2-3 天):
- X2 threadSlug 审计(为下次 race debug 铺路)
- X3 结构化 logger

**下月做**(1-2 周):
- #1 根治:重构 RoleInstance 加 turn context 概念
- #2 拆 SpawnManager:从 TurnLifecycle 开始

**长期做**:D1 / D2 / D3

---

## 已实施的经验教训(reference)

**从 #199 学到**(2026-08-02):**任何"检查外部信号"的模块都必须用最鲜活的数据源**
- 优先级:messages 表(每 event 直接写)> 派生字段(如 role_instances.last_active_at,仅 status_change 更新)> 内存缓存
- ConsistencyCheck 早期用 `role_instances.last_active_at` 判 stuck_busy → 长 turn(19min/59 sub-turns/$45)误报
- 修:改查 `messages.MAX(ts) WHERE instance_id=?` 作为真活性
- 通用规则:**监控 / 告警类逻辑,先问"我用的字段更新频率是多少?" 再决定是否够权威**

## 最终评价

**这个系统能跑,但每次改并发相关代码要有心理准备"可能引入新 race"**。#187→#194 就是活证。

真正的稳定不是"修够多 bug",是"设计上 race 不可能发生"。目前离这个目标有距离,但 **X1 + X4 + X5** 能大幅缩小暴露面 —— 至少下次 race 5 分钟内有告警,不用 15 小时后被用户发现。
