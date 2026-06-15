# Phase 2G — 队列化派工 + 面包屑 + Backlog + 状态图

**起源**:2026-06-15 user 反馈 t-mqekmt9d-zpia 那条线索 R 干了不该干的活,顺带追问"多 R 派同一 H 时怎么处理"。审计发现 `SpawnManager.js:518-520` 注释里就写了 "Phase 2D §8.5 will add queueing for busy" —— 当时跳过了。本次补齐。

## 0. 现状(0.4.0 已知 bug)

- 多 R 派同一 H 时**无队列**:R2 派工的 marker 在 H busy 时直接写 stdin
- `inst.threadSlug` 单值字段被覆盖 → thread1 状态灯熄,user 以为 thread1 完事了实际 H 还在跑
- 派工卡片都立刻显 `ready`,看不出"排队中"
- `PendingSends` 表存在但代码不调它的 enqueue/flush
- H `parallelism_limit=1`(只有 1 个 H 实例,且 claude headless 不支持内部并发)

## 1. 设计原则

| # | 原则 | 解释 |
|---|---|---|
| 1 | **队列 DB 持久化** | `PendingSends` 表落地;mate 重启后队列还在 |
| 2 | **H 显式分派 B/C** | mate 不偷偷选 slot,H 必须在 marker 写 `target="mate-B-3"`;mate 注入 pool snapshot 让 H 看见各 slot 状态 |
| 3 | **面包屑 = 派工链 call stack** | dispatch_chain 数组 append,同实例相邻折叠;`<mate:done>` 出栈语义 |
| 4 | **Wait / Backlog / Cancel 三态** | busy 时 user 选;cancel 限"未开始处理" |
| 5 | **池化 boot 预热** | H × 1, B × 4, C × 4 boot eager;R lazy |
| 6 | **状态图节点-边图** | 仪表盘新 tab;D2 节点-边手写 SVG 不引依赖 |

## 2. 数据模型变更

### 2.1 `pending_sends` 表(已存在,扩字段)

```sql
ALTER TABLE pending_sends ADD COLUMN dispatch_chain TEXT;  -- JSON array
ALTER TABLE pending_sends ADD COLUMN backlog_at INTEGER;   -- nullable; 加入 backlog 的时间
ALTER TABLE pending_sends ADD COLUMN cancelled_at INTEGER; -- nullable
ALTER TABLE pending_sends ADD COLUMN cancel_reason TEXT;
-- reason 字段已有,扩 enum:'busy' | 'quota_pause' | 'spawning' | 'backlog'
-- status: 'queued' | 'backlog' | 'processing' | 'done' | 'cancelled'
```

### 2.2 `thread.metadata.dispatch_chain`

```jsonc
{
  "dispatch_chain": [
    { "role": "mate-R", "instanceId": "mate-R.xy1", "ts": 1781..., "marker": null },
    { "role": "mate-H", "instanceId": "mate-H-1",   "ts": 1781..., "marker": { "kind": "handoff", "reason": "..." } },
    { "role": "mate-B", "instanceId": "mate-B-3",   "ts": 1781..., "marker": { "kind": "handoff", "reason": "..." } }
  ]
}
```

- 每次 marker handoff 触发 append
- `<mate:done>` 不 append(等于出栈,但保留历史方便回放)
- 渲染时折叠相邻同 `instanceId`

### 2.3 `inst.currentTaskSlug`(snapshot 新字段)

- 池化角色(H/B/C)用 currentTaskSlug 跟踪"此刻在跑哪个 thread 的活"
- `inst.threadSlug` 保留给 R(R 是 per-thread 长绑定)
- 池化角色的 `inst.threadSlug` 改为 null(不再用),改用 `currentTaskSlug`(per turn 切换)

## 3. 状态机

