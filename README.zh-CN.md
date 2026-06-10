# Claude Code Mate

> **一个对话框,后台一群专门的 Claude Code 角色。** 你描述需求 —— Mate 自动编排"梳理 → 设计 → 实施 → 验证"全流程,无需切窗口、无需感知角色切换。

[English README](./README.md) · [架构文档](./docs/architecture.md) · [Stream-JSON 协议实证](./docs/stream-json-protocol.md)

> **状态:实验性。** Phase 2A(多 project)+ 2B(线索看板 + 懒 spawn)已上线;Phase 2C(自动状态机 + 系统 LLM + Markdown 渲染 + 主题切换)积极开发中。**仅设计给 Windows 单机本地使用 + Claude Max 订阅**,不面向公网部署。

---

## 它解决什么问题

把 Claude Code CLI 用到极限时,单一会话很快不够用 —— 复杂工程任务往往需要"**梳理需求 → 技术设计 → 编码改动 → 跑批验证**"四件事配合。手动跑下来,你要开 4-10 个 PowerShell 窗口,每个跑一个专门角色,自己在窗口之间复制粘贴 handoff、记每个终端做到哪儿、追问验收。**思考的时间反而被切窗口和复制粘贴吃光了。**

**Mate 把这个体验压扁成一个对话框。**

**你在浏览器看到的:**

- 每条需求一条"线索",一个统一对话框,一个状态灯
- **懒激活** —— 没发首条消息前,后端不会起 claude 进程,**零 cost 浪费**
- Markdown 渲染输出、亮/暗主题切换、多 project 切换
- 系统自动摘要标题、自动生成回答模板、对话持久化(SQLite,mate 重启 / claude 崩溃 / 系统重启都不丢,通过 `--resume` 接续 session)

**后台跑的:**

- Mate 自动 spawn 各类专门角色 —— **R** 跟你聊需求 / **H** 编排派工 / **execB** 改代码 / **testC** 跑长验证 —— 根据线索阶段(`discussing → designing → executing → testing → verified`)**自动路由**
- **你看不到角色切换。** 状态徽章静默推进,对话流是统一的一条
- Mate **只在真的需要你拍板时**才打断你 —— 业务岔口、需求歧义、阻塞性选择。这时对应线索卡片上**黄灯闪烁**。其它时间工作自动往前推
- 后台所有 agent 跑完 + 自验通过后,线索翻 IDLE。Mate **不**问你"业务验收通过吗" —— 那是你自己的事(开浏览器实测、看效果、确认了点归档)

核心原则:**「升维不再造」**。角色(R/H/execB/testC)依然存在,各有自己的 system prompt 和工具权限。Mate 不替代任何角色 —— 它是把多 agent 协奏成"一个声音"的指挥。

## 它怎么跑(高层架构)

```
┌──────────────────────────────────────────────────────┐
│  浏览器 UI:线索看板 + 当前焦点对话流                │
└──────────────────────────────────────────────────────┘
            │ WebSocket events / REST API
            ▼
┌──────────────────────────────────────────────────────┐
│  Node.js 后端                                        │
│  • SpawnManager (per-project, per-role 实例池)      │
│  • StreamParser (NDJSON + partial-message 聚合)     │
│  • SQLite (threads, messages, instances, projects)  │
└──────────────────────────────────────────────────────┘
            │ child_process.spawn(数组参数,无 shell 包装)
            ▼
┌──────────────────────────────────────────────────────┐
│  claude -p --input-format stream-json …              │
│  N 个 headless 子进程,每个 (project, role) 一个    │
└──────────────────────────────────────────────────────┘
```

**长任务**(>5 分钟脚本、跑批、全产品验证)由 claude 主动通过 `Start-Process powershell` 弹**独立可见 PowerShell 窗口**跑,user 实时看进度 + 可 Ctrl+C 干预。其它通讯保持 headless。

详细架构 + 设计决策见 [docs/architecture.md](./docs/architecture.md)。

## 快速开始

**前置条件**

- **Windows 10/11**(原生 — 不是 WSL)
- **Node.js 18+**(项目根目录有 `.nvmrc`)
- **Claude Code CLI** 全局已装(`npm i -g @anthropic-ai/claude-code`)且已用 Max 订阅认证(代码里无任何 API key)
- **本地代理**:默认期待 `http://127.0.0.1:10808`,改 `.env` 即可

**安装运行**

```powershell
git clone https://github.com/liliwwww/claude-code-mate.git
cd claude-code-mate
npm install
copy .env.example .env
# 编辑 .env: 把 HTTP_PROXY 改成你的实际代理端口
npm start
```

浏览器开 <http://127.0.0.1:8721>。

开发模式 / 调试 / 技术探针请看 [docs/development.md](./docs/development.md)。

## 配置项

全部走 `.env`(模板 `.env.example`):

