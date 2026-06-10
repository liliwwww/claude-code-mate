# Phase 0 Findings — Stream-JSON Schema & Headless Protocol

> 累积事实结论,作为 Phase 1 SpawnManager / streamParser 的硬地基。
> **这份文档签字后才能动 server/spawn 代码。**

环境:Windows 11,PowerShell 5.1,Node ≥18,Claude CLI **2.1.169**,本机代理 `http://127.0.0.1:10808`。

---

## Probe 01 — baseline (text-in -p arg + stream-json out)  ✅

启动:`claude -p "<prompt>" --output-format stream-json --verbose`

- ✅ 代理透传:`spawn(...,{env:{...process.env}})` 直接透传 `HTTP_PROXY`,无特殊处理
- ✅ 单 prompt → exit 0,冷启动 ~7s
- 事件类型(单轮简单 prompt):`system/init` × 1 / `rate_limit_event` × 1 / `assistant` × 1 / `result/success` × 1
- ⚠️ **`rate_limit_event` 是 plan 漏的事件**,streamParser 必须识别
- `system/init` 字段(21 项)关键:`type, subtype, cwd, session_id, tools, mcp_servers, model, permissionMode, slash_commands, agents, skills, plugins, claude_code_version, apiKeySource, output_style, fast_mode_state, memory_paths.auto, uuid, analytics_disabled, product_feedback_disabled`
- ✨ **`slash_commands` 字段在 init 里**,启动期间已暴露 user 级 + built-in 全部命令名
- session_id 在 init 里发布,每个后续事件都带相同的 `session_id`
- `result` 关键字段:`is_error, api_error_status, duration_ms, num_turns, result(完整文本), session_id, total_cost_usd, usage, modelUsage(按模型分别计费), permission_denials, terminal_reason, uuid`

---

## Probe 02 — stdin user-message JSON schema  ✅

启动:`claude -p --input-format stream-json --output-format stream-json --verbose --replay-user-messages --permission-mode dontAsk`

**关键陷阱(chicken-and-egg)**:
- `--input-format stream-json` 模式下,**必须 spawn 后立刻写 stdin**,**不能等 init**
- 不写 stdin → claude ~3s 后静默退出 exit 0,stdout 一个字节都没
- 实施意义:`SpawnManager.spawn()` 必须 spawn 同步阶段就把首条 stdin 准备好(可以是 `/role-name` slash command 暖机)

**测了 3 种 schema**(用 `--replay-user-messages` 观察哪个被接受):

| ID | Payload | 结果 |
|---|---|---|
| A | `{type:"user", message:"string"}` | ❌ exit 1, stderr `Error: Expected message role 'user', got 'undefined'` |
| B | `{type:"user", message:{role:"user", content:[{type:"text",text:"..."}]}}` | ✅ |
| C | `{type:"user", message:{role:"user", content:"string"}}` | ✅ |

**官方 stdin user-message envelope**(实证):
```jsonc
{
  "type": "user",
  "message": {                                  // Anthropic Messages API shape
    "role": "user",
    "content": "<string>" | [{"type":"text","text":"..."}, ...]
  }
}
```

**新增事件**:`user`(echo)。`--replay-user-messages` 让 claude 把 stdin 接受的 user 消息 enrich 后回显:
```jsonc
{"type":"user", "message":{...原 payload}, "session_id":"...", "parent_tool_use_id":null, "uuid":"..."}
```
**用途**:确认 stdin 已被消化的最早信号,跟踪 in-flight 消息。

事件顺序(单轮):stdin → `system/init` → `user` (echo) → `rate_limit_event` → `assistant` → `result/success`

---

## Probe 03 — --resume 跨进程接续(text mode 基线)  ✅

- ✅ A 植入 "azure-blue" → B 用 `--resume <A.session_id>` 全新进程 → 准确回忆 "azure-blue"
- ⚠️ **不加 `--fork-session` → session_id 保留**(B 继续写入 A 的 jsonl)
  - 风险:多进程同时 resume 同一 session 会读写竞争同一文件

---

## Probe 04 — --resume + stream-json IN+OUT  ✅(关键关卡)

