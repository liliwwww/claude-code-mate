# Mate Supervisor 设计

**创建**:2026-08-08
**触发原因**:最近 2 天 8 类事故(见 `docs/优化建议backlog.md` 新发现待查),
根因是"观察不透明 + 边界事件恢复不完整 + AI 自律 fragile",需要一个**主动值班**的
监督组件把这些问题从"用户救火"变成"系统提示 + 一键处理"。

---

## 1. 目标

**Supervisor 是 mate 的"值班室"**,负责三件事:

1. **看**:实时监控每条活跃线索的健康状态(不是 5min 扫一次)
2. **判**:遇到异常自动分类,给出**具体处理建议**(不是干告警)
3. **示**:透明地把判断过程展示给用户,决策可追溯

**Supervisor 不做的事**(边界):

- ❌ 不替 role LLM 做业务决策(不是 super-orchestrator)
- ❌ 不直接改 chain / stack 等业务实体(除自愈 stack_drift 那种明确 case)
- ❌ 不自动执行破坏性动作(kill inst / cancel queue 都需 user 一键确认)

**核心原则**:让 user 从"猜"变"看",从"救火"变"确认建议"。

---

## 2. 架构

```
              WebSocket / HTTP API
                 (UI 呈现)
                     ▲
                     │ 状态 + 决策日志 push
                     │
              ┌──────┴──────┐
              │  Supervisor │  L2 Process Control(新层)
              │  (event +   │
              │   cron)     │
              └──┬───────┬──┘
                 │       │
        订阅 bus │       │ 30s 定时兜底扫全库
                 ▼       ▼
        ┌───────────┐  ┌──────────────┐
        │ mate 事件 │  │ DB 查询      │
        │ (chain +  │  │ (messages    │
        │  status + │  │  role_inst   │
        │  quota +  │  │  pending)    │
        │  ...)     │  │              │
        └───────────┘  └──────────────┘
```

**位置**:`server/supervisor/` 新目录,与 `server/spawn/` 平级
**依赖**:messageBus / db / PendingSends / ThreadStore(纯读)
**被依赖**:api/http.js(暴露 `/api/supervisor/*` endpoints)+ api/ws.js(广播事件)

**升级路径**:`server/spawn/ConsistencyCheck.js` 的 5 类检查纳入 supervisor,不再独立跑。
consistency check → supervisor 的一类"定时规则"。

---

## 3. 触发机制

Supervisor 有两个触发源,互补:

### 3.1 事件驱动(实时)

订阅 `messageBus` 上关键事件,每个事件触发对应规则:

| 事件 | 触发的规则 |
|---|---|
| `instance.status_change to='idle'` | 漏 marker 检测(检查上一段有无 handoff-like 关键字) |
| `instance.status_change to='busy'` | 长 turn 心跳启动(记开始时间) |
| `dispatch.completed` | chain 前进验证(与派工目标是否吻合) |
| `queue.added` | 队列健康检查(target 是否活着) |
| `instance.session_lost_recovered` | 记录恢复动作到 supervisor log |
| 每 30s cron | 兜底扫描(捞漏掉的 idle role、悬空 chain) |

### 3.2 定时兜底(每 30s)

事件驱动可能漏(比如 mate 重启时 event 没触发),定时扫描兜住:
- 扫全库 `role_instances WHERE status='busy'` × 检查 `messages.MAX(ts)` 是否 stale
- 扫全库 `threads` × chain 末段 ts + stack 派生 → 悬空检测
- 扫 `mate_pending_sends WHERE status='queued'` × 排队时长

---

## 4. 规则清单(MVP 3 条 + 扩展)

每条规则输出:
```javascript
{
  ruleId: 'missing_marker',
  severity: 'warn' | 'info' | 'error',
  threadSlug: 't-xxx',
  instanceId: 'mate-C.xxx',
  message: '人类可读描述',
  suggestedAction: {
    label: '补 marker 给 C',
    endpoint: 'POST /api/instances/mate-C.xxx/inject',
    body: { label: 'handoff', text: '...' },
  },
  detectedAt: <ts>,
  evidence: { /* 判断依据 */ }
}
```

