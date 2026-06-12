# Changelog

所有重要改动记录在这里。版本格式遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/),改动类别参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

### 进行中
- Phase 2D:系统监控模块 + 全局并发 cap + session TTL 4h
  - 含 [**Mate 仪表盘**(方向 C)](docs/discussions/2026-06-12-mate-dashboard.md):顶栏"终端"按钮升级成"系统",modal 加统计卡片 + 底部 chat 输入框跟 System Agent 自然语言问答(`今日 cost 多少?` `最近 BLOCKED 是哪些?` 等)

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
