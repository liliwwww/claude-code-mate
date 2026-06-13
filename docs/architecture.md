# Claude Code Mate — 架构设计

> 本文档是**架构 SSOT**(Single Source of Truth)。约束代码组织、模块边界、依赖方向、禁止条目。
> 任何后续 Phase 改动必须先回到本文档对齐;若与本文档冲突,优先改本文档说服 reviewer,再动代码。

---

## §1 核心原则:升维不再造

Mate 不是新 agent,**不替代** R / H / execB / testC 任何一个角色的工作。它干 3 件事:

1. **接入(Input)** — user 单一输入框 / 多线索切换 / 派工进度可见
2. **聚合(View)** — 多 project 视图 / 顶栏实时 chip / 仪表盘 swimlane
3. **协调(Coord)** — marker → dispatch / quota 暂停 + 恢复 / 卡死 unstick

**关键约束**(违者 = 架构退化):

- mate **绝不替 LLM 做业务判断** — 选哪个 execB / handoff reason 写啥 / 派 testC 还是 execB,全部由 LLM(role 实例)决定;mate 只解析 marker,机械执行
- mate **不写不读** sibling project 的 `doc/queue/`、`doc/_dispatch/`、`WORK_HANDOFF_*.md`、`doc/terminal_status/*.md`(file-based 协议已 retired,Phase 2C 起 marker → in-memory dispatch)
- mate **不缓存业务结论** — thread state 在 SQLite,quota state 在 SQLite,但 mate 不存 "execB-2 擅长 auth 模块" 这种业务判断(那是 H 的认知,放 H 自己 session/auto-memory)
- mate **child claude 之间不共享 RAM 状态** — instance 之间通信只通过 marker(role→role 唯一通道)

详细禁止条目见 §6 模块边界规约。

---

## §2 维度区分(UI/Domain 模型)

| 维度        | 谁感知       | 在哪里展示              | 标识符 |
|-------------|--------------|-------------------------|--------|
| **Project** | user 主动 | 顶栏 picker            | `project.id` (int) |
| **Thread(线索)** | user 一等公民 | 主视图线索板 | `thread.slug` (text, project 内唯一) |
| **RoleInstance(终端)** | user 透明,系统调度 | 仪表盘 + chip popover | `instance.id`(internal)+ `displayName`(`execB-2` 池槽名)|
| **Role(角色定义)** | user 不感知 | mate `roles/*.md` | `role.name`(`planA-R` 等)|

→ user 想多讨论一个问题 = **新建线索**(系统自动 spawn R),**不是** spawn 新角色实例。
→ user 看到 "execB-2 在干活" = pool slot 名,跟 thread 关系是动态的(同一 execB-2 可服务多 thread,**不绑死**)。

---

## §3 模块拓扑(7 层)

```
┌──────────────────────────────────────────────────────────────────┐
│  L6 Frontend          public/                                   │
│   - index.html / dashboard.html(挂载点)                         │
│   - app.js(主视图)/ dashboard.js(仪表盘)                       │
│   - components/runtime-chip.js(顶栏 chip 组件)                  │
│   - style.css                                                   │
└──────────────────────────────────────────────────────────────────┘
                            ↑ HTTP/WS only(不直读 SQLite)
┌──────────────────────────────────────────────────────────────────┐
│  L5 Bootstrap         server/index.js                           │
│   组装 express + WS + lifecycle,纯 wiring,不含业务              │
└──────────────────────────────────────────────────────────────────┘
                            ↑
┌──────────────────────────────────────────────────────────────────┐
│  L4 API Surface       server/api/                               │
│   - http.js — REST router(无状态,所有状态去 L2/L1)             │
│   - ws.js   — WebSocket fanout(转发 messageBus 给所有 client)   │
└──────────────────────────────────────────────────────────────────┘
                            ↑
┌──────────────────────────────────────────────────────────────────┐
│  L3 Business Hooks    server/system-agent/                      │
│   - SystemAgent.js   — Haiku 短命 LLM runner(摘要/模板)         │
│   - ThreadHooks.js   — 自动摘要 / reply template / has_question  │
│   - envCheck.js      — env 探针                                 │
└──────────────────────────────────────────────────────────────────┘
                            ↑
┌──────────────────────────────────────────────────────────────────┐
│  L2 Process Control   server/spawn/ + server/quota/             │
│   - RoleInstance.js   — 单个 claude 子进程 lifecycle             │
│   - SpawnManager.js   — wiring + sendToThread/Direct + event 桥接│
│   - PoolAllocator.js  — 池槽 find/acquire/create/backfill        │
│   - MarkerDispatcher.js — marker → handoff/done/blocked side fx │
│   - HandoffTracker.js — 派工进度 spawning/ready/failed 跟踪      │
│   - ScanRecycler.js   — TTL scanner / stuck unstick / disc 老化  │
│   - streamParser.js   — stdout NDJSON 解析(纯函数 + helpers)    │
│   - MarkerDetector.js — 正则解析 <mate:...> marker(纯函数)      │
│   - PendingSends.js   — mate_pending_sends 表 helper            │
│   - QuotaState.js     — 5h/7d quota 状态机 + setTimer + cron    │
└──────────────────────────────────────────────────────────────────┘
                            ↑
┌──────────────────────────────────────────────────────────────────┐
│  L1 Domain Stores                                               │
│   - projects/ProjectStore.js  — Project CRUD                    │
│   - threads/ThreadStore.js    — Thread CRUD + stage state       │
│   - roles/RoleCatalog.js      — roles/*.md md 解析 + 验证        │
│   - events/EventStore.js      — events 表读路径 + 业务查询       │
└──────────────────────────────────────────────────────────────────┘
                            ↑
┌──────────────────────────────────────────────────────────────────┐
│  L0 Infrastructure                                              │
│   - config.js       — env + paths(纯 export,无副作用)          │
│   - db.js           — SQLite connection + schema + migrations   │
│                       + prepared statements + recordMessage 等   │
│   - messageBus.js   — 进程内 EventEmitter pub/sub                │
└──────────────────────────────────────────────────────────────────┘
```

