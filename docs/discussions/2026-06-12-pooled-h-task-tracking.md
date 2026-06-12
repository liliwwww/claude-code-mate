# 池化 H + 任务跟踪 + 反馈路由 + Phase 3 砍掉(2026-06-12)

> 一次讨论沉淀的多个架构决策。Phase 2D 一并实施。`[需求@2026-06-12]` grep。

---

## §0 触发讨论

评估者(另一个跟 user 长期协作的 sibling-project planA-H 终端)看 mate 后给了 17 条意见和能力评估,核心 P0 项是"H 自驱 `/loop`"。User 反驳"没必要,看板替代了 /loop 的全部价值",由此展开 4 轮讨论,把池化 H 架构 + 任务跟踪 + 反馈路径 + 仪表盘 scope 全部拍定。

---

## §1 拍板清单(8 条)

### 1. Phase 3(H 自驱 /loop)— **砍掉**

理由:
- 评估者把 /loop 列 P0 是因为他在 sibling 终端没有看板,需要 H 自己续推
- Mate 给了 user 实时仪表盘,扫一眼就看完全部 thread 状态 → "代替 user 巡视"的成本已经 ~0
- Phase 2C 自动状态机 + Phase 2D 仪表盘合起来覆盖 /loop 真实用例的 95%+
- /loop daemon 实现 3-5 天 + 增加无人值守风险面,代价不抵收益

剩余无法覆盖的 5%(H 自己 mid-thought 停 / execB 长时间无 marker / 跨线索"打扫"汇报),user 在仪表盘看见就能手动 ping。

### 2. 架构 B + B3:**池化 H + 1 R per thread + 池化 execB/testC**

| 角色 | 模型 | 数量 |
|---|---|---|
| planA-R | **1 thread = 1 R**,跟 thread 一辈子 | 跟随 thread 数量(lazy spawn) |
| planA-H | **1 全局 H**(per project),长期存活 | 1 |
| execB | **池子,共享**,跨 thread 复用 | 默认 2(`.env` 可配) |
| testC | 同上 | 默认 2 |

H 多路复用走 **B3**:long-lived + `--resume` 续上 jsonl,每次激活带 thread tag + task board snapshot。

### 3. 池化实例**不 kill / 不 disconnect / 不清 context**

理由:claude 累积的领域知识(代码读过的文件 / 业务约定)是核心价值,不要破坏。

派工切换时仅注入轻量 task tag:

```
[Thread: feat-bar  (project: kb_backend)]

<H 的 handoff 原文>
```

**不**告诉它"忘记之前的任务"。让 context 自然累积。

### 4. **稳定 slot 名**:`execB-1..N`、`testC-1..N` 跨重启不变

mate 给每个池子位预分配名字,jsonl 文件按 slot 名映射,即使进程死了重生(via `--resume <stored sessionId>`),还是叫 execB-2。

H 才能稳定记忆"execB-2 最近做过 db migration 系列"这种**跨多 thread 跨多天**的连续知识。

### 5. Marker 协议升级:**target 支持具体 instance**

- 泛型(让 mate 自己选空闲):`<mate:handoff target="execB" />`
- 具体(H 知道要找谁):`<mate:handoff target="execB-2" reason="db 相关,它最熟" />`

Mate 解析时:
- 泛型 → SpawnManager.acquire 找空闲的随便挑
- 具体 + 该 instance 空闲 → 直接派
- 具体 + 该 instance 在忙 → **排队**到该 instance 的 pending,等当前 task 结束
- 具体 + 该 instance 不存在 → 报错(让 H 重试用泛型)

### 6. **专长摘要 — 不工程化**(auto-memory 替代)

之前提议:System Agent 用 Haiku 算每个 execB 的"专长描述",注入 H 的 task board。

**砍掉**。理由:claude 自带 auto-memory(`~/.claude/projects/<encoded-cwd>/memory/*.md`),会自主沉淀:
- 项目约定(DB 端口 13306 / Python `import _bootstrap`)
- 核心禁止(execB 不动 runtime / 不 git commit)
- 反复问题(migration revision 冲突)

memory 是 **per-cwd**,所以 4 个 execB 共享同一份 project memory,跨 instance / 跨任务自然传播知识。**比工程化的专长摘要轻、准、原生**。

省掉:
- ❌ Haiku 每天算摘要的调用
- ❌ 几百行 backend 摘要存/查/注入代码

### 7. H 拿到的 **task board snapshot** — 简化版

每次 H 激活前,mate 自动注入(从 SQLite 现有表算):

```
[Mate task board · 2026-06-12 16:35]

## 活跃线索(4)
- spike-foo   discussing  R-3 (busy)
- feat-bar    designing   H (← 这次激活)
- pcbt-fix    executing   execB-2 (busy on src/login.ts)
- migration-x testing     testC-1 (busy ~25min)

## 资源池
- execB-1  idle  最近: pcbt-fix, feat-login, fix-mfa
- execB-2  busy  current: pcbt-fix
- testC-1  busy  current: migration-x
- testC-2  idle  最近: spike-batch-scan

## H 之前的决策摘要(最近 3 个)
- pcbt-fix → execB-2  @ 14:32  "auth 改造"
- migration-x → testC-1  @ 13:50  "需要全产品扫描"
- feat-login → execB-1  @ 11:20  "auth 通用"
```

