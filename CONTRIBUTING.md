# 贡献指南

感谢有兴趣给 Claude Code Mate 贡献代码 / 文档 / issue 反馈!

## 开发环境

- Windows 10/11(项目当前**仅在 Windows 原生**测过;欢迎贡献 macOS / Linux 适配)
- Node.js 18+(项目根目录有 `.nvmrc`)
- Claude Code CLI 全局已装 + 已认证(Max 订阅)
- 本地代理可达(默认 `http://127.0.0.1:10808`)

## 起步

```powershell
git clone https://github.com/<你的-fork>/claude-code-mate.git
# 上游:https://github.com/liliwwww/claude-code-mate.git
cd claude-code-mate
npm install
copy .env.example .env
# 编辑 .env
npm start
```

## 项目结构(SSOT)

- `server/` — Node.js 后端(Express + WebSocket + SQLite + spawn 管理)
- `public/` — 前端(vanilla JS,**无 build chain**)
- `roles/` — 角色 markdown 定义,SSOT
- `probe/` — Phase 0 技术探针 + `findings.md`(影响架构决策的实证)
- `docs/` — 技术文档
- `data/` — SQLite + 日志(gitignored)

## 代码规范

### 1. **每次修订代码,把承载需求的注释写到代码里**

源自项目协作模式的 **`[需求@YYYY-MM-DD]`** / **`[bug@YYYY-MM-DD]`** 标签规则:

```js
// [需求@2026-06-10] lazy resurrection — user 反馈"程序重启不应导致数据/状态丢失"
//   重启后 SQLite 里活着的实例被重新水化为 disconnected RoleInstance(无 child process),
//   sendUserText 触发自动 spawn + --resume <session_id> --fork-session 续上对话。
```

这是 grep 可追溯的需求来源链。**修改这块代码前 grep 这个标签,看历史背景**。

### 2. **没有测试框架,但有探针**

`probe/*.js` 是独立 Node 脚本,验证 claude CLI 的行为契约。如果你改了 `SpawnManager` / `RoleInstance` / `streamParser`,跑一遍相关 probe 看回归。

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:10808"
node probe/02_stream_in_stream_out.js
```

每个 probe 自包含(零运行时依赖,只用 node 内置 + 真实 claude CLI)。

### 3. **不要凭印象写 claude 协议**

`claude --input-format stream-json` 的 stdin/stdout schema 官方文档不全。**怀疑哪里有变化,先起 probe 实证**,把发现写进 `docs/stream-json-protocol.md`,**再**改代码。

### 4. **缩进 / 格式**

`.editorconfig` 是 SSOT。2 spaces / LF / UTF-8。`.ps1` 用 CRLF。

## 提交规范

PR 标题用 conventional commits 风格(可选,但推荐):

- `feat(scope): xxx` — 新功能
- `fix(scope): xxx` — bug 修复
- `docs(scope): xxx` — 文档
- `refactor(scope): xxx` — 重构不改行为
- `chore(scope): xxx` — 杂务(deps、CI、配置)

scope 例:`spawn` / `routing` / `db` / `ui` / `docs`。

PR 提交前自检:
- [ ] `npm start` 跑通
- [ ] 相关 probe 跑过(如果改的是 spawn/parser 层)
- [ ] 涉及需求的代码改动有 `[需求@日期]` 注释
- [ ] `CHANGELOG.md` Unreleased 段加一行说明

## Issue 模板

请按模板提交。如果是:
- **Bug**:用 bug_report,提供复现步骤 + 系统信息 + 日志
- **新需求**:用 feature_request,描述痛点 + 期望行为 + 替代方案

## 行为准则

请保持友善、专业。具体细则参考 [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/)。

## License

提交即视为同意以 MIT 协议授权你的贡献。
