# Changelog

[English version](./CHANGELOG.en.md) · 所有重要改动记录在这里。版本格式遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/),改动类别参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.4.0] — 2026-06-15 · 首个 GitHub release(i18n + Phase 2E/2F/2G 累积)

**首次 git tag 发布**。涵盖自 Phase 2C 之后 ~3 个月的累积工作:角色系统从 planA-* 改名 mate-R/H/B/C,marker 派工协议落地,主视图 Phase 2F 平滑性改造,日志流 tab,session TTL 默认 720h(实质永不过期),per-role/per-instance 模型切换,以及本次发布的国际化(中英文)。

### 新增 · 国际化 i18n(本次重点)
- **支持中文/英文** 切换 — 顶栏新增「中/EN」按钮,localStorage 持久化,无需重启 mate
- `public/components/i18n.js`:核心 i18n 运行时(`t()` / `setLang()` / `applyDom()` / `onChange()`)
- `public/components/messages.js`:238 个 key,中英文完全对称
- HTML 用 `data-i18n` / `data-i18n-attr-<attr>` 声明翻译
- JS 用 `t('key', {params})` 调用;切换语言时自动 re-render 主视图 + dashboard + chip
- 覆盖率:
  - 100% — index.html / dashboard.html / runtime-chip.js
  - ~80% — app.js(高频 UI 路径全部翻译)
  - ~70% — dashboard.js(主要 tab + 交互)
- 不翻译:`roles/*.md`(给 LLM 的 prompt)、后端错误消息、console.log、代码注释、`答:` 协议字段

### 新增 · 角色 / 派工(2E/2F 累积)
- **角色重命名**:`planA-R/planA-H/execB/testC` → `mate-R/mate-H/mate-B/mate-C`,mate 跟 sibling project 角色定义彻底分离
- **Marker 派工协议**:`<mate:handoff target="..." reason="..." />` / `<mate:done summary="..." />` / `<mate:blocked question="..." severity="..." />`
- **派工状态机卡片**:pending → spawning → ready → failed,主视图实时显示
- **PoolAllocator + ScanRecycler + HandoffTracker + MarkerDispatcher** 拆分(Phase 2E arch §1.4)
- **Marker 失败可观测性**:malformed marker 单独事件 + 测试 fixture 17 个 adversarial case
- **eventType 谓词中心化**(arch-debt §14):`isResult`/`isAssistantFinal`/etc

### 新增 · UI / 主视图(Phase 2F 平滑性)
- **流式 assistant 气泡默认折叠**(§16),`<details>` 包裹,字数实时计数
- **流式渲染开关**(§17):conv-header 加 `📺 实时` checkbox
- **busy 时输入框 disable + 红色 ■停止 按钮**(§18):`POST /threads/:slug/stop`
- **LLM 等待 indicator**(§19):`⌛ 等待 LLM 响应... <秒数>`
- **system noise 静音**:`hook_started`/`hook_response`/`status` 不进主对话流
- **派工沉默修复**(§10):4 阶段 handoff card,失败也提示
- **user bubble dedup**(§12 + §15):乐观 UI 立即渲染,WS echo 通过 clientMessageId 去重
- **chip busy term inline currentActivity**:`busy:[H-1 · 🔧 Grep]`
- **线索 ID copy 按钮**:左板每行 + conv-header 旁,一键复制 slug
- **tool_result 折叠琥珀色块**:之前误显大段蓝色 user bubble,现在跟 tool_use 配色一致

### 新增 · Dashboard / 系统监控
- **第 5 tab 日志流**:全局聚合所有 claude 终端 stream 事件,4 维过滤(实例/线索/类型/时间窗)+ 文本搜索 + WS 实时追加
- **终端实时加 model 列**:9 列布局,model 改为下拉选择
- **skill / slash 指令对话框**:每行 skill 按钮 → 弹窗 8 个常用 slash + 自由输入
- **批量 instance 操作 endpoint** `POST /api/instances/:id/slash` + `POST /api/instances/:id/switch-model`

### 新增 · model 切换
- **role frontmatter 加 model 字段**:每个 role 可指定 claude model(如 mate-R 用 haiku 省钱)
- **per-instance 运行时切换**:dashboard 下拉框 → `inst.preferredModel` 覆盖 → kill child → 下次 sendUserText 时按新 model 起 fresh session
- **schema 加 model**;`buildSpawnArgs` 支持 `modelOverride`

