# Changelog

所有重要改动记录在这里。版本格式遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/),改动类别参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

### 进行中
- Phase 2B:线索看板作为主视图,移除"实例 dropdown spawn"
- Phase 2C:实例池 acquire/release + `[slug]` 路由 + session TTL 4h
- Phase 2D:系统监控模块 + 全局并发 cap

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