```
       R emits <mate:handoff target="mate-H">
                       │
                       ▼
            ┌───────────────────┐
            │  H idle?          │
            └─────┬─────────────┘
        yes ◄─────┘─────► no
         │                │
         ▼                ▼
    [立即 dispatch]    emit WS dispatch.busy_prompt
    status='processing' │
                        ▼
                user 在 UI 选择:
                  ① 等待 H → status='queued', enqueue → 等 H idle 自动 flush
                  ② 加 backlog → status='backlog' → user 手动 dispatch
                  ③ 取消 → status='cancelled'

queued / backlog:
  - cancel: status='cancelled', cancelled_at=now
  - (only backlog) dispatch: status='queued' → 走 H idle flush 通道
  - (auto) H 变 idle 时 PendingSends.flushOldestQueuedFor(roleName, slot) → status='processing'

processing:
  - claude result event → 解析 markers → 递归触发下一轮 handoff(可能再排队)
  - status_change idle → 等下一条 user 输入
  - user clicks ■停止 → kill child(走 §18 现有路径)
```

## 4. WS topics(新加 + 修改)

| topic | payload | 触发 |
|---|---|---|
| `dispatch.busy_prompt` | { pendingSendId, fromInst, toRole, toSlot?, reason, threadSlug } | marker dispatch 时目标 busy |
| `queue.added` | { pendingSendId, toInstId, threadSlug, chain } | enqueue |
| `queue.claimed` | { pendingSendId, toInstId, threadSlug } | flush 时被领取 |
| `queue.cancelled` | { pendingSendId, threadSlug } | cancel queued item |
| `backlog.added` | { pendingSendId, toRole, threadSlug } | 用户选 backlog |
| `backlog.dispatched` | { pendingSendId, toInstId, threadSlug } | backlog → queued |
| `backlog.cancelled` | { pendingSendId, threadSlug } | cancel backlog item |
| `dispatch.chain_updated` | { threadSlug, chain } | dispatch_chain 变化 |

现有 `thread.handoff` / `thread.handoff.ready` 等保留(向后兼容),但 chain 触发用新 topic。

## 5. API endpoints(新增)

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/dispatch/:pendingSendId/choose` | user 在 busy_prompt 选 wait/backlog/cancel |
| POST | `/api/queue/:pendingSendId/cancel` | cancel queued item |
| POST | `/api/backlog/:pendingSendId/dispatch` | backlog → queue 触发 dispatch |
| POST | `/api/backlog/:pendingSendId/cancel` | cancel backlog item |
| GET | `/api/queue?projectId=N` | 列所有 queued + backlog(主视图 + 状态图) |
| GET | `/api/queue/:pendingSendId` | 单条详情 |

## 6. 后端模块新增 / 改

### 6.1 新加 `server/spawn/QueueDispatcher.js`

```js
class QueueDispatcher {
  /**
   * Called by MarkerDispatcher when marker handoff target is busy.
   * Creates a PendingSends row with status='waiting_user' and emits
   * WS dispatch.busy_prompt; user chooses via /api/dispatch/:id/choose.
   */
  static enqueueBusy({ fromInst, marker, threadSlug, text }) {...}

  /**
   * User chose 'wait' → status → 'queued';
   * 'backlog' → status='backlog';
   * 'cancel' → status='cancelled'.
   */
  static handleUserChoice(pendingSendId, choice) {...}

  /**
   * Called when an instance becomes idle. Find oldest queued item
   * targeting this instance (or its role pool slot), dispatch it.
   */
  static onInstanceIdle(instance) {...}

  /**
   * Cancel a queued/backlog item.
   */
  static cancel(pendingSendId) {...}