**无专长摘要**(claude 自己结合 auto-memory 判断)。**有最近活动**(用于"哪个 execB 最近碰了相关文件")。

### 8. H request queue **串行化**

池化 H + 多 thread 并发请求 → 必须排队,避免 stdin 串味(claude 同 session 两条相邻消息当成同一对话延续)。

```
H state:
  current_task:   thread feat-bar (waiting H reply)
  pending:        [thread spike-foo handoff]
  completed_history: [pcbt-fix, migration-x, ...]
```

- thread B 找 H 时 H 在忙 → enqueue,不立刻发 stdin
- H 完成 thread A 当前 turn(收 result event)→ mate 取 queue 头一个发给 H
- H 每条消息带 `[Task: thread-X]` tag(本文档 §1.3)+ snapshot(§1.7)→ H 知道这是新切换的任务

---

## §2 反馈路由(execB/testC 错误 / BLOCKED → 哪里?)

### 2.1 路由原则

- execB 实例 `inst.threadSlug = '<currently-assigned-thread>'`(动态,派工时绑/完工时解)
- 所有 WS event(`instance.event` / `thread.blocked` 等)带 `threadSlug`
- 前端按 threadSlug 路由到对应 thread 的对话流 panel

→ **不存在"R 对应的独立界面"**。R/H/execB/testC 在同一条 thread 上的所有事件**统一写到 thread 对话流**。User 打开 thread A 看到全程。

### 2.2 三种反馈类型的具体路径

| 类型 | 路径 |
|---|---|
| **普通进度 assistant 消息** | `instance.event {threadSlug, eventType:'assistant'}` → 前端 thread 对话流追加 |
| **Tool error** (e.g. file not found) | `instance.event {threadSlug, eventType:'user', payload.tool_result.is_error:true}` → 对话流标红卡片 |
| **业务卡点 / 待 user 拍** | execB 输出 `<mate:blocked question="..." />` → mate 写 `thread.metadata.blocked` → WS `thread.blocked` → 线索看板**黄灯闪烁** + 对话流 BLOCKED 卡片高亮 |

### 2.3 "user 不在该 thread 焦点时怎么看到"

唯一 user 没看到的路径:user 焦点在 thread X,execB 在 thread Y 出错(非 BLOCKED)。Phase 2D 仪表盘"终端实时" tab 补这个 — 每个 execB 行下面显示"当前在干啥"实时一行:

```
execB-2  busy  thread: pcbt-fix
↳ ⚠ Edit src/auth/login.ts:42 — file content not as expected, retrying
```

User 扫一眼仪表盘就看到任何 thread 的异常。

---

## §3 Phase 2D 仪表盘(4 tab)— 跟池化改造**合并一起做**

| Tab | 内容 |
|---|---|
| **终端实时** | 8 个 instance 行(R + H + 4 execB + 2 testC),每行 status/thread/current event/memory 状况(`23 memory files, latest: "DB port 13306" 2h ago`)+ kill 按钮 |
| **任务队列** | 所有 active threads,按 stage 分组(discussing / designing / executing / testing / verified) |
| **H 派工时序** | 按 thread 分组,展示 R→H→execB→done 时序;toggle 全局时序 |
| **对话控制** | NL 输入框 → System Agent 解析意图 → 白名单 action(kill_instance / archive_thread / set_stage)→ user 确认 → 执行 + 审计 |

**写操作**走白名单,LLM 只输出 intent JSON 不直接执行,destructive 必 user 确认。

---

## §4 实施时间窗

Phase 2D 全部一起做,预估 **6-8 天**:

| 模块 | 天 |
|---|---|
| 池化 H + 池化 execB/testC 池子管理(SpawnManager.acquire / release / queue / task tag 注入) | 1.5 |
| Marker 协议升级(target 支持具体)+ MarkerDetector 改 | 0.5 |
| H request queue + task board snapshot 注入 | 1 |
| 稳定 slot 名(execB-1..N 跨重启,`--resume` 续 jsonl)+ session_id mapping 持久化 | 0.5 |
| Session TTL 防生锈(机制简单:`recycle_idle_min` 已有 frontmatter,补 recycler 即可) | 0.5 |
| 全局并发 cap | 0.3 |
| 仪表盘 tab 1 终端实时 | 1 |
| 仪表盘 tab 2 任务队列 | 0.5 |
| 仪表盘 tab 3 H 派工时序 | 0.8 |
| 仪表盘 tab 4 NL 控制面板(System Agent intent → 白名单 action → 审计) | 1.2 |

砍掉了原本估算的"专长摘要"系统(-1 天)、Phase 3 /loop(-3 到 -5 天)。

---

## §5 与之前决策的关系

- **覆盖 / 修正**:`docs/discussions/2026-06-12-mate-dashboard.md`(原方向 C — 把它扩展成 4 tab + 写操作 + 实时视图)
- **首次新增**:Phase 3 砍掉决定 / 池化 H 架构 / Marker target 具体化 / auto-memory 替代专长摘要 / H request queue / task board snapshot
- **不变**:Phase 2C(已 done)的所有内容、roles markdown governance(评估者 17 条剩 4 条待补)