- ✅ `--resume <id> --input-format stream-json --output-format stream-json` 完全兼容
- ✅ 不加 `--fork-session` → session_id 保留
- ✅ 加 `--fork-session` → 新 session_id,原 jsonl 不动(B2 session: `6200f409-...` ≠ A: `c73ff83b-...`)
- ✅ B1/B2 均准确回忆 "turquoise-green"
- 🎁 **意外发现**:跨 probe `system_prompt` 看到 "replacing the prior azure-blue" — claude 通过 `memory_paths.auto`(`~\.claude\projects\<proj-cwd>\memory\`)有**跨 session 持久化记忆**
  - 实施意义:不同角色实例共享同一 cwd → 共享同一 auto-memory → 角色之间可能"串味"
  - 决策:**角色实例的 cwd 用 sibling 项目目录** + 必要时 `--bare` 跳过 auto-memory(plan §C 已规划)

---

## Probe 05 — slash command via stream-json stdin  ✅

- ✅ 第一条 stdin user 文本 `/probe05-greet` 在 stream-json 模式下被 expand
- ✅ 带参 `/probe05-greet please` 也 OK
- ✅ 自定义 command 出现在 `system/init.slash_commands` 字段
- 🎁 **user echo 揭示 claude 内部把 slash command 转成结构化 XML**:
  ```
  <command-message>probe05-greet</command-message>
  <command-name>/probe05-greet</command-name>
  <command-args>please</command-args>
  ```
- **实施决策**:SpawnManager 启动角色实例时,**首条 stdin = `/<role-name>`** 装载 skill。匹配现有协作模式 zero-friction。

---

## Probe 06 — 代理注入(POS + NEG)  ✅

| 场景 | 结果 |
|---|---|
| 有 `HTTP_PROXY` | ✅ exit 0,9.2s |
| 无 `HTTP_PROXY` | ❌ exit 1,2.8s |

**NEG 失败形态特征**(SpawnManager 错误识别必备):
- `system/init` **照常发出**(启动 OK)— 启动成功不代表 API 通
- `result` 事件**仍发出**,但 `result.subtype === "success"` 是误导!
- **真正错误信号** = `result.is_error: true` + `result.api_error_status: 403`
- `stderr` 完全为空(0 bytes)— 所有错误走 stdout NDJSON
- ⚠️ **铁律**:错误判定看 `result.is_error`,**不**信 `subtype`

---

## Probe 07 / 07b — 权限模式 + 工具限制  ✅

**probe 07**:`--permission-mode dontAsk` / `bypassPermissions` / `default` 4 种,全部允许 `echo`
- 原因:user-level settings 有 `"skipDangerousModePermissionPrompt": true` + 长 allow list
- 教训:**`--permission-mode` 在 headless 下实际很宽松**,不是真正的隔离机制

**probe 07b**:`--tools` 白名单 / `--disallowedTools` 黑名单 真正测试
- ✅ `--tools "Read Grep Glob"`(无 shell)→ claude 明确说 "no shell tool available",**zero tool_use**,严格生效
- ⚠️ `--disallowedTools Bash` → claude **自动 fallback 到 PowerShell tool**,绕过!
- 🎁 **新发现**:Windows 上 claude 工具池有 **Bash + PowerShell 两个独立 shell 工具**

**实施铁律**:
- 角色配置**只用 `--tools` 白名单**,**绝不**用 `--disallowedTools` 黑名单(总有遗漏)
- 角色默认工具集:Read / Grep / Glob / Edit / Write(execB)/ Bash(execB only)/ PowerShell(testC only,跑长任务)

---

## Probe 08 — 长任务可见 PS 窗口 + 哨兵协议  ✅

- ✅ claude 调 PowerShell tool → `Start-Process powershell -ArgumentList ...` → 弹独立 visible 窗口
- ✅ 5s sleep + 写哨兵文件 → 哨兵内容 `hello from visible window\nDONE rc=0`
- ⚠️ 哨兵文件带 **UTF-8 BOM** (`﻿`)— longTaskWatcher 读取时要 strip:
  ```js
  fs.readFileSync(p, 'utf8').replace(/^﻿/, '')
  ```
- ⚠️ **权限收紧**:需要 `--tools PowerShell` **+** `--settings '{"permissions":{"allow":["PowerShell"]}}'` 同时给,缺一仍被 `dontAsk` 拒
- ⚠️ Start-Process 立即返回,`tool_result.content === "(PowerShell completed with no output)"`,is_error=false — 不要当成失败

---

## Probe 09 — graceful kill + 进程树  ✅

| 方法 | 行为 |
|---|---|
| L1 `stdin.end()` 单用 | ❌ claude **不自动退出**,空闲 60s+ |
| L2 `child.kill('SIGTERM')` | ✅ 375ms 内退出,signal=SIGTERM |
| L3 `taskkill /F /T /PID` | ✅ 1.5s 内退出,exit code=1 |

- ⚠️ wmic 没观察到 descendants(可能 PowerShell tool 不 fork 真子进程,或时机太晚)
- 但 `/T` 是保险兜底,保留

**SpawnManager kill 策略**:`stdin.end()` → 等 2s → `kill('SIGTERM')` → 等 2s → `execSync('taskkill /F /T /PID ' + pid)`

---

## Probe 10 — partial messages 形状  ✅

- ✅ `--include-partial-messages` 产 12 个 `stream_event` 事件(用 4-sentence prompt 测)
- 嵌套子事件 type(在 `event.type` 字段):
  - `message_start`
  - `content_block_start` (with `content_block.type: "text"`)
  - `content_block_delta` (with `delta.type: "text_delta"`)  ← **逐 token 输出**
  - `content_block_stop`
  - `message_delta`
  - `message_stop`
- 这是标准 **Anthropic Messages API SSE 事件**,被包装成 `{type:"stream_event", event:<SSE 数据>}`
- ✅ 拼接所有 `text_delta.text` = 最终 `assistant` 事件的完整文本
- ⚠️ partial 跟 final `assistant` **共存** — 同一信息出现两次

**streamParser 策略**:
- `stream_event` → 实时 UI 显示("打字机效果")
- `assistant` final → 持久化到 SQLite(不存每个 delta,避免膨胀)
- `result` → 终态信号

---

# 综合技术决策(Phase 1 SpawnManager 基础)

## 1. spawn argv 标准模板

```js
const args = [
  '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--include-partial-messages',
  '--replay-user-messages',
  '--include-hook-events',
  '--permission-mode', 'dontAsk',
  '--tools', roleDef.allowedTools.join(' '),         // 白名单铁律,从 role frontmatter
  '--settings', JSON.stringify({                     // settings allow 必须配合
    permissions: { allow: roleDef.allowRules }
  }),
  '--session-id', preallocatedUuid,                  // optional, 为 resume 准备
  '--name', `${roleName}#${shortId}`,
  '--add-dir', roleDef.cwd,
  '--append-system-prompt', composedSkillPrompt,
];
// for resume:
//   args.push('--resume', sessionId, '--fork-session');
```

## 2. 必备 env

```js
env: {
  ...process.env,
  HTTP_PROXY:  config.httpProxy,
  HTTPS_PROXY: config.httpsProxy,
  NO_PROXY:    'localhost,127.0.0.1',
}
```

## 3. 首条 stdin 写入(立即)

```js
const greeting = JSON.stringify({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text: `/${roleDef.skillCommand}` }] }
}) + '\n';
child.stdin.write(greeting);  // synchronous, before any await
```

## 4. streamParser 必须识别的事件 type

| type | subtype / nested | 用途 |
|---|---|---|
| `system` | `init` | 启动元数据,session_id,slash_commands,tools |
| `system` | `api_retry` | 速率/网络重试通知 |
| `rate_limit_event` | — | ⚠️ plan 漏的事件 |
| `user` | — | stdin 消息回显(替代 ack) |
| `assistant` | (含 content[] of text/tool_use) | 完整 assistant 轮 |
| `stream_event` | `event.type`: message_start/content_block_start/content_block_delta/content_block_stop/message_delta/message_stop | partial 逐 token |
| `result` | `success` / `error` | **终态**(判错看 `is_error`,不看 subtype) |

## 5. 错误判定

```js
function isResultError(ev) {
  return ev.type === 'result' && ev.is_error === true;
  // NOT: ev.subtype === 'error'  ← 误导,subtype 总是 'success' 时也可能 is_error: true
}
```

## 6. graceful kill 升级序列

```js
async function killInstance(child) {
  try { child.stdin.end(); } catch {}
  if (await waitExit(child, 2000)) return 'L1';
  try { child.kill('SIGTERM'); } catch {}
  if (await waitExit(child, 2000)) return 'L2';
  try { execSync(`taskkill /F /T /PID ${child.pid}`); } catch {}
  if (await waitExit(child, 2000)) return 'L3';
  return 'L4_orphan';  // give up, log alert
}
```

## 7. resume 双策略

- 优先 `--resume <id> --fork-session`(避免原 jsonl 写竞争)
- session_id 在新进程的 `system/init` 里读回(不信 preallocated)
- 如果 resume + stream-json 在某些版本失败 → fallback:history-replay(注入合成 user/assistant 消息)
  - **probe 04 显示当前 2.1.169 OK**,不必现在做 fallback,但保留接口

## 8. 长任务可见窗口

- claude 通过 PowerShell tool 调 `Start-Process powershell -ArgumentList ...`
- 哨兵文件路径在 prompt 里给 claude
- mate UI longTaskWatcher 用 chokidar 监听 `runlog/` 目录,捕获 `DONE rc=N` 字样
- 读哨兵 strip UTF-8 BOM
- UI **只读**哨兵,不删/写(防双处理)

## 9. memory 隔离

- 每个角色实例 cwd 设到 sibling 项目目录
- 跨实例的 auto-memory 串味问题:**首版接受**(plan §I R12 governance),后续再加 `--bare` 隔离选项
- mate 自己的路由 LLM 调用:**`--bare --no-session-persistence`** 干净隔离

---

# Phase 1 准入(Phase 0 → Phase 1 关卡)

| 关卡 | 状态 |
|---|---|
| R1 stdin schema 已知 | ✅ |
| R2 resume + stream-json 兼容 | ✅ |
| R3 graceful kill 路径 | ✅(L1→L2→L3 升级) |
| R4 slash command in stream | ✅ |
| R5 代理注入 | ✅ |
| **可以开始 SpawnManager** | ✅ |

**额外标记需要在 Phase 1 中持续观察**:
- Anthropic 后续可能改 stream-json schema(2.1.169 锁定结论);CI 加最小 probe 防回归
- 跨角色 auto-memory 串味是 Phase 1+ 的 governance 问题