**依赖方向**:**自下而上 only**,即:
- L0 不依赖任何更高层
- Lⁿ 可以 `require` L0 ~ L(n-1) 的任何模块
- **同层之间允许互相依赖**(扁平),但要避免循环
- L6 frontend **只通过 L4 接口**与后端对话,**绝不直接 `import`/`require` 任何 server 模块**

---

## §4 各模块责任声明(SSOT)

> 每个 server/ 模块顶部都有 `MODULE CONTRACT` 注释块,内容与本节保持同步。Linter 等价物:grep 比对。

### L0 Infrastructure

| 模块 | 责任 | 公共 API | 禁止 |
|---|---|---|---|
| `config.js` | 读 `.env` + 提供 `config` 单例 | export `{ port, httpProxy, paths, globalMaxClaudeProcesses, ... }` | 不在这里跑业务逻辑;不动态修改 |
| `db.js` | SQLite 连接 + schema + migrations + 通用 helpers | export `{ db, stmts, recordMessage, recordEvent }` | 不绑定具体业务实体(那是 L1 的事) |
| `messageBus.js` | 进程内 pub/sub | export 单例 `bus` with `publish(topic, payload)` + `on(topic, handler)` | 不存状态;不持久化(只是 fan-out)|

### L1 Domain Stores

| 模块 | 责任 | 公共 API | 禁止 |
|---|---|---|---|
| `projects/ProjectStore.js` | Project 实体 CRUD | `list / get / create / archive / inspectDir / getByName` | 不调 SpawnManager;不读 stream |
| `threads/ThreadStore.js` | Thread 实体 CRUD + stage state machine | `list / get / create / setStage / setTitle / touch / bindInstance` | 不调 child process;不发 WS |
| `roles/RoleCatalog.js` | `roles/*.md` 解析 + frontmatter 验证 | `load / list / get / central` | 不持久化(`roles/*.md` 即真理);不动态创建角色 |
| `events/EventStore.js` | events 表读路径 + 业务查询(派工时序 / 最近 handoff) | `record / list / listByKind / listDispatchHistory / listRecentHandoffsForProject / countByKind` | 不调 SpawnManager;调用方决定何时 publish bus |

### L2 Process Control

