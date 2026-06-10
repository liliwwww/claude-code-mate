# 架构设计

> 本文档解释 Claude Code Mate 的**核心架构原则、关键抽象、关键风险**,以及为什么选这样而不是那样。

## 核心原则:升维不再造

Mate 不是新角色,**不替代** R / H / execB / testC 任何一个角色的工作。它干 3 件事:

1. **接入(Input)** — user 单一输入框,识别意图 + 匹配线索 + 路由到对应角色实例
2. **聚合(View)** — 把多个角色的状态/事件/对话聚合成单一视图
3. **协调(Coord)** — BLOCKED / AWAITING_VERIFY 等关键节点主动通知 user,user 拍板后回写信号

底层 claude 子进程之间的"通讯"——即原"协作模式"里靠 `doc/queue/`、`doc/_dispatch/`、`doc/terminal_status/` 文件协议传递的消息——升级为 **mate 内部内存消息总线**(`messageBus.js`)。文件可作为单向人类可读快照保留,但不再是 SSOT。

```
┌──────────────────────────────────────────────────────────┐
│                       USER                                │
│   单一输入框 / 多线索切换 / 验收 / 偶尔看 BLOCKED         │
└──────────────────────────────────────────────────────────┘
                      │
                      │  自然语言 / 验收信号
                      ▼
┌──────────────────────────────────────────────────────────┐
│            Mate(路由 + 视图 + 协调)                     │
│   Project Switcher / Thread Board / Conversation Stream │
└──────────────────────────────────────────────────────────┘
        │           │                │               │
        ▼           ▼                ▼               ▼
┌──────────┬──────────┬────────────────┬─────────────────┐
│  R x N    │  H x 1   │   execB x M    │   testC x K     │
│ (需求)    │ (中枢)   │   (实施)       │   (验证)        │
└──────────┴──────────┴────────────────┴─────────────────┘
```

**H 是中枢**:系统设计、串/并/文件冲突判定、派工权全在 H。Mate 不绕过 H 直接派工。

## 维度区分

Mate 里有两个语义维度,**不能混淆**:

| 维度        | 谁感知       | 在 UI 哪里              |
|-------------|--------------|-------------------------|
| **线索**    | user 一等公民 | 主视图(线索看板)      |
| **terminal/instance** | 系统调度,user 透明 | 系统监控视图(独立模块)|

user 想多讨论一个问题 = 新建线索(系统自动 spawn R),**不是** spawn 多一个角色实例。

## 关键抽象

| 抽象              | 文件                                  | 职责                                                                         |
|-------------------|---------------------------------------|------------------------------------------------------------------------------|
| `RoleDefinition`  | `roles/*.md` + `RoleCatalog.js`       | 角色 frontmatter 元数据(type / parallelism / is_central / TTL / 工具白名单) |
| `Project`         | `projects` 表 + `ProjectStore.js`     | 一个被管理的 sibling 项目(name / root_dir / settings)                       |
| `RoleInstance`    | `server/spawn/RoleInstance.js`        | 一个活的 claude 子进程,绑定 (project, role, [thread])                       |
| `Thread`(线索)   | `threads` 表(Phase 2B 使能)        | user 的需求实体,slug + 阶段状态机 + 元数据                                  |
| `SpawnManager`    | `server/spawn/SpawnManager.js`        | per-(project, role) 实例池,acquire / release / recycle / kill              |
| `StreamParser`    | `server/spawn/streamParser.js`        | claude stdout NDJSON 容错解析                                                |
| `MessageBus`      | `server/messageBus.js`                | 进程内 pub/sub,topics `instance.*` / `thread.*` / `dispatch.*` / `block.*` |
| `IntentRouter`    | (Phase 2C+)                          | user 输入意图识别 + 线索匹配 + 路由                                          |

## 进程模型

每个 claude 子进程通过 **`child_process.spawn` 数组参数**启动(永远不用 shell 拼字符串,避开 PS 转义陷阱):

```js
spawn('claude', [
  '-p',
  '--input-format',   'stream-json',
  '--output-format',  'stream-json',
  '--verbose',
  '--include-partial-messages',
  '--replay-user-messages',
  '--include-hook-events',
  '--permission-mode', 'dontAsk',
  '--tools',           role.allowedTools.join(' '),
  '--settings',        JSON.stringify({permissions:{allow: role.allowRules}}),
  '--session-id',      preallocatedUuid,
  '--name',            `${roleName}#${shortId}`,
  '--add-dir',         project.root_dir,
  '--append-system-prompt', composedRolePrompt,
], {
  cwd: project.root_dir,
  env: { ...process.env, HTTP_PROXY, HTTPS_PROXY, NO_PROXY: 'localhost,127.0.0.1' },
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
});
```

**几条铁律**(全是 Phase 0 探针实证得出):

1. **spawn 后立即写第一条 stdin**(claude ~3s 没拿到 stdin 就静默退出,exit 0,stdout 0 字节)
2. **错误判定看 `result.is_error`,不信 `subtype === "success"`**(代理失败时 subtype 仍是 success 但 is_error: true)
3. **工具收紧用 `--tools` 白名单,绝不用 `--disallowedTools` 黑名单**(Windows 上有 Bash + PowerShell 两个 shell 工具,黑名单总有遗漏)
4. **kill 渐进升级**:`stdin.end()` → wait 2s → `child.kill('SIGTERM')` → wait 2s → `taskkill /F /T /PID`

完整协议细节见 [stream-json-protocol.md](./stream-json-protocol.md)。

## 跨进程线索接续 / 重启恢复

**线索的真理在 SQLite,不在 claude 进程内**。这是 mate 抵御 claude 进程崩溃 / mate 重启 / session 生锈的核心。

### 线索一生

```
thread.slug          (logical entity in mate)
   │
   ├── messages: [m1, m2, m3, ...]    (持久化在 sqlite messages 表)
   └── claudeSessionId: "abc-..."     (claude 在 ~/.claude/projects/<cwd>/<id>.jsonl 自己也存)
              │
              └── child process pid 12345   (短命资源,死了不丢失上下文)