### 新增 · TTL / Session
- **默认 session TTL: 4h → 720h**(30 天,实质永不过期),user 反馈日常 claude session 不需要自动过期
- `role.session_ttl_hours` schema max 168 → 8760(1 年)
- ENV `DEFAULT_SESSION_TTL_HOURS` 仍可覆盖

### 新增 · 工具
- `scripts/kill-port.ps1` 加 **busy 检查**:kill mate 前先扫 busy/spawning 实例,非交互模式拒绝默 yes(防误杀)
- `POST /api/threads/:slug/retry-handoff`:marker 派工卡住时手动 trigger,不用从新线索来

### 改进 · 工具权限
- **mate-R 砍 Edit/Write**,加"shell 不许写文件"硬约束 — R 只查不改
- 4 个 role 都加 `mcp__ssh-monitor__*` 工具(可选用)
- mate-H/mate-B/mate-C 默认含 Bash + PowerShell

### 改进 · 架构
- **mate 文件不许写到 sibling project**(架构红线 §11)
- **arch-debt §12-§15** 全部完成:adversarial fixture + marker 可观测性 + 谓词中心化 + marker 协议设计审视
- **§5 reading model 已上,改 model 留下轮**

### Bug 修复
- `currentActivity:[object Object]` 修复(`texts.map(t=>t.text||'').join`)
- thread 自动 title 摘要漂移:user 显式设的 title 加 `metadata.title_locked=true`,SystemAgent 不再覆盖
- model 切换 `/model slash` 不灵 → 改 kill+respawn 路径
- `sendUserText` disconnected + sessionId=null 不再抛错(switchModel 路径打通)
- `result/*` event 在前端漏渲染(`=== 'result'` → `startsWith('result')`)
- §18 红 ■停止 按钮 claude 完 turn 后不还原,得切线索才翻绿(`status_change` WS 分支漏 `applyBusyUiState()`)
- marker regex truncation:reason 含 `"` 会截断 → 改 `.*?` 非贪婪 + `s` flag

### 已知限制(下个版本目标)
- **多 R 派工给同一 H 时无队列、无并发追踪**:H `parallelism_limit: 1`,busy H 收第二个 marker 直接写 stdin,`inst.threadSlug` 被覆盖导致 thread1 状态灯熄(详见 docs/discussions/2026-06-15-multi-r-handoff.md)
- **PendingSends 表存在但未启用**:Phase 2D 未完成的队列化派工

## [0.5.0] — 2026-06-27 · stack-model SSOT + 反幻觉 + 429 自动恢复 + 派工链护栏

`v0.4.0` (2026-06-15) 之后的 50+ commits。三大主题:**派工状态机改 chain SSOT 派生**(根治累积漏洞)、**反幻觉系列**(marker 是唯一认证 + 状态查实)、**429 server-side throttle 自动到点恢复**。

### 新增 · 栈模型架构(stack-model RFC 全 5 phase)

栈模型替代事件日志做派工状态 SSOT。详细 RFC 见 [`docs/discussions/2026-06-16-stack-model-rfc.md`](docs/discussions/2026-06-16-stack-model-rfc.md)。

| Phase | Commit | 内容 |
|---|---|---|
| 1 数据并行 | `a4b4efd` | DB migration v11 (call_stack_json + outcome) + ThreadCallStack + SlotPool 模块 + 48 单测 |
| 2.1+2.2 replay | `3080ad5` | 老 chain replay 算法 + migration 脚本 |
| 2.3 校验 | `c991096` | kb_knowledge session_id 保留校验工具 (0 可疑 lost) |
| 3 SSOT 切换 | `c85982c` | MarkerDispatcher 直接操作栈,删反向扫 chain 找 caller 算法 |
| 3.6 重构 | `18b035f` | 栈完全从 chain replay 派生(消除累积漏洞)|
| 4 协议升级 | `f271852` | `<mate:bounce reason="..." />` 替代 `<mate:handoff target="mate-R" />`,语义专用 |

**user 痛点驱动**:
- 6/16 上午:H 死循环 bug (chain[7-10] 4 个错位 done),根因是反向扫 chain 找 caller 时把 callback 当原始派工。`770ec88` 修了 caller 查找算法,Phase 3 后从根本上换栈 SSOT 不再有这类风险。
- 6/16 下午:多个 breadcrumb 显示 bug (R→B 缺 H / empty / depth 计算错),根因前端从事件流重建栈太脆弱。Phase 3 后栈是 SSOT 直接读。