| 环境变量              | 默认值                   | 含义                                                |
| --------------------- | ------------------------ | --------------------------------------------------- |
| `PORT`                | `8721`                   | HTTP / WebSocket 端口                              |
| `HTTP_PROXY`          | `http://127.0.0.1:10808` | 必填 — 每个 claude 子进程都显式注入                |
| `HTTPS_PROXY`         | 同 `HTTP_PROXY`          | HTTPS 调用必填                                      |
| `CLAUDE_BIN`          | `claude`(PATH 中找)    | 显式 claude 二进制路径                              |
| `SIBLING_PROJECT_DIR` | (项目根目录)            | Phase 1 兼容字段;Phase 2A 起 project 由 DB 管理   |
| `LOG_LEVEL`           | `info`                   | `error` \| `warn` \| `info` \| `debug`             |

## 角色与协作模式

Mate 内置 4 个默认角色,定义在根目录 `roles/*.md`(每个文件含 YAML frontmatter + role body):

| 角色          | 类型          | 并行上限 | 用途                                                                  |
| ------------- | ------------- | -------- | --------------------------------------------------------------------- |
| `planA-R`     | requirements  | 3        | 跟 user 自然语言聊需求,写 queue 文件                                  |
| `planA-H`     | orchestrator  | 1 (中枢) | 读 queue → 设计 handoff → 派工 → 技术验收                            |
| `execB`       | executor      | 4        | 写业务代码 + 单测                                                     |
| `testC`       | validator     | 2        | 只读验证 + 跑长脚本 + spike 诊断                                      |

**角色定义集中在 mate,对 sibling project 透明** —— sibling 项目 **不需要**装 `.claude/commands/<role>.md`,mate 通过 `--append-system-prompt` 全程注入。

加新角色 = 落盘 `roles/<name>.md`(详见 [docs/role-authoring.md](./docs/role-authoring.md))。

完整协作模式背景见 [docs/collaboration-mode.zh-CN.md](./docs/collaboration-mode.zh-CN.md)。

## 路线图

| 阶段  | 状态  | 标题                                                            |
| ----- | ----- | --------------------------------------------------------------- |
| 0     | ✅    | Stream-JSON 协议探针(见 [findings](./docs/stream-json-protocol.md))|
| 1     | ✅    | SpawnManager + 最小观察台 UI + lazy resurrection               |
| 2A    | ✅    | 多 project 基础(项目切换器 + 添加 / 导入项目)                  |
| 2B    | ✅    | 线索看板 + 懒 spawn + 6 阶段状态机                              |
| 2C    | 🚧    | **System Agent**(mate 内置 LLM)+ 环境检测 + Markdown 渲染 + 亮/暗主题 + 自动 title 摘要 + 自动回答模板 + **角色状态机自动驱动(R→H→B/C,user 不感知)** + 状态灯 |
| 2D    | 📋    | 系统监控模块 + 全局并发 cap + session TTL 防生锈                |

## 项目目录

```
claude-code-mate/
├── server/                       Node 后端
│   ├── index.js                  Express + WebSocket 启动
│   ├── config.js                 .env 加载 + 配置导出
│   ├── db.js                     better-sqlite3 + WAL + 迁移
│   ├── messageBus.js             进程内 EventEmitter
│   ├── spawn/
│   │   ├── SpawnManager.js       per-project 实例池(Phase 2A)
│   │   ├── RoleInstance.js       单 claude 子进程封装
│   │   └── streamParser.js       NDJSON 容错解析
│   ├── roles/
│   │   └── RoleCatalog.js        roles/*.md 加载 + 元数据校验
│   ├── projects/
│   │   └── ProjectStore.js       projects 表 CRUD
│   └── api/                      REST + WS
├── public/                       前端(vanilla JS,无 build chain)
├── roles/                        角色定义(SSOT,mate 内统一管理)
│   ├── planA-R.md
│   ├── planA-H.md
│   ├── execB.md
│   └── testC.md
├── scripts/                      Windows 辅助脚本
├── data/                         SQLite + 日志(gitignored)
├── probe/                        Phase 0 技术探针 + findings
└── docs/                         技术文档
```

## 文档地图

- [架构](./docs/architecture.md)
- [Stream-JSON 协议实证](./docs/stream-json-protocol.md)
- [角色编写](./docs/role-authoring.md)
- [开发](./docs/development.md)
- [协作模式背景](./docs/collaboration-mode.zh-CN.md)
- [原项目规格](./docs/spec.md)

## 贡献

欢迎 PR 和 issue!请先看 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## License

MIT —— 见 [LICENSE](./LICENSE)。

## 致谢

**用 Claude Code 开发 Claude Code Mate,再用 Claude Code Mate 管理别的 Claude Code 项目** —— 这种递归正是本项目存在的初衷。

角色 / 文件协议 / 阶段状态机的设计源自真实业务工作流,所有取舍都是被痛点逼出来的。
