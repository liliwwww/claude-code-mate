# Claude Code Mate

> **本地 Web UI,统一管理多个 Claude Code CLI 会话** —— 让"多角色协作 + 一堆 PowerShell 终端"不再让大脑爆炸。

[English README](./README.md) · [架构文档](./docs/architecture.md) · [Stream-JSON 协议实证](./docs/stream-json-protocol.md)

> **状态:实验性。** Phase 2A(多 project 基础)已上线;Phase 2B–2D 与智能路由开发中。**仅设计给 Windows 单机本地使用 + Claude Max 订阅**,不面向公网部署。

---

## 它解决什么问题

如果你用 Claude Code CLI 跑复杂工作流 —— 比如开了好几类终端:**R(需求挖掘)/ H(编排)/ execB(实施)/ testC(验证)** —— 实际可能要并行 7-10 个 PowerShell 窗口。**人肉切窗口、复制粘贴、记哪个终端在跑哪条线索**,会成为真正的瓶颈。

Claude Code Mate 把这套体验压扁到一个浏览器 tab:

- **单一输入框** → 系统识别意图路由到对应角色
- **线索看板**展示所有需求(slug)的全生命周期(讨论 → 设计 → 实施 → 测试 → 验收)
- 所有对话持久化在 SQLite — **重启不丢数据**
- 闲置会话被恢复为 `disconnected`,user 跟它讲话时**懒激活**(`--resume` 续上对话)
- **多项目**支持:同时管 `D:\dev\kb_backend`、`D:\dev\web_gmail`、Mate 自己

核心原则:**「升维不再造」** —— 角色(R/H/B/C)依然存在、依然有自己的 system prompt 和工具权限。Mate 不替代任何角色,它是**路由器 + 视图聚合层**。

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
| 2B    | ⏳    | **线索看板**作为主视图,砍掉 spawn dropdown,"+ 新线索"入口      |
| 2C    | 📋    | 实例池 + `[slug]` 路由 + session TTL 4h 防生锈                  |
| 2D    | 📋    | 系统监控模块 + 全局并发 cap                                     |

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