### 新增 · 派工文件落盘(2026-06-19 user 立场反转)

| Commit | 内容 |
|---|---|
| `84f8811` | 派工记录自动落到 `<project>/doc/dispatch/<task_slug>_<NNN>_<from>_to_<to>_<ts>.md` |

**user 痛点**:老 file-based 模式留了 270+ `WORK_HANDOFF_*.md` 在 `kb_backend/doc/` 可 grep 追溯,mate 上线后只 in-memory + DB,后续 term spawn 进项目无法独立读派工历史。**user 立场转变**:之前要求 "mate 文件不要侵入被管理项目",现在反过来要求"`doc/` 本来就是过程文档目录,派工记录该归在那"。

- threads 表加 `task_slug` 字段,R 派工时设(`<mate:handoff task_slug="adr006_action_extract" />`)
- projects 表加 `dispatch_log_enabled`,kb_knowledge 默认开
- callback / done / blocked / reject 追加 section 到对应 push 文件
- E2E 11 测全过(含 `10-dispatch-log.spec.js`)

### 新增 · E2E 自动化测试套(Playwright)

| Commit | 内容 |
|---|---|
| `345167a` | mock term (MockRoleInstance) + Playwright config + 5 个核心场景 |
| `610bc46` | 5 个边界场景(bounce / 干预 / 直连 / restart / 多线索 skip)|

10 个 spec,11/11 全过(2 skip 多线索为 Phase 3 待解),~50 秒跑完。为 Phase 3 SSOT 切换提供回归护栏 — 没这套不敢做大重构。

### 新增 · 反幻觉派工 prompt (2026-06-18)

| Commit | 内容 |
|---|---|
| `516c9aa` | mate-R.md + mate-H.md 加 "CRITICAL — Marker emit 是唯一认证" 节 |

**user 痛点**:线索 t-mqfgby8l-bxlt R 收到 user "选 A 方案" 后,assistant 文字里写 "已派工给 H",但末尾没 emit `<mate:handoff>` marker → chain 不增长 H 没收到。LLM **嘴上说派了实际没真触发**。

- 加 5 步自检清单
- 强调"说 ≠ 做",任何要 mate 触发动作必须以对应 marker 收尾

### 新增 · 反幻觉报状态 — mate API 查实 (2026-06-19)

| Commit | 内容 |
|---|---|
| (本次) | task tag 加 Project: id + mate-R/H/B/C.md 加 "CRITICAL — 报状态前必须查 mate API" 节 |

