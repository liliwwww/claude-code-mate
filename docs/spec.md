# 项目目标

帮我实现一个本地运行的 **Web 应用**,用于**统一管理多个 Claude Code 会话**:
在网页上新建/关闭多个会话,向指定会话(或批量)发送 prompt,实时查看每个会话的流式回复,并把对话记录留存下来。

这是个**个人内网工具**,运行在我自己的 Windows 机器上,不对公网开放。

---

# 运行环境与约束(重要,先读)

- **操作系统**:Windows 10/11,原生环境(不是 WSL)。
- **Shell**:PowerShell(`powershell.exe`;若检测到 PowerShell 7 则优先用 `pwsh.exe`)。
- **Node.js**:已安装 18+。后端用 Node 实现。
- **Claude Code CLI**:已全局安装(`@anthropic-ai/claude-code`),`claude` 命令在 PATH 中可用,且已完成登录认证(用的是 Max 订阅,不要在代码里写任何 API key)。
- **网络代理**:我本机走本地代理。Node 子进程**不会**自动走系统/TUN 代理,必须在 spawn 子进程时显式注入 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量,否则 `claude` 连不上服务器。代理地址做成可配置项(环境变量或配置文件),默认值用占位符 `http://127.0.0.1:PORT`,并在 README 里提醒我改成真实端口。

---

# 架构决策(已确定,请勿改成别的方案)

**核心采用 Claude Code 的 headless 双向流模式,而不是抓取交互式 TUI。**

- 每个会话 = 一个**常驻的 claude 子进程**,以
  `claude --input-format stream-json --output-format stream-json --verbose` 启动。
- 后端通过该子进程的 **stdin 写入用户消息**,从 **stdout 读取流式 JSON 事件**,解析后通过 WebSocket 推送给前端。
- 无人值守发指令时加 `--dangerously-skip-permissions`(或 `--permission-mode bypassPermissions`);
  同时生成一份 `.claude/settings.json` 示例,把可用工具范围限定收紧,并在 README 说明风险。
- **不要**用抓取彩色 TUI、再正则解析 ANSI 的方式来读取回复——那不可靠。

> 注意:`--input-format stream-json` 的 stdin 消息结构官方文档覆盖不全。
> 请你在动手前先用 `claude --help`、查官方 headless / Agent SDK 文档,
> 或起一个最小探针进程实际打印 stdin/stdout 往来,**确认清楚消息的 JSON schema**
> (user 消息怎么发、assistant/result/system 事件长什么样、session_id 在哪),
> 再据此实现。不要凭猜测拼协议。

---

# 功能需求

1. **会话管理**
   - 新建会话:可指定该会话的工作目录(cwd)、可选 model、可选附加参数。
   - 列出当前所有会话及其状态(运行中 / 空闲 / 已退出 / 出错)。
   - 关闭/终止单个会话,并能优雅清理子进程。
2. **发送指令**
   - 向**指定**会话发送一条 prompt。
   - 支持**批量**:把同一条 prompt 一次性发给多个选中的会话。
3. **接收与展示**
   - 实时流式显示每个会话的 assistant 回复(逐 token / 逐事件追加)。
   - 显示工具调用、结果、以及每轮结束时的 `result` 与 `cost`(如果事件里有)。
4. **记录留存**
   - 每个会话的完整对话以 JSONL 落盘(按 session 一个文件),便于事后检索。
5. (可选,做完上面再加)**手动接管视图**
   - 给单个会话挂一个基于 `node-pty`(Windows 下走 ConPTY)+ `xterm.js` 的实时终端,
     让我能像坐在终端前一样手动操作那个会话。这部分**先不做**,留接口,等核心跑通我再决定。

---

# 技术栈

- 后端:Node.js + Express + `ws`(WebSocket)。
- 子进程:Node 内置 `child_process.spawn`,**参数用数组传**(不要拼成单个字符串过 shell,避免 PowerShell 引号转义问题)。
- 前端:简单单页即可,原生 JS 或轻量框架都行,不需要复杂构建链。能多标签/多面板看会话、有输入框和"发送/批量发送"按钮即可。
- 数据:JSONL 文件落盘,先不用数据库。
- (可选视图)`node-pty` + `xterm.js`。

---

# 关键实现要点

- spawn 子进程时,`env` 务必为 `{ ...process.env, HTTP_PROXY, HTTPS_PROXY }`。
- 会话用一个内存 Map 按 sessionId 管理:`{ proc, status, cwd, createdAt, logPath }`。
- 正确处理子进程的 stdout 分块:按行缓冲,拼出完整 JSON 行再 parse,容忍不完整/空行。
- 监听子进程 `exit` / `error`,更新状态并通过 WebSocket 通知前端,避免僵尸进程。
- 进程退出、端口占用、claude 未登录、代理不通等错误,要有清晰的报错信息回传前端,不要静默失败。

---

# 建议的项目结构

```
claude-terminal-manager/
├── server/
│   ├── index.js          # Express + ws 启动
│   ├── sessionManager.js # 会话生命周期、spawn、stdin/stdout 处理
│   └── config.js         # 代理、端口、claude 路径等配置
├── public/
│   ├── index.html
│   ├── app.js
│   └── style.css
├── logs/                 # 各会话 JSONL
├── .claude/settings.json # 工具权限收紧示例
├── .env.example          # HTTP_PROXY / HTTPS_PROXY / PORT 占位
└── README.md
```

---

# 开发方式

请**分步推进,每步先跑通再继续**,不要一次性写完全部:

1. 先做**最小闭环**:启动 1 个 headless claude 子进程,命令行里发一条固定 prompt,把 stdout 的流式 JSON 原样打印出来,验证协议和代理都通。
2. 再加 Express + ws,把第 1 步搬到"网页发 prompt → 看流式回复"。
3. 再加多会话管理、批量发送、JSONL 落盘。
4. 最后(等我确认)再考虑可选的 pty + xterm 接管视图。

每完成一步,简要告诉我怎么运行验证。遇到协议/环境不确定的地方,先验证再写,有疑问就问我。

---

# 验收标准

- 在 Windows + PowerShell 下,`npm install && npm start` 后,浏览器打开能看到管理界面。
- 能同时开 ≥2 个会话,分别发不同 prompt,各自实时流式显示回复互不串台。
- 能选中多个会话批量发同一条 prompt。
- 关掉会话后对应子进程确实退出,无残留。
- `logs/` 下每个会话有对应的 JSONL 记录。
- 代理、端口、claude 路径均可通过 `.env` 配置,README 写清楚怎么填。