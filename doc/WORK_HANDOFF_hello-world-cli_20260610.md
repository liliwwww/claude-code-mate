---
slug: hello-world-cli
date: 2026-06-10
from: planA-H
to: execB
queue_ref: doc/queue/hello-world-cli_20260610.md
status: dispatched
---

# WORK HANDOFF — Hello World CLI

## Scope (做什么)
新建一个最简 Node.js CLI 脚本,运行后向 stdout 打印一行 `hello world`,以退出码 0 退出。

**唯一交付物:** 一个 `.js` 文件(建议路径 `tools/hello-world.js`,若你认为放在仓库其他位置更合适,自行决定,但只新增一个文件)。

## Invariants (不能动什么)
- 不修改任何已有文件(`public/`、`server/`、`roles/`、`package.json` 全部不动)。
- 不引入任何 npm 依赖。
- 不新增 README、不新增配置、不新增测试。

## Acceptance (验收标准)
1. 在仓库根目录执行 `node <你新增的文件路径>`,stdout 输出恰好一行 `hello world`(末尾换行随 `console.log` 默认行为即可)。
2. 进程退出码为 `0`(可用 `node <file>; echo $LASTEXITCODE` 在 PowerShell 验证)。
3. 文件内容不超过 5 行(含可选 shebang)。

## STOP conditions (出现以下立即停手并回报)
- 发现需要修改任何已有文件才能满足验收 → 停手,在 terminal_status 标记 blocked。
- 用户/R 在 queue 文件里追加了新需求(status 不再是 `queued`)→ 停手。

## Time budget
≤ 5 分钟。超过说明误解了需求,停手回报。

## 完成后
1. `git add` + `git commit`,commit message 建议:`feat(hello-world-cli): minimal node CLI prints hello world`。
2. 在 `doc/terminal_status/execB.md` 写一行完成记录(文件不存在就新建)。
3. 用 `<mate:done summary="..." />` 回交。
