# 角色编写指南

Mate 的角色定义集中在 `roles/<name>.md`,每个文件是一份带 YAML frontmatter 的 markdown:

```markdown
---
name: planA-R
type: requirements
parallelism_limit: 3
is_central: false
session_ttl_hours: 8
display_color: "#88ccff"
allowed_tools:
  - Read
  - Grep
  - Glob
  - Write
  - Edit
allow_rules:
  - Read
  - Grep
  - Glob
  - Write
  - Edit
permission_mode: dontAsk
skill_command: planA-R
peer_visibility: []
---

You are **planA-R**: ...
(角色 body,会通过 `--append-system-prompt` 装载到 claude 的 system context)
```

## frontmatter 字段

| 字段                  | 必填 | 默认                            | 说明                                                                                       |
| --------------------- | ---- | ------------------------------- | ------------------------------------------------------------------------------------------ |
| `name`                | ✅   | —                               | 角色名(唯一),用作实例 ID 前缀                                                            |
| `type`                | ✅   | —                               | `orchestrator` / `requirements` / `executor` / `validator`                                |
| `parallelism_limit`   | ✅   | —                               | 单一 project 内该角色可同时存在的最多实例数                                                |
| `is_central`          | ❌   | `false`                         | 是否中枢角色(全 catalog 必须恰好一个为 true)                                              |
| `session_ttl_hours`   | ❌   | `config.defaultSessionTtlHours` | session 多久没动过算"生锈",过期则下次发消息时不再 resume,新开 session(Phase 2C 实施)  |
| `display_color`       | ❌   | `#ccc`                          | UI 上的标识色                                                                              |
| `allowed_tools`       | ❌   | `[]`                            | 传给 `--tools <list>` 的白名单 — claude 只能调这里列出的工具                              |
| `allow_rules`         | ❌   | `[]`                            | 传给 `--settings {permissions:{allow:...}}` 的允许规则 — 必须跟 `allowed_tools` 配套       |
| `permission_mode`     | ❌   | `dontAsk`                       | `--permission-mode <mode>`,推荐 `dontAsk`                                                  |
| `skill_command`       | ❌   | `name`                          | (留接口)future:可在 sibling project 注册同名 `/skill` 时优先用 slash command 启动        |
| `peer_visibility`     | ❌   | `[]`                            | 中枢角色启动时,system prompt 里告诉它哪些 peer 可派工(Phase 2C 起使用)                  |

## allowed_tools vs allow_rules — 必读

Phase 0 探针实证:

- **`--tools`**(白名单):决定 claude 看得到哪些工具
- **`--settings.permissions.allow`**:决定**白名单内**的工具是否被 dontAsk 模式允许使用

**两个都要给,缺一即被拒**。常见错误:在 `allowed_tools` 加了 `Write`,以为可以写文件,但 `allow_rules` 漏了 `Write`,dontAsk 模式拒绝调用。

### 常见组合

| 角色用途              | allowed_tools                        | allow_rules                          |
| --------------------- | ------------------------------------ | ------------------------------------ |
| 只读探现状(R / H)   | Read, Grep, Glob                     | Read, Grep, Glob                     |
| 写代码 / queue 文件   | Read, Grep, Glob, Write, Edit        | Read, Grep, Glob, Write, Edit        |
| 跑 shell(execB)     | + Bash                               | + Bash                               |
| 跑 PowerShell(testC)| + PowerShell                         | + PowerShell                         |

## body 写什么

Body 直接作为 `--append-system-prompt` 注入。**写 claude 看得懂的角色介绍**:

- 你是谁(身份 + 业务定位)
- 你做什么(关键动作清单)
- 你**不**做什么(角色边界 — 极其重要)
- 跟其它角色的协作协议(可选)
- 启动时如何融入工作流(可选)

参考 `roles/planA-R.md` / `roles/planA-H.md` 等。

## 加新角色

1. 落盘 `roles/<name>.md`
2. 重启 mate(Phase 5 计划做 chokidar 热加载,目前需重启)
3. UI 顶栏 spawn 下拉里出现新角色
4. 中枢角色 H 的 system prompt 自动包含新角色信息(因为 RoleCatalog 在 spawn 中枢时把全 catalog 列出来)

## 删除 / 改名

- 删除 `roles/<name>.md` 后,**已存在的实例不受影响**(它们的 spawn_args_json 是历史快照);但**不能再 spawn 新实例**
- 改名等于删旧 + 加新

## 校验

`RoleCatalog.load()` 启动期校验:

- 必填字段缺失 → 警告 + 跳过该 role
- `type` 不在允许枚举 → 警告 + 跳过
- 0 个或多个 `is_central` 角色 → 警告(不致命,但要修)

启动日志 `[boot] roles loaded:` 列出实际生效的角色集。

## 当前默认 4 角色

源自项目原始协作模式(详见 [collaboration-mode.zh-CN.md](./collaboration-mode.zh-CN.md)):

- `planA-R` — requirements(R 终端可多个)
- `planA-H` — orchestrator,中枢(单例)
- `execB` — executor(可多个并行)
- `testC` — validator(可多个并行)

工作流:R 跟 user 聊需求,完工写 queue 文件 → H 读 queue,设计 handoff,派工 → B/C 执行,完工 AWAITING_VERIFY → H 验收 → user 拍板。
