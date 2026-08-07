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

**status**: ✅ **done** (2026-08-06,17 文件 143 处 warn/error 全迁完)

**已完成**:
- `server/logger.js` 骨架(~70 行,零依赖,pretty + JSON 双模式,MATE_LOG_LEVEL/MATE_LOG_JSON 环境变量控制)
- 全库 `console.warn/error` → `log.warn/error` 迁完 17 文件 143 处:
  - core: SpawnManager 36 + MarkerDispatcher 31 + ConsistencyCheck 12
  - infra: db 7 + index 5 + logger 1(logger 内部实现,输出到 stderr)
  - subsystems: RoleCatalog 13 + RoleInstance 8 + http 7
    + DispatchLogWriter 6 + ThreadHooks 5 + QuotaState 4
    + PoolAllocator 2 + MockRoleInstance 2 + QueueDispatcher 1
    + ScanRecycler 1 + ws 1 + SlotPool 1

**用法**:
```javascript
const log = require('./logger');   // 或相对路径 ../logger
log.warn({ module: 'SpawnManager', event: 'queue_flush_failed', pendingSendId: 42, error: e.message });
log.info({ module: 'boot', event: 'ready', port: 8721 });
```

**输出**(默认 pretty,一行):
```
[2026-08-06T12:00:00.000Z] [WARN] [SpawnManager] queue_flush_failed pendingSendId=42 error="target dead"
```

**JSON 模式**(`MATE_LOG_JSON=1`):
```json
{"ts":"2026-08-06T12:00:00.000Z","lvl":"warn","module":"SpawnManager","event":"queue_flush_failed","pendingSendId":42,"error":"target dead"}
```

**收益**:
- 生产可以 grep event 名统计 bug 频率(`grep 'event=queue_flush_failed' logs`)
- JSON 模式接 ELK/jq 做趋势分析(`jq 'select(.event=="chain_append_failed")'`)
- 新写 warn 强制思考 event 分类,不再随手扔字符串

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

**status**: ✅ **done** (2026-08-07,4 大场景 6 个 test case 全绿)

**已完成**(追加到 `tests/unit/queueDispatcher.test.js`,共享 mock 基础设施):
- Scenario 1: 两线索不同 target 并发 idle 不交叉(2 case:2 线索 + 4 线索)
- Scenario 2: 同 target 两线索 FIFO 严格保序(并发 3 次 idle)
- Scenario 3: forceDispatch(UI1)跳队 — 只 flush 该条,其他 status 不变
- Scenario 4: 并发 flush 同 target 不重派(markProcessing 原子性)

**顺带修**:
- `tests/unit/roleCatalogValidator.test.js` — 5 处期望文本更新到 logger 结构化格式
- `tests/unit/markerDetector.test.js` — 2 处补 taskSlug 字段
- `server/logger.js` — warn 从 console.error 改回 console.warn(测试 stub 友好,符合 node 惯例)

**规则**(以后必须遵守):
- 改 SpawnManager / QueueDispatcher async 路径 → 先扩此文件测试再 merge
- 全 unit suite:`node tests/runner.js`(2 秒),必须 all pass

**未做的深化**(可按需扩展):
- SpawnManager `_wireListeners` 里 status_change/result event 流的 mock(需大改 SpawnManager 让它可 mock)
- MockRoleInstance 双实例并发场景(需引入 real event loop simulation)

---

## UI/UX 加固

### 加固 UI1:排队面板加"手动 flush 此项"按钮

**status**: ⬜ pending

今天 ps=26 stuck 15h,只能等 mate 内部逻辑触发。加个"立即派发"按钮,直接调 dispatchCb(不等 idle 事件)。

**预估工作量**:半天

---

### 加固 UI2:Chain 走串历史迁移工具

**status**: ⏸ **rethink** (2026-08-07,前提已变)

原议:识别走串 seg → 生成迁移计划 → 迁移。

**为什么先不做**:
- 2026-08-06 已把 chain-crossings scanner(文本匹配)降级为 advisory,
  真"走串"信号只有 X2 audit(未来 flip 才有 caller stack 证据)
- 老历史脏数据(如 t-mrwwnh63-8g3f 上 2026-07-x 的 seg)**没有** X2 evidence,
  只能靠人肉判断哪段是真走串,不能自动识别
- 用文本扫描作为"走串"identifier 会误标合理跨线索引用为脏数据

**如果要做**:改设计为"手动 seg 编辑器"—— dispatch 面包屑给每段加右键
菜单"标记为脏(视觉隐藏)"或"重定向到其它 thread",走独立 audit table。
不再自动扫描。等未来真有大量脏数据需要清理时启动。

---

### 加固 UI3:Session-lost 恢复的 diff 报告

**status**: ⬜ pending

