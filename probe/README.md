# Phase 0 — Stream-JSON Schema Probes

实施方案 plan 的 Phase 0 产出。目标:实测 `claude` headless 模式的 stdin/stdout 协议,夯实未公开的细节,作为后续 SpawnManager 的硬地基。

每个 probe 是独立可跑的 Node 脚本(零依赖,只用 node 内置 `child_process`/`fs`/`crypto`)。日志写到 `probe/log/<probe-id>.ndjson`。

## 运行方式

```powershell
# 需要先在 shell 设置代理,Node 会自动透传给子进程
$env:HTTP_PROXY  = "http://127.0.0.1:10808"
$env:HTTPS_PROXY = "http://127.0.0.1:10808"

node probe/01_text_in_stream_out.js
node probe/02_stream_in_stream_out.js
# ...
```

## Probe 清单

| # | 脚本 | 验证 |
|---|---|---|
| 01 | `01_text_in_stream_out.js` | 基线:`-p "..." --output-format stream-json --verbose` 通,事件类型清单 |
| 02 | `02_stream_in_stream_out.js` | **stdin user message JSON schema**(测 3 种候选) |
| 03 | `03_resume_via_session_id.js` | 杀死进程后 `--resume <id>` 跨进程接续 |
| 04 | `04_resume_with_stream_json.js` | `--resume` + `--input-format stream-json` 兼容性 |
| 05 | `05_slash_command_in_stream.js` | 第一条 stdin 消息为 `/planA-R` 能否生效 |
| 06 | `06_proxy_injection.js` | 显式 env 注入 + 故意去代理看失败形态 |
| 07 | `07_permission_mode_dontAsk.js` | `--permission-mode dontAsk` + `permissions.allow` 白名单 |
| 08 | `08_long_run_visible_window.js` | claude 通过 `Start-Process` 弹可见 PS 窗口 + 哨兵回传 |
| 09 | `09_graceful_kill.js` | stdin.end → SIGTERM → taskkill /F /T + wmic 跟踪子 PID |
| 10 | `10_partial_message_format.js` | `--include-partial-messages` 下 delta/full/result 形状 |

## 产出

- `probe/log/<probe-id>.ndjson` — 每个 probe 的原始日志
- `probe/findings.md` — 累积的事实结论汇总(影响后续架构)