### MVP 规则 1 · 漏 marker 检测(消除事故 #7)

**触发**:role 从 busy 转 idle 5s 后 · OR · 30s cron 扫

**逻辑**:
1. 查该 role 最近一段 `role_to_user` 消息
2. 提取所有 `<mate:*/>` marker
3. 若无 marker,检查文本关键字:
   - "交你决定" / "请裁决" / "请复核" / "请你决定" / "handoff" / "汇报" / "上报" / "完成"
   - 中英文 handoff-like signal 一批 (~30 关键字)
4. 命中关键字 + 无 marker → severity=warn,suggestedAction=inject 补 marker

**Evidence**:
- 最后一段消息 ts + 全文(供 UI 展示)
- 命中的关键字列表
- 该角色应该 handoff 给谁的推断(chain 上一步 target)

### MVP 规则 2 · 长 turn 心跳(消除事故 #5)

**触发**:role busy 且 > 60s 每 15s 检查一次

**逻辑**:
1. 查该 role 最近 15s 内有无 `system/thinking_tokens` OR tool_use event
2. 有 → severity=info,message="✓ H 在跑,已 3min,最近工具调用 5s 前"
3. 无(90s+ 完全静默)→ severity=warn,message="⚠ H 可能真卡了,90s 无任何 event"
4. 无(180s+)→ severity=error,suggestedAction=强制解卡(内部调 unstuck endpoint)

**Evidence**:
- 最后一次 tool_use / thinking_tokens ts
- turn 已跑时长
- turn 内 tool_use 累计次数(视觉上显示"在工作")

### MVP 规则 3 · 重启前门控(消除事故 #5 的另一半)

**触发**:UI 点"检查"按钮 · OR · UI 点"我要重启" 前置检查

**逻辑**:
1. 统计:
   - `role_instances WHERE status IN ('busy', 'spawning')` × 每个的 idle 时长
   - `mate_pending_sends WHERE status IN ('processing', 'queued')`
   - 30s 内有 tool_use event 的 role
2. 汇总裁决:
   - 🔴 阻塞:有 processing pending · OR · 有 role 30s 内有 tool_use
   - 🟡 警告:有 busy > 90s 静默(可能真卡了,重启相对安全但会打断)
   - 🟢 安全:全 idle/disconnected/dead
3. **UI 强门控**:🔴 时"我要重启"按钮 disabled,鼠标 hover 提示 reason

**Evidence**:每条 busy/processing 的 inst id + threadSlug + idle 时长 + 建议

### 扩展规则(阶段 2,渐进添加)

| 规则 | 触发 | 处理建议 |
|---|---|---|
| 4 · Chain 悬空 | stack 非空 + 栈顶 role idle > 5min | 高亮 unstick panel,提示重派 |
| 5 · Target 死了但派工到它 | queue.added target instanceId 已 dead | 建议自动重派到 pool 另分配 |
| 6 · Stack drift | DB call_stack != replayChain 派生 | 自愈(同现 X1)+ 日志 |
| 7 · 队列 stuck | pending queued > 1h | 建议 "立即派发"(现 UI1)|
| 8 · Chain 走串检测 | X2 audit flip 但目标 threadSlug ≠ chain 段声明 | 高亮 audit,建议 unstick |
| 9 · Session 老化 | role idle > TTL threshold | 建议 recycle(现有 ScanRecycler) |
| 10 · Quota 复发 | 短时间多次 rate_limit_event | 提示"多次撞墙,考虑降级模型" |

---

## 5. 数据源与实时性

**Bug #199 教训**:任何监控字段先问"这字段更新频率是多少?"

| 需要什么信号 | 用什么字段 | 为啥 |
|---|---|---|
| Role 活跃度 | `messages.MAX(ts) WHERE instance_id=?` | 每 event 直接写,最鲜活 |
| Role 状态 | `role_instances.status`(in-memory Map)| 状态转换即时更新 |
| Chain 状态 | `threads.metadata.dispatch_chain` | 每次 handoff / done 追加 |
| 队列状态 | `mate_pending_sends`(全表)| PendingSends CRUD 即时 |
| 最新 tool_use | messages WHERE event_type LIKE 'system/thinking%' OR 'tool_use%' | 直接查 |