目前 `_handleSessionLost` 直接删死实例、重派,用户没感知。

建议:UI ticker 一条明显提示 "🔄 <name> session lost,已重派 pending" + 展开可看差异。

**预估工作量**:半天

---

### 加固 UI4:mate-R 权限精细化

**status**: ❌ **skip** (2026-08-06,原议已过时 + wrong direction)

原议:显式列 `Bash(curl:*)`, `Bash(grep:*)` 等,不用裸 `Bash`。

**为什么不做**:
1. 原始动机"R 想 curl mate API 被拒"早已不复存在 —— role prompt 里
   现在明确指导 R `curl http://127.0.0.1:8721/api/threads/...` 做状态查询,
   permission_mode=dontAsk + 裸 Bash 组合工作正常
2. role 用 Bash 的场景高度动态(python -c、node -e、wmic、netstat、git、
   ls、cat...),显式白名单**必定不全**,反而频繁被拒破坏可用性
3. mate role 是可信 executor,不是不受信内容,不需要 role 层白名单 sandbox

**真正的安全隐患**(destructive 命令)另外解决,应走 **deny list** 而不是收窄
allow list。等有实际 incident 再补 —— 目前 4 次 chain 走串都不是权限问题。

**如果要做**:改 `server/roles/RoleCatalog.js` schema 加 `deny_rules`,
`server/spawn/RoleInstance.js` 里 --settings 的 permissions 加 deny 字段,
给 4 role 统一加:
```yaml
deny_rules:
  - Bash(rm -rf:*)
  - Bash(sudo:*)
  - Bash(git push --force*)
  - Bash(git reset --hard*)
  - PowerShell(Remove-Item * -Recurse -Force*)
```
预估 2 小时。等有需要时再启动。

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

## 新发现待查(2026-08-06)

**PoolAllocator.create 可能继承 slot 上一个 dead inst 的 threadSlug**
- 现象:H.lo335h(bound=t-mrwwnh63-8g3f)dead 后,mate 为 slot 1 spawn H.c5fwsp,
  X2 audit 显示 c5fwsp 的第一次 flip `from=t-mrwwnh63-8g3f → to=t-msgvzn3o-t9kc`
- 期望:新 spawn 应该 `from=null` 起步
- 假设:PoolAllocator.create 从 dead inst 拷了 threadSlug,或者 _acquirePoolInstance
  某分支传了错的 threadSlug 给 ctor
- 优先级:低(setter 后续会拨对,不引发功能问题),但可能是"陈迹污染 → 未来 race"的
  隐患 → A1 根治 threadSlug mutable 时一起处理
- 定位:grep PoolAllocator.js 里 `threadSlug` 的 create 路径

**"重启前自检"按钮 — 帮 user 判断"是否可以安全重启 mate"**(2026-08-07,优先级高)
- 现象:mate 长 turn(claude 连续 tool_use 几分钟无 assistant final)从 UI 看像
  "日志不刷",user 误以为卡了 → kill port 8721 → 打断 in-progress task →
  R 换新实例丢 context(见下条 "新 R spawn 应注入 briefing")
- 本质:用户遵循 memory 里 `feedback_dont_kill_mid_task` 规则,但**没法一眼
  看出"是否真忙"** —— busy chip 看不出"最近是不是有 tool_use event"