| 模块 | 责任 | 公共 API | 禁止 |
|---|---|---|---|
| `spawn/streamParser.js` | stdout NDJSON 解析 + 通用 helpers | `class StreamParser` + `extractAssistantText / isResultError / extractToolUses` | 不修改 raw event;不管业务(MarkerDetector 是同层但独立模块) |
| `spawn/MarkerDetector.js` | 正则解析 `<mate:handoff/done/blocked />` marker(纯函数,无 IO) | `detect(text) → markers[]` | 不解释 marker 语义(SpawnManager 负责);新 marker 类型 先改本文档 |
| `spawn/RoleInstance.js` | 单个 claude child 的 spawn / send / kill / event 暴露 | class `RoleInstance` + `spawn / sendUserText / kill / on(event)` | 不管池子;不发 bus 事件(SpawnManager 接管);不解析 marker |
| `spawn/SpawnManager.js` | **实例池** + **marker dispatch** + **handoff 状态机** + **TTL/unstick/老化 scanner** + **clientMessageId FIFO** | 单例 + `spawnInstance / sendToThread / sendDirectToInstance / killInstance / restoreFromDisk / startTtlScanner` 等 | 不持久化业务实体(L1);**绝不**替 LLM 决策派工目标 |
| `spawn/PendingSends.js` | `mate_pending_sends` 表薄包装 | `enqueue / listForTarget / remove / count*` | 纯 CRUD,不解释队列语义 |
| `quota/QuotaState.js` | 5h/7d quota 状态机 + setTimer + cron | 单例 + `start / stop / ingest / isPaused / manualOverride / snapshot` | 不读 claude stdin;不管派工(只 publish event)|

### L3 Business Hooks

| 模块 | 责任 | 公共 API | 禁止 |
|---|---|---|---|
| `system-agent/SystemAgent.js` | Haiku 短命 LLM 调用(标题摘要 / reply template / 黄灯判断) | `runStructured(prompt, schema, opts)` | 不替业务角色做决策;成本受控($ cap) |
| `system-agent/ThreadHooks.js` | result event 后跑 SystemAgent 做 metadata 自动化 | `onResultEvent({ projectId, threadSlug, instanceId })` | 不调 SpawnManager;不持久化 message(只更 thread.metadata) |
| `system-agent/envCheck.js` | env 探针(代理 / claude bin / DB) | `runAllChecks()` | 不阻塞 boot |

### L4 API Surface

| 模块 | 责任 | 公共 API | 禁止 |
|---|---|---|---|
| `api/http.js` | REST router 构造 | `buildRouter() → express.Router` | 无内部状态;不直接调 stream(经 SpawnManager) |
| `api/ws.js` | bus → 所有 ws client fan-out | `attach(httpServer)` | 不过滤事件(client 自行过滤);不缓存 |

### L5 Bootstrap

| 模块 | 责任 | 公共 API | 禁止 |
|---|---|---|---|
| `index.js` | 装配 + lifecycle | 无 export(entry point) | 不含业务逻辑;只装配 |

### L6 Frontend

| 模块 | 责任 | 禁止 |
|---|---|---|
| `index.html` / `dashboard.html` | 挂载点 + script 加载 | 不内联业务 JS |
| `app.js` | 主视图(state + WS + render) | 不直接读 SQLite |
| `dashboard.js` | 仪表盘 4 tab + mateTerm | 同上 |
| `components/runtime-chip.js` | 顶栏 chip 组件 | 自包含;不依赖 app.js / dashboard.js |

---

## §5 数据流(典型一轮)

```
user types "..." in input  + clientMessageId (uuid 即时生成,乐观 UI)
   │
   ▼
[browser] POST /api/threads/:slug/message  body={text, clientMessageId}
   │
   ▼
[L4 http]  →  [L2 SpawnManager.sendToThread(...)]
   │             │
   │             ├─ ThreadStore.get → 找 thread
   │             ├─ _enqueueClientId(inst, clientMessageId) FIFO 队列
   │             └─ inst.sendUserText(text)
   │                   │
   │                   ▼
   │             [L2 RoleInstance] child.stdin.write({type:"user",...}\n)
   │                   │
   │                   ▼
   │             [claude headless] processes → stdout NDJSON
   │                   │
   │                   ▼
   │             [L2 StreamParser] line-buffered parse → events
   │                   │
   │                   ▼
   │             [L2 RoleInstance.on('event')] emit per event
   │                   │
   │                   ▼
   │             [L2 SpawnManager._wireListeners]
   │                   ├─ rate_limit_event  → QuotaState.ingest
   │                   ├─ user echo         → 取队首 clientMessageId → recordMessage(返 serverId)
   │                   ├─ assistant         → recordMessage + bus.publish('instance.event', {clientMessageId, serverMessageId})
   │                   └─ result            → ThreadHooks.onResultEvent + MarkerDetector.detect + _handleMarkers
   │
   ▼ ws fanout
[browser]  收到 WS → app.js handleWsMsg
              ├─ user echo + clientMessageId 命中临时 bubble → 不重复渲染
              └─ assistant → renderEventInStream
```

派工(marker → dispatch)子链:

```
[SpawnManager._handleMarkers] detect handoff
   │
   ▼
_performHandoff:
   ├─ resolve target(_parseMarkerTarget)
   ├─ sendToThread(targetRole)  →  acquire pool slot / spawn
   ├─ bus.publish('thread.handoff', { handoffKey, ... })          ← 黄卡片
   ├─ if inst.status === 'busy' → 立即 publish('thread.handoff.ready')
   └─ else 记入 _pendingHandoffReady Map,等 status_change to busy
                  ↓
              publish('thread.handoff.spawning' / '.ready' / '.failed')
                  ↓
              前端 renderHandoffCard(payload, stage) 更新同一张卡片
```

---

## §6 禁止条目(架构红线 · grep 可查)

| # | 规则 | 违例 grep |
|---|---|---|
| 1 | **No file-based handoff** | `fs.write*.*doc/queue` / `fs.write*.*WORK_HANDOFF` / `fs.write*.*doc/_dispatch` / `fs.write*.*terminal_status` |
| 2 | **角色名 / type 不 hardcode** | `=== 'planA-R'` / `=== 'execB'` / `roleName.includes('H')` 等(除 RoleCatalog + stageByTargetType 映射) |
| 3 | **L6 frontend 不直接 require server 模块** | `public/.*require.*server/` |
| 4 | **stream-json raw event 不 mutate** | `raw\.\w+\s*=` in L2 spawn/(读 raw 字段允许,**写** raw 字段禁止) |
| 5 | **markers 是 role→role 唯一通道** | 跨 role instance 直接写 `inst.threadSlug = ...` / `inst._foo = ...` 跨实例数据交换 = 退化(仅 SpawnManager 内部 acquire 时设 threadSlug 允许)|
| 6 | **不缓存业务结论** | mate 数据库里出现 "execB-2 擅长 auth"这种判断字段 = 退化(那是 H 的认知)|
| 7 | **不阻塞 boot** | `await` 在 server/index.js 的 startup 路径 = 退化(改 fire-and-forget + lazy)|
| 8 | **SpawnManager 不调 SystemAgent 直接**(L2 不依赖 L3) | server/spawn/.*require.*system-agent — 应该反过来 |
| 9 | **不在 db.js 写业务语义函数** | `recordMessage` 已经在那是历史包袱(见 arch-debt §4),新加业务 store **必须**去 L1 |
| 10 | **角色定义只能在 roles/*.md** | 别处 `new RoleDefinition` / hardcoded role frontmatter = 退化 |

---

## §7 关键技术铁律(Phase 0 探针实证)

- spawn 后**立即写第一条 stdin**(claude 3s 无 stdin auto-exit)
- 错误判定看 `result.is_error`,**不**信 subtype
- 工具收紧用 `--tools` 白名单,**不**用 `--disallowedTools` 黑名单
- kill 渐进:`stdin.end()` → SIGTERM → `taskkill /F /T`
- session TTL 防生锈(代码改后旧 session 文件认知错位)
- `--resume + stream-json + --fork-session` 兼容,直接续

---

## §8 演进规则

1. 新加模块 → 先回本文档 §3 §4 §6 加位置 + 责任 + 禁止条目;再写代码
2. 修改模块边界 → 先改本文档 + 各 module CONTRACT 注释 → 跑 grep 找受影响处 → 才修代码
3. 新 phase 开始 → 把 phase spec 跟本文档对齐(spec 受本文档约束,不反过来)
4. 完整退化检测(grep + 手工) → `docs/discussions/2026-06-13-arch-debt.md`(技术债清单,不主动消;每 phase 路过相关代码顺手补)

---

## §9 当前架构债务

详见 [`docs/discussions/2026-06-13-arch-debt.md`](./discussions/2026-06-13-arch-debt.md)。

简要:
1. `SpawnManager.js` 1080 行 god class(9 职责)
2. `public/app.js` 954 行 / `dashboard.js` 759 行 单文件巨石
3. L0 `db.js` 含 `recordMessage` / `recordEvent` 业务函数(应去 L1)
4. L2 `spawn/MarkerDetector` 的拓扑位置应该在 L2(纯 stream 应用),目前挂在 L3 system-agent
5. L3 `ThreadHooks` 反向 require L2 `SpawnManager`(循环依赖风险)
6. 缺统一 `EventStore` L1 模块(events 表写散在 db.js,读散在 http.js)
7. role frontmatter 缺 validator(加新字段 silent ignore)

均不阻塞功能,留作 Phase 2F+ 路过时补。

---

**Architecture SSOT · 2026-06-13 锁定 · Phase 2E 完工后**