  /**
   * Move backlog item to queued (will be flushed when target idle).
   */
  static dispatchBacklog(pendingSendId) {...}
}
```

### 6.2 改 `MarkerDispatcher`

- `_dispatchHandoff` 检测目标 busy → 不直接发,调 `QueueDispatcher.enqueueBusy`
- target 解析:`mate-B-3` 显式 slot;`mate-B` 泛型 → mate 选 idle slot(也可拒绝交给 H,先按 idle slot 兜底)

### 6.3 改 `SpawnManager._wireListeners`

inst.on('status_change', to='idle') → 调 `QueueDispatcher.onInstanceIdle(inst)` flush

### 6.4 改 `RoleInstance.snapshot()`

新增 `currentTaskSlug` 字段;池化角色的 `threadSlug` 字段废弃(继续返回 null)。

### 6.5 改 `PendingSends.js`

加 `findOldestQueuedFor(targetInstId)` / `findOldestQueuedForRole(roleName, slot)` / `markProcessing` / `markCancelled` / `markBacklog` 等

## 7. 前端模块新增 / 改

### 7.1 主视图 (app.js)

- conv-header 下渲染 **面包屑**(读 thread.metadata.dispatch_chain)
- §19 等待 indicator 文本改:"等待 mate-X-Y 响应"(用 chain 末段实例名)
- 新 WS topic `dispatch.busy_prompt` → 弹 modal(等待 / backlog / 取消 三按钮)
- 主视图新区"队列与 Backlog"(可折叠 panel 在 conv-header 下方,显示当前 thread 在队列/backlog 的位置 + cancel/dispatch 按钮)

### 7.2 仪表盘 D2 状态图 (M2)

- 新 tab "状态图"(第 6 个)
- 数据源:`GET /api/runtime/snapshot` + `GET /api/queue`
- 渲染:手写 SVG,4 层布局
- 增量更新:WS 增量触发节点/边重画

### 7.3 chip / popover

- chip 不变(busy term inline 已显示)
- popover 加"队列长度"提示(每个池化角色显 `H-1 busy · 2 queued`)

## 8. boot 预热 + cap

### 8.1 SpawnManager 启动逻辑

- boot 时遍历 active projects
- 每个 project pre-spawn:1 mate-H + 4 mate-B + 4 mate-C(parallelism_limit=4)
- R 不预热
- 预热失败不阻塞(继续 boot,UI 警告 banner)

### 8.2 config 改

- `globalMaxClaudeProcesses`: 8 → **16**(默认),允许 env override

### 8.3 role frontmatter 改

- `mate-B.md`:`parallelism_limit: 2` → `4`
- `mate-C.md`:`parallelism_limit: 2` → `4`

## 9. 实施顺序(里程碑)

### M1 — 队列引擎 + 面包屑 + Cancel + Backlog(3-4 天)

依赖:无。可单独发版。M1 完成 user 可在主视图看到队列态 + cancel + backlog + 面包屑。

- M1.0 — design doc(本文档)
- M1.1 — QueueDispatcher + PendingSends 激活
- M1.2 — dispatch_chain + currentTaskSlug
- M1.3 — endpoints + WS topics
- M1.4 — 前端面包屑 + 三选一 modal + queue/backlog UI
- M1.5 — boot 预热 + cap

### M2 — 状态图 (1-3 天)

依赖:M1(数据来源已就绪)。仪表盘新 tab。

### M3 — H pool 感知 (2-3 天)

依赖:M1(pool 状态可查)。H system prompt + 每条消息前置 [Pool: ...] snapshot。

## 10. 不破坏现有 backwards compat

- 现有 `thread.handoff`/`thread.handoff.ready` WS topic 继续 emit(老前端兼容)
- 现有 marker 协议不变(`<mate:handoff target="..." />` 语法不动)
- DB schema 改用 ALTER 不 drop 表

## 11. 测试目标

- 单测:QueueDispatcher 状态机(busy_prompt → wait/backlog/cancel 三路径)
- 单测:dispatch_chain 折叠相邻重复
- adversarial:R1 + R2 同时派 H + 取消第 2 个,验证 thread1 状态灯依然绿
- 集成:重启 mate,DB 里 queued 项目恢复并被新 H 实例 claim