```

### Mate 重启时

- 启动期 `SpawnManager.restoreFromDisk()` 扫 SQLite 非 dead 实例
- 每条记录构造一个**没有 child 的** `RoleInstance`,status = `disconnected`
- UI 看到这些 disconnected 实例(💤),user 视角"对话还在,可以继续"
- user 给 disconnected 实例发消息 → 自动 spawn 新 claude + `--resume <sessionId> --fork-session` 续上

### Claude 进程 crash

- `child.on('exit')` 触发,实例 status → `dead`
- 但 `claudeSessionId` 还在 mate 数据库 + claude 自己的 jsonl
- 下次 user 通过线索(Phase 2C 起)发消息时,SpawnManager 自动 acquire 一个新 RoleInstance + resume

### Session TTL(防生锈,Phase 2C 实施)

代码改动 → 旧 session 里读过的文件内容、grep 结果在新代码下**事实错误**。所以 session 4h 没动过就该让它过期:

- 每角色独立 TTL(role frontmatter `session_ttl_hours`,默认 4h,R/H 8h,B/C 2h)
- rolling 计时:每条 user/assistant message reset 计时
- acquire 时 lazy check;background recycler 主动扫描即将到期
- 过期后:thread 不动,但**不**走 `--resume` —— 全新 session,让 claude 重新读最新 queue/handoff/代码

## 多 project 模型

**每个 project 是 first-class 资源**:

- `projects` 表:id / name / root_dir / settings_json / created_at / archived_at
- 所有 threads/role_instances/messages/dispatches/events 通过 `project_id` 外键归属
- 同一 mate 可以同时管:Mate 自己 + sibling kb_backend + web_gmail + ...
- 每个 project 一个独立 (role, instance) 池子(parallelism limit 按 project 算)
- (Phase 2D)全局并发 cap 防 5 project × 4 execB → 20 claude 进程压垮机器

UI 顶栏 project 切换器 + "+ 添加项目" 对话框(可路径输入,inspect 自动识别 `.claude/`、`.git/`、`package.json`、`CLAUDE.md`)。

## 角色定义集中化

**角色 markdown 定义集中在 mate `roles/<role>.md`**(对 sibling 项目透明):

- Mate 通过 `--append-system-prompt <role.body>` 注入角色身份
- sibling 项目 **不需要**装 `.claude/commands/<role>.md`
- 加新角色 = 加 markdown 文件 = 重启 mate(Phase 5 可热加载)

frontmatter schema 见 [role-authoring.md](./role-authoring.md)。

## 数据流(典型一轮)

```
user types "<some text>" in input
   │
   ▼
[browser] WS send: {type:'user_input', text, projectId, threadSlug?}
   │
   ▼
[backend] IntentRouter (Phase 2C+) — match text to thread, decide role
   │
   ▼
[backend] SpawnManager.acquire(projectId, role, threadSlug)
            ├─ idle instance available?     → reuse
            ├─ disconnected with this slug? → lazy spawn + resume
            └─ none under cap?              → spawn fresh
   │
   ▼
[RoleInstance] child.stdin.write({type:"user", message:{role:"user", content:[{type:"text", text}]}}\n)
   │
   ▼
[claude headless] processes → stdout stream-json events
   │
   ▼
[StreamParser] line-buffered NDJSON parse
   │
   ▼
[messageBus] publish('instance.event', {projectId, instanceId, eventType, raw})
   │           publish('message.append', {threadSlug, projectId, ...})
   │
   ├─→ [db] recordMessage(...)        持久化
   │
   └─→ [WebSocket fanout] push to browsers
              │
              ▼
        [browser] render in conversation stream + update board state
```

## Phase 0 影响架构的关键发现

| 发现                                                | 架构含义                                                         |
|-----------------------------------------------------|------------------------------------------------------------------|
| stdin 必须 spawn 后立即写入                          | RoleInstance.spawn 同步阶段构造首条 stdin,不等 init             |
| stdin schema 是 Anthropic Messages API envelope     | `buildUserMessage()` 工具函数统一构造                            |
| `--resume + stream-json + --fork-session` 完全兼容  | 跨进程线索接续直接走 resume,无需 history-replay fallback        |
| `result.is_error` 才是真错误信号                    | `streamParser.isResultError(ev)` 严格走这个判断                  |
| `rate_limit_event` / `system/thinking_tokens` 等新事件 | StreamParser 设计成默认透传 + 已知类型显式处理                |
| 工具白名单严格,黑名单不可靠                         | RoleInstance 的 `--tools` 永远从 role.allowedTools 白名单出      |
| `--permission-mode dontAsk` + `--settings` allow 必须配套 | RoleInstance 同时给两者,缺一会拒                            |
| 进程树 kill 需要 `taskkill /F /T` 兜底              | RoleInstance.kill() 实现三级升级                                  |

## 当前未实现的限制

- **无 H 自驱 `/loop` 集成**(Phase 3 计划)
- **无线索看板**(Phase 2B 计划)
- **无智能意图路由**(Phase 2C 计划)
- **无系统监控独立视图**(Phase 2D 计划)
- **无认证 / 多 user**(本工具仅设计单机使用)
- **仅 Windows 原生测试**(macOS / Linux 欢迎适配 PR)