**user 痛点**:H 完工 done 后,_performDone 没把 callback 注入回 R(backlog #162),R 0 event 间 user 问"线索状态",R 凭 conversation history 编"H 正在跑等回调",**完全脱节于 mate DB 真实状态**(已 verified)。user 顿悟:"如果 mate 在管理所有终端的状态,就应该让 term 在确认前读取 mate 状态。这样更准确"。

- task tag 从 `[Thread: t-xxx]` → `[Thread: t-xxx | Project: 6]`,role 拿到查询所需参数
- R 强制规则:任何 "状态/进度/谁在跑" 问题 → 先 curl `/api/threads/<slug>?projectId=<id>` → 凭 stage / outcome / chain[末] 答
- H 报状态前同样查实
- B/C 引用其它 thread 状态时查实
- 治标也兼治本:即使有 callback 注入失败 bug,role 也会因查实而不再幻觉

### 新增 · server-side 429 自动到点恢复(2026-06-26 ~ 27)

| Commit | 内容 |
|---|---|
| `497a11a` | QuotaState 识别 `{status:"rejected"}` 边界 RLI — 借 5h resetsAt 触发 PAUSED + setTimer |
| `df1f2e4` | paused 期间 send 入队 PendingSends(reason='quota_pause')+ resume 后自动 FIFO flush |

**user 痛点**:碰到 `api_error_status=429 API Error: Server is temporarily limiting requests` 后 UI 显 ERROR,需要手动重发;mate 现有 QuotaState 系统(5h/7d 配额) 不接这种 server-side throttle 因为 RLI schema 不一样(无 type、无 resetsAt)。

- 真因:claude 在 429 前 6 秒推过 RLI,载荷只 2 字段 `{status:"rejected", isUsingOverage:false}`,QuotaState.ingest line 103 unknown type 直接 return → 完全丢弃 → 没人挂 timer
- 修法 ①:`_ingestServerReject` 借 byType['five_hour'] 的 resetsAt 当 pause 截止;无 5h 历史 → fallback 5min。走现有 `_performPause` 路径(setTimer + cron + 广播 banner)
- 修法 ②:`sendToThread` / `sendDirectToInstance` 加 `QuotaState.isPaused()` gate,paused 时入 PendingSends(`reason='quota_pause'`);`bus.subscribe('system.quota_resumed')` 触发 `_flushQuotaPaused()` 按 enqueuedAt FIFO 顺序逐条 dispatch
- 全局自动恢复:5h/7d 都是账户级,所有 term 同时解禁;入队的 marker 顺序保留,栈一致性不破

### 新增 · 派工链 UI 跟服务端栈算法对齐(2026-06-27)

| Commit | 内容 |
|---|---|
| `77a961b` | 前端 renderBreadcrumb 跟服务端 replayChain._applyHandoff 算法同步 — push 时沿栈找 from,截到那层不再补 push |

**user 痛点**:线索 t-mqmi7hu3-hxf1 顶栏面包屑显示"派工链越来越长"。查 163 段 chain:服务端栈 depth=2 R/H ✓ vs 前端栈 depth=**16** R/H/C/R/H/C/R/H/B/R/H/R/H/R/H/B ✗。

- 真因:6/24 `dc416c5` 修 replayChain 算法时漏了前端同款 `renderBreadcrumb`,user 每次在 B/C 长任务跑中打断又派新工时,前端栈累积 R/H/X/R/H/X/...
- 修法:前端 push 分支 sync 服务端 — 栈顶 != from 时先 `findIndex(fromInstanceId)` 沿栈往下找,找到 `stack.length = fromIdx + 1` (pop abandoned),没找到才补 push from
- 实测 163 段 chain:depth 16 → 3

### 新增 · chip popover 排队项可读化(2026-06-27)

| Commit | 内容 |
|---|---|
| `6ecf724` | 顶栏 chip 排队详情:displayName + 线索 title + reason + 派工源 + kind/status 色块 |

**user 痛点**:顶栏 chip "排队:1" 点击 popover 只显内部 id (`mate-B.ewap6k`),看不出是哪个 term/哪条线索在排队。

- server `/api/runtime/snapshot` byTarget 项补字段:`targetDisplay` / `targetRoleName` / `targetStatus` / `threadTitle` / `reasons[]` / `kinds[]` / `fromInstances[]`
- popover 新格式三行:`**mate-B-1** [mate-B] [busy] × 1` / `线索:[AI 报告]` / `来自:mate-H-1` / `[派工] [⏳ 目标 busy]`
- reason 区分 busy / quota_pause / spawning,kind 区分 handoff/thread_send/direct_send

### 修复 · stack-model SSOT 切换后的边界 bug

| Commit | Bug 现象 | 修法 |
|---|---|---|
| `8197a42` | 线索 verified 后 R 没收到 H 完工 callback,R 凭 stale history 编状态 | `_performDone` R-notify 条件 `callerRoleType==='requirements'` 但实际值是 `'mate-R'` 字符串错配,改 OR 同时认两种 |
| `dc416c5` | 线索 t-mqmi7hu3-hxf1 栈 8 层 R/H/C/R/H/C/R/H | `replayChain._applyHandoff` self-heal 改:栈顶 != from 时沿栈找 from 截到那层(pop abandoned),不再补 push 累积 |
| `06fd6af` | dashboard 状态图 H/B/C 不显示 | `/api/runtime/snapshot` push 字段时漏 projectId,前端按 scope 过滤一锅干掉。补字段 + 默认显所有 term |
| `c7de54f` | user 上滑看历史时被新消息自动滚动打断 | 加 `streamAutoScroll(force)` helper,user 在底部 60px 内才滚,离底浮"↓ 跳到最新"按钮 |

### 修复

| Commit | Bug 现象 | 修法 |
|---|---|---|
| `94f012b` | 老线索 (5000+ 消息) UI 看不到最新输入和 LLM 输出 | history API 改 ORDER BY ts DESC + reverse 取最新 N 条 |
| `63d7b84` | EVENTS 顶栏不停闪烁 (instance.ttl_expired 事件) | 4 个 role md `session_ttl_hours: 0` 跟 commit `15dc6eb` (TTL→0) 一致 |
| `7111f1b` | LLM 想用 kb MCP 查 merchant_info 被 dontAsk 拒,绕道 Bash + SQL | H/B/C `allowed_tools` 加 `mcp__kb__*` |
| `770ec88` | H 死循环 (chain 4 个错位 done) | _performDone 找 caller 跳过 callback handoff |
| `913a787` | verified 线索/被复用实例 误锁输入框 | isFocusedThreadBusy 看 inst.threadSlug 是否还属当前 thread |
| `8c81936` | 改完代码刷新看不到 (浏览器静态缓存) | Express no-cache header for js/css/html |
| `caa20a5`+ `be60fb2` + `c74a78c` + `1c6a586` | breadcrumb 显示一系列 bug | call stack 视图自愈缺帧 + isTerminal 兜底 + push vs pop 区分 |
| `5855079` | dashboard graph R 不显示 (R per-thread 都 disconnected) | 状态图 R 单独逻辑无视 showDisc 过滤 |

### 改进

| Commit | 内容 |
|---|---|
| `8dd5f05` | dashboard 对话控制 tab 显示模式从"按 thread/direct 过滤"改"显该 instance 全部交互" |
| `34d8078` | 终端实时按 project / status / role 排序 + 分组 |
| `de7a6b8` | 状态图范围下拉动态拉所有 project |
| `339ceab` | mate-B.md 强化"长任务必须转 C"约束(B 自己跑 ARK proxy batch 11min 是违规) |

### 设计文档

| 文档 | 内容 |
|---|---|
| `docs/discussions/2026-06-16-stack-model-rfc.md` | 栈模型 RFC,8 个边界场景 + 5 phase migration |

### 进行中
- **Phase 2D:池化 H 架构 + 任务跟踪 + 仪表盘 4 tab**(2026-06-12 大讨论 + audit 后冻结)
  - 详细决策见 [docs/discussions/2026-06-12-pooled-h-task-tracking.md](docs/discussions/2026-06-12-pooled-h-task-tracking.md)(§1-§8 全冻结)
  - **架构**:1 个全局 H + 1 R per thread + 池化 execB/testC(默认各 2,长期存活,不 kill/disconnect/clear)
  - **专长机制**:claude auto-memory 替代,**砍工程化专长摘要**
  - **Marker 协议升级**:支持具体 instance(`target="execB-2"`)+ 泛型(`target="execB"`);优先级 `done > blocked > handoff`
  - **execB/testC 砍掉 `<mate:blocked />`**:决策统一 handoff to H,H 判断能否自答
  - **稳定 slot 名**:`pool_slot` 字段,跨重启不变(`--resume` 续 jsonl)
  - **H 任务调度**:task board snapshot 注入 + request queue 串行化(user > auto-handoff)
  - **inst 状态拆分**:`threadSlug`(R 1:1 绑定)+ `currentTaskSlug`(pooled 角色 per-task 动态)
  - **仪表盘 4 tab**:终端实时(含 memory 状况)/ 任务队列 / H 派工时序 / NL 控制面板(白名单 action + 二次确认)
  - **System thread (singleton)**:hidden system project (id=0) + 固定 slug `mate-self` + 新角色 mateBot,承载 user 跟 mate 自己的对话,持久化
  - **全局 cap soft**:超 16 实例 queue + banner,不硬拒
  - 实施 ~8 天(详细工时表见 sediment doc §8)

### 砍掉
- ~~**Phase 3:H 自驱 `/loop`**~~(2026-06-12 决定砍)
  - 评估者(sibling planA-H 终端)列 P0,理由是他在 sibling 没有看板需要 H 自己续推
  - Mate 仪表盘给 user "0 成本巡视"能力,覆盖 /loop 真实价值的 95%+
  - 剩余 5% 边缘场景(H mid-thought 停 / 长时间无 marker / 跨线索打扫)user 在仪表盘手动 ping 即可
  - 省 3-5 天 + 减少无人值守风险面

## [0.3.1] — 2C+ 增量(2026-06-11)

User 实测后 4 条反馈,小迭代修正:

### 改进
- **回答模板改成问题清单**(§1):reply-template task 的 schema 改成 `{has_questions, questions: [{question}]}`(原来给"建议答案",user 反馈要"列出所有要回答的问题、留空白"),前端预填格式为 `Q1: ...\n答:\n\nQ2: ...\n答:`,占用 textarea + 自动 focus
- **统一"等用户回答"信号 = 黄灯**(§4 bug fix):之前只有 `<mate:blocked />` marker 触发黄灯,R 普通追问没触发。现在 `thread.metadata.has_pending_question`(SystemAgent 识别)和 `metadata.blocked`(marker 触发)都让线索看板黄灯闪烁。user 发新消息时 SpawnManager 自动清除 `has_pending_question`(回答了 → 灯熄)
- **终端管理 modal**(§2):顶栏新增 "终端 (N)" 按钮(N = 当前活实例数,实时更新),点击弹 modal 列**跨所有 project** 的所有 claude 实例(可勾选包含 dead),显示 id / role / project / pid / sessionId / 绑定 thread,可一键 kill
- **顶栏下方动态事件流**(§3):顶栏下面一条窄高度 marquee(36px 高),实时显示 spawn / kill / handoff / done / blocked 事件,新事件 slide-in 动画 + 4s 高亮,最多保留 5 条,事件类型按颜色区分(绿 = spawn/done,红 = kill,紫 = handoff,黄闪 = blocked)。前缀 `[EVENTS]` 带发光 badge

### 新增 API
- `GET /api/instances/all?includeDead=0|1` — 跨 project 列实例(终端管理 modal 用)
- WS event `thread.metadata_updated` — 当 has_pending_question 翻转时广播,前端重算状态灯

## [0.3.0] — Phase 2C 完成(2026-06-10)

详细需求 / 14 个细节问答见 [docs/discussions/2026-06-10-phase-2c-needs.md](./docs/discussions/2026-06-10-phase-2c-needs.md)。

### 哲学升级
- **mate 流程不引入"user 验收"节点**:H 自验通过 = 流程到头 = IDLE,业务验收 user 自己浏览器实测
- **角色切换对 user 完全透明**:对话流统一,不画分割线,不弹通知,只有 BLOCKED 才打断 user
- README 项目介绍重写:"one chat, a team of specialized agents"

### 新增
- **System Agent**(`server/system-agent/SystemAgent.js`):mate 内置 LLM 服务,用 `claude --model claude-haiku-4-5 --no-session-persistence --tools "" --json-schema`,短命 spawn 服务结构化输出微任务。三个 task:title-summary / reply-template / blocked-detection。
- **环境检测按钮**(`server/system-agent/envCheck.js` + `/api/system/healthcheck`):4 项探针(claude binary / 代理 / SQLite / auth+API),手动触发,失败不阻塞。
- **Markdown 渲染**(public/index.html + app.js):marked + highlight.js(10 语言) + KaTeX,assistant 输出走完整 markdown,代码块加 copy 按钮。
- **亮/暗主题切换**(style.css CSS vars):默认 prefers-color-scheme,手动 override localStorage 锁定;highlight.js 主题同步。
- **自动 slug + title 摘要**(ThreadStore + ThreadHooks):新线索无 slug 字段,自动 `t-<base36>-<rand>`;首轮 + 每 5 轮 SystemAgent 摘要 12 字标题。
- **自动回答模板**(ThreadHooks):每轮 result 后 SystemAgent.generateReplyTemplate,有问题则 WS 推送,前端输入框空才填。
- ⭐ **自动状态机驱动**(MarkerDetector + SpawnManager.\_handleMarkers):
  - R/H/B/C 的 roles markdown 加 marker 教学:`<mate:handoff target="..." />`、`<mate:done />`、`<mate:blocked question="..." />`
  - `MarkerDetector` 从 assistant 文本提取 markers
  - 在 result event 时自动 handoff:spawn 下一角色 + bind thread + 推进 stage + 把 thread 上下文作为 first stdin 传给新角色
  - `<mate:done />` → stage=verified(线索结束,实例 IDLE 等待 user 下一条指令)
  - `<mate:blocked />` → metadata.blocked + WS 推送
  - 实测:R 输出 handoff 后 19s 内,H 自动 spawn + bind + stage 翻 designing
- **状态灯**(status light):
  - 🟢 绿 = 任一实例 busy / spawning(后台干活)
  - 🟡 黄(闪烁)= thread.metadata.blocked 存在(等 user 拍板)
  - 🔴 红 = 任一实例 dead(异常)
  - ⚪ 灰 = idle / 无活动实例
- BLOCKED 时对话流追加高亮卡片显示问题;handoff 时显示小灰条隐式切换;done 时显示绿色"✓ 线索完成"卡片

### 改进
- 角色定义 markdown 集中在 mate(`roles/*.md`),sibling project 透明
- result event 触发条件改成 `eventType.startsWith('result')`(原 `=== 'result'` 漏匹配 `result/success`)

### Bug 修复
- `--bare` 不能跟 Max 订阅 OAuth 共存(它要求 `ANTHROPIC_API_KEY`)→ SystemAgent 改成 `cwd=mate root` + `--no-session-persistence` 实现隔离
- SystemAgent JSON-schema 输出在 `structured_output` 字段(不是 `result`)

## [0.2.0] — Phase 2B 完成(2026-06-10)

### 新增
- **线索(thread)成为主视图一等公民**:`threads` 表使能,左侧线索看板替代 Phase 1 的实例列表
- **6 阶段状态机**:discussing → designing → executing → testing → verified → closed,每条线索独立追踪
- `server/threads/ThreadStore.js`:CRUD + 阶段切换 + 元数据补丁(`current_role_instances` / `last_session_activity_at`)
- 5 个 `/api/threads` REST endpoints:list / create / get / patch(stage/title) / history / send-message
- **懒 spawn**:`SpawnManager.sendToThread` — 首条消息才 spawn R 并绑定到线索,**无 greeting 浪费**
- 前端"+ 新线索"对话框(slug + title)取代 Phase 2A 的 spawn dropdown
- 阶段切换 dropdown(在对话框头部)
- 焦点线索 localStorage 持久化(切换 project 不丢)

### 改进
- `RoleInstance.spawn` 支持 `suppressGreeting + _pendingUserText`,允许首条 stdin 直接是 user 内容
- WebSocket 事件按 `threadSlug` 派发到正确的对话流

### 修复
- **parallelism limit 误判**:`disconnected` 状态不再占用名额(它们无 child process,只是历史占位),解决"5 个老 R 占满 → 新线索 spawn 被拒"的连锁问题

## [0.1.0] — Phase 2A 完成(2026-06-10)

### 新增
- **多 project 支持**(`projects` 表,顶栏 project 切换器,添加/导入项目对话框)
- 所有资源(threads/role_instances/messages/dispatches/events)加 `project_id` 外键
- `/api/projects` REST(list/create/archive/inspect)
- 项目目录 inspect 接口可以识别 `.claude/`、`.git/`、`package.json`、`CLAUDE.md`
- SpawnManager 改 (projectId, roleName) 二元组绑定,parallelism limit 按 project 隔离
- 角色定义集中在 mate `roles/*.md`,通过 `--append-system-prompt` 对 sibling project 透明
- **lazy resurrection**:server 重启后非 dead 实例被恢复为 `disconnected`,user 发消息时自动 spawn + `--resume` 续上
- **schema v1 → v2 迁移**(自动,无需手动操作)

### 改进
- 实例 ID 改用 `.` 分隔(原 `#` 在 URL 里被截断)
- result 事件错误判定:看 `is_error` 而非 `subtype`(Phase 0 探针发现)
- 角色 frontmatter `allow_rules` 跟 `allowed_tools` 配套,二者都要给(Phase 0 探针发现)

## [0.0.x] — Phase 0 + Phase 1

### Phase 1 — SpawnManager + 最小观察台
- Node + Express + WebSocket 后端骨架
- SQLite(`better-sqlite3` + WAL)持久化对话历史
- 角色定义 markdown + frontmatter(gray-matter 解析)
- streamParser:NDJSON 行缓冲 + 单行 >1MB 防御
- graceful kill 三级升级(`stdin.end` → `SIGTERM` → `taskkill /F /T`)
- 简单 Web UI:实例列表 + 流式对话流

### Phase 0 — Stream-JSON 协议探针
- 11 个 probe 脚本实测 `claude -p --input-format stream-json` 行为
- 沉淀 `probe/findings.md`:stdin user-message schema、resume 跨进程、partial messages、权限模式陷阱、进程树 kill 等
- 见 [docs/stream-json-protocol.md](./docs/stream-json-protocol.md)
