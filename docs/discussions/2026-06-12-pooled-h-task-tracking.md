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

---

## §6 同日补充:audit + 需求层 gap 决策(2026-06-12 后半场)

User 要求对架构整体做 audit。审出 7 项技术细节 + 3 个需求层 gap + 2 个边缘场景。全部拍定。

### 6.1 技术细节(7 项)

| # | 项 | 决策 |
|---|---|---|
| 1 | R parallelism_limit | 改 `parallelism_limit: 10`(从 3),Phase 2D 加全局 soft cap=16 |
| 2 | Marker `target="execB-2"` resolver | Phase 2D 必须实现:先 role 名(`execB`)→ 失败试 slot 名(`execB-2`)→ 都失败报错 |
| 3 | `inst.threadSlug` 语义 | 拆成 `threadSlug`(per-thread 绑定,R 用)+ `currentTaskSlug`(per-task 动态,pooled 角色用) |
| 4 | execB 完工 binding | 保留为"上次的 executor",不清。H 下次派工可优先复用同实例(context warm) |
| 5 | H request queue 优先级 | **user > 自动 handoff**(user 交互延迟敏感) |
| 6 | Marker 优先级 | `done > blocked > handoff`,前者出现后续静默忽略 + log 警告 |
| 7 | 稳定 slot 名 schema | 加 `pool_slot` 字段;`role_instances.id` 保持 `${roleName}.${random}`;UI 显示 `display_name = ${roleName}-${slot}` |

### 6.2 需求层 3 个 gap

#### Gap 1:user 输入路由 = "谁问送回谁" + **execB/testC 不直接问 user**

```
execB/testC 遇决策点
   ↓
emit <mate:handoff target="planA-H" reason="需要决策: <问题原文>" />
   ↓
H 判断:
   ├─ 能答 → H 直接答 + 决策过程显示到 thread 流(user 看得见,但不用拍)
   └─ 答不了 → H 输出问题给 user(thread 黄灯 + question)
                  ↓
              user 在该 thread 回答
                  ↓
              路由到 H(last_questioner = H)
```

**协议改动**:
- execB.md / testC.md **砍掉 `<mate:blocked question="..." />` 的教学**(那是 Phase 2C 加的)
- 改成统一"需要决策时,handoff to planA-H,reason 写问题原文"
- mate `sendToThread` 路由依据 `thread.metadata.last_questioner`(只可能是 R 或 H 实例)
- `has_pending_question` 黄灯触发:**只看 R / H 的 SystemAgent reply-template 判断**,execB/testC 不参与黄灯
- 默认 `last_questioner` = bound R(discussing 阶段 fresh thread)

#### Gap 2:不做通知,黄灯 + user 自查

仪表盘 / 黄灯闪 = 唯一信号源。**无浏览器 Notification,无声音**。

省 0.5 天 + 不需要 user 授权浏览器 API。

#### Gap 3:System thread(singleton,持久化)

| 维度 | 实现 |
|---|---|
| 数量 | 全 mate 唯一 1 条 |
| 承载 | 复用 threads 表,隐藏 system project(`project_id=0`,name='System',db.js 初始化时 ensureSystemProject) |
| slug | 固定 `mate-self` |
| 入口 | 仪表盘 tab 4 "对话控制" embed |
| 生命周期 | 启动时不存就建,永不归档 |
| 对话伙伴 | 新角色 **mateBot**(只读 DB + 白名单 action 工具) |

跟普通 thread 共用全部基础设施(WS / 持久化 / markdown / reply-template / 状态灯)— **代码层节省巨大**,无需为 dashboard chat 写独立持久化层。

### 6.3 边缘场景

- **多 project 全局 cap**:soft(超了 queue + banner 红条),不硬拒
- **跨 thread BLOCKED 通知**:不做。Workaround = H 在 question 文本里说明跨 thread 影响,user 自己跨 thread 看

### 6.4 隐藏后续 backlog(Phase 2D 之后,不阻塞)

- thread 长期累积压缩策略(jsonl 膨胀 / UI 加载慢)
- thread fork 快捷
- thread 导出 markdown(不急)
- 跨 mate-installation 状态同步(不做)

---

## §7 4 个角色 markdown 待改清单(Phase 2D 起步 zero-code 改动)

| 文件 | 改动 |
|---|---|
| `roles/planA-R.md` | `parallelism_limit: 3 → 10`;加 "auto-memory 只记 project-wide 真理,thread-specific 留对话" 教学 |
| `roles/planA-H.md` | 加 task board snapshot 协议说明;加 "execB/testC 升 query 时先判断能否自己答,不能再问 user 不绕 R";同 auto-memory 教学 |
| `roles/execB.md` | **砍 `<mate:blocked />` 教学**;改"需要决策统一 handoff to planA-H reason=问题原文";同 auto-memory 教学 |
| `roles/testC.md` | 同 execB |
| `roles/mateBot.md` | **新建**:System thread 用,只读 DB schema 说明 + 白名单 action(`kill_instance / archive_thread / set_stage / no_op`)|

加 auto-memory 教学共 4 处(R/H/B/C);新增 mateBot 1 个文件。

---

## §8 Phase 2D 实施清单(最终冻结)

| 阶段 | 内容 | 工时 |
|---|---|---|
| 8.1 | 4 个角色 markdown 修订 + 新建 mateBot | 0.5 |
| 8.2 | DB schema:role_instances.pool_slot 字段 + System project (id=0) ensure | 0.3 |
| 8.3 | SpawnManager 改池化(acquire 选 slot/创建 slot/queue + slot resolver + threadSlug 拆分) | 1.5 |
| 8.4 | MarkerDetector 支持 target=具体 instance + 优先级处理(done > blocked > handoff) | 0.3 |
| 8.5 | H request queue + task board snapshot 注入 + user 输入路由(last_questioner) | 1.2 |
| 8.6 | 仪表盘 tab 1 终端实时(含 memory 状况) | 1 |
| 8.7 | 仪表盘 tab 2 任务队列 | 0.5 |
| 8.8 | 仪表盘 tab 3 H 派工时序 | 0.8 |
| 8.9 | 仪表盘 tab 4 NL 控制面板 + mateBot 接入 system thread | 1.5 |
| 8.10 | session TTL 防生锈(`recycle_idle_min`)+ 全局 soft cap | 0.5 |
| 8.11 | 端到端冒烟 + commit + push | 0.5 |

**总计 8.6 天**(原估 6-8,因加 mateBot/system project + cap 软化精细化,微涨)。砍掉 Gap 2 的通知模块(原 0.5 天),余净 ~8 天。

整体范围已经冻结。从 §8.1 起按顺序实施,每个阶段独立 commit + push。