- 根因:静默指标缺失 + kill 是外部动作(mate 没机会拦)
- 方案 A(最小,推荐):**咨询式**按钮
  - 顶栏加 🚦 图标"重启前检查"
  - 点击弹 modal,3 段:
    - 🔴 硬阻塞:`role_instances.status='busy'` × 每个显示 threadSlug + 已工作时长 + 最新 tool_use ts + `mate_pending_sends.status='processing'`
    - 🟡 静默但可能在跑:busy 但 > 60s 无 event → "可能卡了" · busy 有近期 event → "别打断"
    - 🟢 安全:disc/idle 数
  - 综合裁决:🟢 随便重启 · 🟡 有 busy 可能长 turn · 🔴 有 processing / 近期活跃 busy
  - backend:`GET /api/system/restart-safety` 返 verdict + details
  - frontend:顶栏图标 + modal,数据源 role_instances × messages(MAX(ts)
    WHERE instance_id=? — 学 #199 教训用最鲜活数据源)+ mate_pending_sends
- 方案 B(重):**阻拦式** — SIGTERM handler 检查 busy,如果有,拒绝 exit
  并输出"以下 role busy, resend SIGTERM 强制退出" —— 但 port kill 时 mate
  拿不到信号,只对 Ctrl-C shutdown 有效
- 方案 C(最重):**graceful shutdown** — 等 in-progress task 自然完成再 exit,
  设 timeout(e.g. 5min)后强制。工作量大 + 语义边界复杂(handoff 中?callback 中?)
- 推荐先做 A(1-2h),验证信噪比后再决定要不要 B/C
- 优先级:**高**(每次 mate 需要重启都有踩坑风险,加了这个按钮直接消除)

**新 R spawn 时应注入线索历史 briefing**(2026-08-07 新发现,优先级中)
- 现象:mate 重启同时 kill R.uubiza + H.41bggs → user 立即发消息 → mate spawn
  全新 R.5uow14(新 session,不是 resume 旧 session) → R.5uow14 只收到裸的
  user 文本"还需要怎么验收?"没任何 chain 上下文 → 只能诚实反问"哪项工作"
- 根因:mate spawn 新 R(pool empty)时,给 R 的第一条 user_to_role 消息**没
  注入线索历史 briefing**(chain 摘要 / 最近对话 / handoff brief)
- 期望:类似 role prompt 里"你的第一条 user 消息会告诉你线索"的承诺,mate
  应该在首条消息前注入类似:
  ```
  [Thread: t-mrwwnh63-8g3f | Project: 6]
  该线索之前 chain 简要(最近 5 段 handoff reason 摘要):
    [441] H→R: test_agent 完工验收通过...
    [442] R→H: score agentic 模式新需求...
    ...
  你是接手的新 R(mate 重启导致换实例)。请先 curl mate API 核实状态再回复。
  ```
- 影响:mate 重启 / role dead → 用户体验断层。今天(2026-08-07 15:54)真实
  发生,user 被迫手动补 context 才能推进
- 定位:找 `_bootstrapNewRoleForThread` / `sendToThread` 里 spawn 新 R 后
  首次注入 payload 的路径。可能是 SpawnManager._sendToPooledRole 或
  RoleInstance.sendUserText 之前该有个 briefing prepend
- 关联:类似"session-lost 恢复"路径(#180 已实现的 respawn+retry)—— 那个
  重发的是最后一次 handoff 消息,不是 fresh spawn 的首消息路径。需要区分两条路
- 优先级:中(用户会看到"我是谁?" 类响应,信任度受影响,但可通过手动补
  context 绕过)

**chain-crossings scanner 只该扫路由字段,别扫 reason/summary 文本** ✅ done (2026-08-06 #202)
- 决策:文本匹配没有可靠路由字段可依赖(chain 段本身没有 targetThread 字段),
  真"走串"信号已被 X2 audit(`debug.instance_threadslug_flip`)完全覆盖 —
  X2 有 caller stack + 精确 ts,比文本引用报告 actionable 得多
- 落地:
  - ConsistencyCheck Check 5 移除(不再触发 `system.consistency_alert`)
  - `/api/chain-crossings` endpoint 保留(dashboard "Chain 自检" tab 手动扫),
    response 加 `advisory: true` 标记 + `advisoryNote` 提示
  - dashboard.js 渲染时显式说明"文本引用扫描,不代表真走串,真走串看
    /api/audit/threadslug-flips"
- 遗留:`acknowledgeCrossings` API + baseline meta key 保留但已无实际作用

## 已实施的经验教训(reference)

**从 2026-08-06 chain 走串复发学到**:**改代码 ≠ 生效**
- mate 从 08-03 起没重启,08-05 加的 X2 audit 完全没触发,#187/#194 也是 dormant
- 08-06 又发生一次 chain 走串,原本 X2 audit 该秒定位,但因为老代码在跑 → 一片空白
- **规则**:每次 commit 后 ticker/顶栏提示"代码变更未生效,请择机重启 mate"。以及 `/api/system` 加一个字段返"loaded_code_mtime",跟当前 mtime diff → 让用户和 UI 都知道要重启
- 长远:探索 hot-reload 部分模块(至少 ConsistencyCheck / HTTP router 这类)

**从 #199 学到**(2026-08-02):**任何"检查外部信号"的模块都必须用最鲜活的数据源**
- 优先级:messages 表(每 event 直接写)> 派生字段(如 role_instances.last_active_at,仅 status_change 更新)> 内存缓存
- ConsistencyCheck 早期用 `role_instances.last_active_at` 判 stuck_busy → 长 turn(19min/59 sub-turns/$45)误报
- 修:改查 `messages.MAX(ts) WHERE instance_id=?` 作为真活性
- 通用规则:**监控 / 告警类逻辑,先问"我用的字段更新频率是多少?" 再决定是否够权威**

## 最终评价

**这个系统能跑,但每次改并发相关代码要有心理准备"可能引入新 race"**。#187→#194 就是活证。

真正的稳定不是"修够多 bug",是"设计上 race 不可能发生"。目前离这个目标有距离,但 **X1 + X4 + X5** 能大幅缩小暴露面 —— 至少下次 race 5 分钟内有告警,不用 15 小时后被用户发现。