**禁止**:用 `role_instances.last_active_at` 判活性(#199 就栽在这)。

---

## 6. UI 呈现

### 6.1 顶栏 supervisor 状态灯(常驻)

```
[🟢 Supervisor · 正常]     ← 全绿:无异常
[🟡 Supervisor · 3 项提示]  ← 有 warn(如疑似漏 marker、长 turn 静默)
[🔴 Supervisor · 1 项阻塞]  ← 有 error(如 processing queue,不能重启)
```

点击 → 弹 modal 显详细报告(下)

### 6.2 检查报告 modal(点状态灯打开)

```
┌────────────────────────────────────────┐
│  Mate 健康检查报告  2026-08-08 12:00   │
├────────────────────────────────────────┤
│                                        │
│  🔴 阻塞项 (1)                         │
│  ─────────────                         │
│  · mate-H.abc 在 t-xxx 上 busy 40s     │
│    最近 tool_use: bash 3s 前           │
│    → 建议:等它跑完(勿重启)           │
│                                        │
│  🟡 警告项 (2)                         │
│  ─────────────                         │
│  · mate-C.def 疑似漏 marker            │
│    上段末尾"交你决定"但无 marker       │
│    → [一键补 marker 给 C]              │
│                                        │
│  · mate-B.ghi busy 4min 无 tool_use    │
│    → 可能卡了,考虑 [强制解卡]         │
│                                        │
│  🟢 正常项 (35)                        │
│  ─────────────                         │
│  · 32 disconnected(不占资源)          │
│  · 3 idle                              │
│                                        │
├────────────────────────────────────────┤
│      [关闭]        [我要重启] (禁用)    │
└────────────────────────────────────────┘
```

**"我要重启"按钮**:
- 🟢/🟡 时 enabled,点击后触发 mate graceful shutdown(等 in-progress 完成或 stash)
- 🔴 时 disabled + hover tip 显阻塞原因
- 优雅 shutdown 需 backend 支持:接 UI request → wait busy insts done → exit(超时兜底 kill)

### 6.3 Supervisor 工作日志面板(独立 tab)

在 dashboard 加一个新 tab 或独立页面 `/dashboard.html#tab=supervisor`:

```
时间           规则          目标              判断            建议动作          用户反应
─────────────────────────────────────────────────────────────────────────────
12:03:00       missing_marker mate-C.jhkfgv    warn            [inject marker]   ✓ 采纳
12:02:45       long_turn      mate-H.gjr4j7    info · 正常在跑  (无)             -
12:00:12       restart_gate   —                block           (拒绝重启)        ⚠ 用户强 kill
11:58:00       chain_drift    t-xxx            warn            [check unstick]   跳过
```

Filter:by 规则、by severity、by threadSlug。
每条可展开看 evidence(SQL 查询结果、消息原文等)。

### 6.4 前端事件驱动

- Supervisor 状态变化 → bus.publish('supervisor.state_change')
  - UI 收到 → 更新顶栏灯 + tick 日志面板
- Supervisor 决策 → bus.publish('supervisor.decision')
  - UI 收到 → append 到工作日志

---

## 7. HTTP API

```
GET  /api/supervisor/state         → 当前状态 + 各 severity 计数
GET  /api/supervisor/findings      → 当前所有 findings(可 filter by severity/rule/thread)
GET  /api/supervisor/log?since=... → 决策日志(时间线)
POST /api/supervisor/dismiss/:id   → 用户忽略某 finding(不改状态,只不再重复提示)
POST /api/supervisor/apply/:id     → 一键采纳 suggestedAction(内部调对应 endpoint)

GET  /api/supervisor/restart-check → 重启门控专用(返 verdict + block reasons)
POST /api/system/graceful-restart  → 平滑重启(等 busy 完成或 stash context)
```

---

## 8. 事故映射:supervisor 能拦哪些历史事故?

| 事故 | 现象 | Supervisor 会怎么处理 |
|---|---|---|
| #5 长 turn 误判 | H 长 turn 无输出 → 用户重启 | 规则 2/3:UI 显 "H 3s 前刚查 SQL,正常在跑",重启按钮 disabled |
| #6 fresh R 无 briefing | mate 重启后新 R 缺 context | Supervisor 检测到"新 R spawn + 无 briefing",提示或自动 inject(超出 MVP) |
| #7 C 漏 marker chain 悬空 10h | | 规则 1:C idle 5s 后立即检测到"交你决定"无 marker → 弹提示 |
| #3 队列 stuck 15h | | 规则 7(扩展):1h 内自动提示 |
| #1 chain 走串误报 | | scanner 已降级 advisory,supervisor 不再用它 |
| #8 UI inject "not found" | UI 传错 instId | 独立 UI bug 修复,不属 supervisor |

**MVP 3 条规则直接堵住 #5 / #7 两个最痛的 → 覆盖近 2 天 60% 事故**。

---

## 9. 实施阶段

### Phase 0 · MVP(1-2 天)—— 立即开工

1. `server/supervisor/index.js` 骨架(event listener + cron)
2. `server/supervisor/rules/missing_marker.js` — 规则 1
3. `server/supervisor/rules/long_turn.js` — 规则 2
4. `server/supervisor/rules/restart_gate.js` — 规则 3
5. `server/supervisor/store.js` — findings + log 存储(内存 + 定期落 events 表)
6. HTTP endpoints(4 个)
7. WebSocket broadcast

### Phase 1 · UI(1 天)

1. 顶栏 supervisor 状态灯 + modal
2. "我要重启"按钮 + graceful shutdown 接线
3. Supervisor 日志面板 tab

### Phase 2 · 扩展规则(渐进,每次踩坑加一条)

按事故清单第 4-10 条规则,遇到再加。

### Phase 3 · 长期(不急)

- Supervisor 决策历史长期存储(events 表 supervisor.* kind)
- 用户 dismiss 偏好记忆(某类 finding 长期忽略)
- 决策效果反馈闭环(采纳率 / 误报率统计)

---

## 10. 迁移策略

- 现有 `ConsistencyCheck.js` 保留但**规则内容全部搬到 supervisor**,ConsistencyCheck
  变成"supervisor 的一类定时规则集合"(orphan_pending / stack_drift / stuck_queue /
  stuck_busy → supervisor 的规则 6/7/9)
- X2 audit 的 events 表继续用,supervisor 从中订阅信号
- `/api/consistency-check` 和 `/api/chain-crossings` 保留(向后兼容 + dashboard tool)

---

## 11. 与 backlog 现有条目的关系

| Backlog 条 | 关系 |
|---|---|
| **重启前自检**(高)| Phase 0 规则 3 直接实现 |
| **新 R spawn 应注入 briefing**(中)| Phase 3(需 supervisor 主动写入 role) |
| **PoolAllocator 继承死 inst threadSlug**(低)| 属 backend 内部 bug,supervisor 不直接管 |
| **UI inject "instance not found"**(中)| 独立 UI bug,supervisor 不管 |
| **#1 threadSlug immutable refactor**(架构级)| 长期。supervisor 一定程度上让这条不那么紧迫 |
| **#2 SpawnManager god class 拆分**(架构级)| 长期。supervisor 是新模块,不加剧 god class |

---

## 12. 风险 & 未解决问题

**风险**:
- Supervisor 规则误报会让用户失去信任 → 每条规则**先设 warn,观察 1 周再升 error**
- 一键采纳可能引入新 bug(比如自动 inject 覆盖了 role 未完成的思考)
  → MVP 只提示,一键采纳留 Phase 2
- Supervisor 本身 crash 会静默失败 → 需要 supervisor 自监控(自举)

**未解决**:
- **kill port 8721** 时 mate 拿不到信号 → graceful restart 只能保证 UI 走"我要重启"
  按钮时优雅,用户直接 kill 进程还是硬中断
  → 妥协方案:UI 顶栏永远显示"⚠ 请点'我要重启'按钮,不要直接 kill 进程",
    supervisor 检测到有 busy inst 时红字加粗

---

**结束**。这份文档定稿后,按 Phase 0 开工。
