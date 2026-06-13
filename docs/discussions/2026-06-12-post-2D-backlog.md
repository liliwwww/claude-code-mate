# Phase 2D 完工后 — 待细化 backlog

[需求@2026-06-12] user 反馈的 UX / 功能增强清单。**只记录,不实施**。逐个细化讨论确认后才动代码。

每条后面带 **状态**:`待细化` / `已细化` / `已实施` / `否决`。

---

## 1. 对话流 tool 框可折叠

**状态**:已实施(Phase 2E,2026-06-13)

**原话**:"对话列表的 tool 框,最好有个折叠按钮。默认折叠,需要的时候再打开。"

**初步理解**:主视图 conversation stream 里,assistant 输出包含的 `tool_use` / `tool_result` 块(Read/Grep/Bash/Edit 调用)默认折叠成一行简介(比如 `🔧 Grep "pattern" — 12 lines`),点击展开看完整 input / output。理由:tool 框现在占用大量垂直空间,翻历史时干扰阅读 assistant 的文字内容。

**待澄清**:
- 折叠粒度:整个 tool block 折叠成一行,还是只折叠 output(input 默认露出)?
- 多个连续 tool block:能否一次性"全部折叠 / 全部展开"?
- 是否记住用户偏好(per-thread / 全局 localStorage)?
- 一次性回显的历史 vs 流式新 tool block,折叠默认是否一致?
- 哪些 tool 必须默认展开(比如 TodoWrite 这种结构化的)?

**预估影响**:`public/app.js` 渲染逻辑 + `public/style.css`,无后端改动。

---

## 2. 角色实例的"自查通道"— 默认能跑 SQL / 通用 shell

**状态**:**重新定义,留下轮**(2026-06-13)。user 把这条改写成"子进程工具能力对齐 PowerShell"(访问本地文件 / 执 py / 调 MCP / 启动 PS 终端)— 是 role allow_rules + sibling project governance 议题,Phase 2E 不做。

**原话场景**:user 在另一个 claude 会话里碰到的现象 ——

> 这个终端目前不能执行 py 脚本。我手上只有:文件读写检索类(Read/Glob/Grep/Edit/Write)、几个 MCP server(kb 知识库问答、playwright、ssh-monitor、Gmail/Calendar/Drive)。
> 没有 Bash/PowerShell 这类通用 shell 执行工具,所以 `python _db_helper.py "SELECT ..."` 我没法直接跑。
> ssh-monitor 的 run_command 已被权限拒绝(don't-ask 模式)。
> kb MCP 那几个工具只能查接口/表/方法的固定关系,没有"对 kb_concept 跑 COUNT"这种自由 SQL 的能力。
> 不是不愿意,是工具面上够不着数据库。

user 自己提的两条路径:
- 路径 1:user 自己跑 SQL 贴回来
- 路径 2:**给 claude 开一个能跑命令的工具通道** —— 配好后 agent 就能按 CLAUDE.md 里的 `_db_helper` 自查库

**初步理解**:这条不是"mate 改造",而是 sibling project 角色配置的 governance:R/H/execB/testC 在 sibling project(比如 kb_backend、code_claude)里跑时,默认应该有 `Bash(_db_helper.py *)` 这类白名单工具,才能在 user 需求澄清时不打断地核数据。**否则每次都要切到 user 自己手工查 → 把"升维不再造"打破成"全靠 user 手动"**。

**待澄清**:
- 是 mate 集中加 `_db_helper.py` 模板(放在 mate 的 `scripts/` 让所有 sibling 复用),还是要求每个 sibling project 自己写?
- mate 是否要在 spawn 时自动给角色加 `Bash(_db_helper.py *)` / `Bash(sqlite3 *.db *)` 之类白名单?这是"角色权限模板"层面的事
- 跨 sibling project 的差异:kb_backend 用 MySQL,code_claude 可能用 SQLite — `_db_helper` 实现要 per-project 定制吗,还是抽象成 env-driven
- 跟"mate 不再造"原则的冲突:这其实是规范 sibling 的 CLAUDE.md / settings.local.json,**mate 本身不变** — 只是 mate 文档要提示 user "去 sibling 项目里写 _db_helper"
- 涉不涉及"自由 SQL"的安全风险(给角色 read-only DB 连接)

**预估影响**:可能 0 行 mate 代码改动 — 是 sibling project governance 文档 + 角色 frontmatter 模板补充。如果走"mate 内置 _db_helper 模板"路线,就要加 `scripts/_db_helper.example.py`。

---

## 3. mateTerm 直连:busy 实例的发送策略

**状态**:已实施(Phase 2E,2026-06-13)

**bug 报告**:user 在仪表盘 tab 4 选了 `planA-R · kb_knowledge`,发送"你能执行 scripts 目录下的 py 程序吗?",报错 `发送失败: instance planA-R.nxseds is busy`。

**根因**:`SpawnManager.sendDirectToInstance` 当前对 status=`busy` 的实例硬拒(see §9 mateTerm 实现)。理由是当时为了避免**正在跑 thread 任务**的实例在 `_directMode` 标志位被翻转后,result 事件被错误归属到直连(标志清除是 result 后,跟 thread 的 result 撞 race)。

**user 心智模型**:直连 = 回归 terminal 字符模式。terminal 应该允许随时输入,后端排队。"busy 不让发"违反这个心智。

**待细化**:
- A. **后端排队 + UI 灰按钮 + "queued: 1" 角标**:user 发的消息暂存,前一轮 result 后再 stdin.write。需要解决 `_directMode` 的正确归属(改成 per-message 标志而非 per-instance)
- B. **改 UX 提示**(最小改动):把"is busy"改成"终端在忙,稍后自动重试" + 前端 2-5 秒后自动重发;不动后端
- C. **允许并发写 stdin**(claude 自己有 stdin 排队):把 busy 拦截整个去掉,但要重写归属逻辑 —— 用 `assistant.message.id` 或时间戳关联 user input ↔ assistant output,不再用 `_directMode` 全局标志
- D. **干预模式不受影响**(直接是 thread 路径,本来就 queue):busy 限制只在"直连"模式;干预模式如果发出去也是 thread 排队,无 race。可以提示 user "直连模式忙的话切干预模式"

**待澄清**:
- 干预模式现在 busy 是否能发?需要测一下(我估计可以,但要确认)
- A 方案的实施成本:`_directMode` 改成 per-pending-text 的标志要重写 event 关联逻辑 —— 偏大
- 是不是直接做 B(改 UX 提示 + 自动重试)就够,A 之后真的需要再上
- "busy 自动重试"的最大次数 / 总时长(避免任务超长时一直 spin)

**预估影响**:
- B:`public/dashboard.js` 改提示 + 加 setTimeout 重试 ~10 行
- A 或 C:涉及 `SpawnManager._directMode` 重设计 + RoleInstance event 流归属,中等改动(~100 行 + 测试)

---

## 4. "卡死 busy" — 状态在主视图绿、监控视图却始终 busy(导致 §3 无法直连)

**状态**:已实施(Phase 2E,2026-06-13)— 自动 unstuck 已上线;跟 §3 关联的"排队"基础设施已就位,但 §3 完整链路下轮接

**bug 现象**:user 反馈,接着 §3 的场景继续:
- 在**主视图**(线索 list / 线索板)上,该 thread / 该 R 实例的图标显示绿色(idle / 健康)
- 同一时刻在**监控视图**(dashboard tab 1 + tab 4 实例选择器)上,同一个实例的 `status` 字段是 `busy`
- 直接结果:tab 4 mateTerm 无法直连(被 §3 的 busy 检查拦住)

**两层 bug,要分开看**:

### 4.1 实例 status 卡在 busy 不刷新(根因)

正常路径:`sendUserText` 把 status 翻 busy → 收到 `result` 事件 → status 翻回 idle。如果 result 事件**没到** / 处理出错 / 中间断了,status 就**永久卡在 busy**。

可能原因:
- claude 进程意外退出但 mate 没收到 `exited` → status 没被翻 dead
- result event 解析出错,没触发 status_change(参考 [bug@2026-06-10] 那次:`result` vs `result/success` 命中问题,可能在直连 / disconnected 路径还有遗漏)
- 上次重启时,实例处于 busy → 被 `restoreFromDisk` 强制标 disconnected,但 SQLite 里 `status` 字段还是 busy(写库时机不对)
- 用 `--resume` 续命时,resume 失败但 status 已经 busy

### 4.2 主视图 vs 监控视图 状态信号不一致(衍生 bug)

- **主视图状态灯**:`renderThreads` 算 `thread.metadata.has_pending_question` + 当前绑定实例的 status,综合给 thread 一个灯。busy 实例如果挂的 thread 没 pending question,可能算"绿"
- **监控视图**:直接展示 `instance.status` 原字段

→ 同一个实例,两个视图给出**不一样的语义信号**,user 困惑

**待细化**:
- 先抓现场:写一个 `/api/instances/:id/debug` 端点(或临时脚本),dump 该实例的:`status` / `lastActiveAt` / 最近 10 条 messages / claude pid 是否还活着 / SQLite 里的 status vs 内存里的 status 对比
- 加 **stale-busy 后台清理**:`startTtlScanner` 顺便扫,如果 `status='busy'` 但 `lastActiveAt` 超过 N 分钟(比如 5 分钟)→ 自动降 idle + emit warn 事件
- 加 **手动 unstick 按钮**:dashboard tab 1 每行加"reset → idle"小按钮(独立于 kill)
- 主视图状态灯算法对齐监控视图:busy 实例上的 thread,主视图也展示成 busy(蓝色脉动?)而不是绿
- 重启路径排查:`restoreFromDisk` 是不是该顺便把内存里的 status 强制覆盖回 disconnected(看代码已经写了 `setInstanceStatus.run('disconnected', ...)`,但要确认它写在 SQLite 里的就是 disconnected,不是 busy 复活)

**预估影响**:
- 4.1 后台扫描 + unstick 按钮:~50 行(SpawnManager + http + tab 1 UI)
- 4.2 主视图状态灯重算:`public/app.js` `renderThreads` 改 10 行;但要 user 确认"busy 的 thread 该显示什么颜色"

---

## 5. 仪表盘 tab 1:显示终端当前使用的模型 + 支持改模型

**状态**:**部分实施**(Phase 2E,2026-06-13)— 读模型已上(currentModel + claudeCodeVersion 字段 + chip popover 显示);**改模型(killing + respawn with --model)留下轮**

**原话**:"系统监控、终端实时列表中,最好能把当前终端只用的模型显示出来。列表后面,还支持改模型。"

**初步理解**:
- **读**:tab 1 每行加一列 `Model`,显示该实例当前 spawn 用的模型(`claude-opus-4-7` / `claude-sonnet-4-6` / `claude-haiku-4-5` 等)
- **写**:行尾加一个 model 下拉框或"改模型"小按钮,点了能切换

**当前状态**:
- 角色 frontmatter 没有 `model` 字段(`session_ttl_hours` 有,`display_color` 有,但 `model` 缺)
- `buildSpawnArgs` 没传 `--model`,意味着每个 child 用 claude CLI 的默认模型(通常 Opus,也可能是 user 在 claude config 里改过的)
- SystemAgent 是例外 — 显式 `--model claude-haiku-4-5`(代码硬编码,为了省钱)
- 所以"当前模型"在 mate 这边其实**不可知** —— 我们没记录每个实例 spawn 时用了什么模型

**待细化**:
- 加 `role.model` frontmatter 字段(可选,空 → 用 claude 默认)?默认值咋选?R/H/B/C 都 Opus,SystemAgent Haiku?
- "当前模型"怎么读?
  - a) spawn 时如果 `role.model` 显式指定 → mate 自己记录,显示这个
  - b) 没指定 → 显示 `(default)` 或留空,user 不知道实际用了什么
  - c) 解析 `system/init` 事件里 claude 自报的 model(probe findings 里有这个字段吗?要查)— 这条最准确
- "改模型"语义:**改成新模型必须重启 session**(claude 不能热切换)。需要 user 确认 + 杀掉 child + `--resume <session-id> --model <new>` 续上(这条要测兼容)
- 持久化:per-instance 的模型偏好存哪?改完后 disconnected 恢复时要不要复用?
  - 选 A:存 `role_instances.preferred_model` 列(新加)
  - 选 B:存 `thread.metadata.preferred_models.<role>`(per-thread per-role)
  - 选 C:存 role frontmatter(全局默认,user 改了等于改全局)
- 改模型这个动作要不要走 §8.9 mateBot 那种"白名单 action + 确认"流程?还是 dashboard 直接按钮 + 确认 dialog
- 用户场景:啥时候真的需要改?
  - debug 跑很贵的任务时,中途想降级 Sonnet 省钱
  - SystemAgent 之外的 micro-task 想用 Haiku
  - Opus 答非所问时换 Sonnet 试试

**预估影响**:
- 读模型:0 行(如果走 system/init 解析)~ 30 行(加 frontmatter 字段 + RoleCatalog 解析 + snapshot 暴露)
- 改模型:中等,~80 行(http 端点 + 后端 kill+resume+model swap + UI 下拉 + 确认)
- DB schema v5(如果选存 `role_instances.preferred_model`)

---

## 6. Anthropic 订阅配额耗尽时的处理策略

**状态**:已实施(Phase 2E,2026-06-13)

**user 问**:碰到 token 使用到达订阅计划限额会怎么办?

**当前状态**:几乎啥都没做。
- 唯一相关代码:`SpawnManager._wireListeners` 里 `if (eventType.startsWith('result') && raw.is_error !== true)` 短路了 marker 派工 —— 误打误撞,至少 H 不会因为 error 还自动派下去死循环。
- 但**没有**专门识别 rate-limit / quota,**没有** banner,**没有**禁发,**没有**降级,**没有** reset 时间倒计时。
- user 直接体验:发完看到红字 error,自己猜啥时候能再发。

**user 场景**:Anthropic Max plan(OAuth) — 5h 滚动窗口配额。触发不是月限额,是等几小时就恢复。**最关键**是 user 知道啥时候恢复 + 期间别让 mate 空转撞墙。

**待细化清单**(P0/P1/P2/P3 草分,user 拍板):

P0(必做):
- 识别配额 error:解析 `result.is_error=true` 的 payload + 文本特征(`usage limit` / `rate_limit` / `quota_exceeded` 等)
- emit `system.quota_exhausted` 事件,带 reset 时间(从 error 文本 ISO 时间戳里抠 — 要先采样真实 error 长啥样)
- 顶栏红条 banner + 倒计时
- **全局暂停自动派工**:`_handleMarkers` 在 quota 期间 short-circuit,所有 handoff 都拒(避免 H 一直撞)

P1:
- 新 send 拒绝:`POST /api/threads/:slug/message` + `/api/instances/:id/direct-message` 全部 409 + UI 灰按钮
- SQLite 持久化 quota 状态(`mate_quota_state` 表 / meta 行),restart 后 banner 还在

P2:
- 多实例去重 banner(N 个同时撞只显示 1 条)
- **自动降级**:SystemAgent 类小任务允许跑 Haiku;主对话流明确拒绝 + 提示 user

P3:
- 配额预警:剩 10% 时预警

**待澄清**:
- ~~error payload 长啥样?要先采样真实 error 一次~~ **已解决,见 §6 修正**
- "自动降级到 Haiku"用户认不认?(可能 user 觉得"Opus 不能跑就停手别凑合")
- 暂停自动派工的恢复机制:reset 时间到 → 自动恢复,还是要 user 手动点"已恢复"按钮?
- ~~mate 不知道当前用了多少~~ **已解决,见 §6 修正 — claude 主动推送 utilization**
- 跟 §5 改模型联动:配额降级 + 用户手动改模型,谁优先

**预估影响**:中等。P0+P1 大概 200 行(SpawnManager + http + WS + UI banner + SQLite 表);DB schema v5。

### §6 修正(2026-06-12 后续发现)

查 mate.sqlite 发现 **claude 主动推送 `rate_limit_event`** 事件,mate 已经全部入库但没消费。这彻底改变实现前提。

事件 schema(实测):

```json
{
  "type": "rate_limit_event",
  "rate_limit_info": {
    "status": "allowed" | "allowed_warning" | <还没观察到 rate_limited 类型>,
    "resetsAt": 1781654400,                // Unix 秒,reset 时间
    "rateLimitType": "seven_day" | "five_hour",
    "utilization": 0.6,                     // 仅在 allowed_warning 时有,allowed 时缺
    "overageStatus": "rejected",
    "isUsingOverage": false,
    "overageDisabledReason": "org_level_disabled"
  },
  "uuid": "...",
  "session_id": "..."
}
```

**实现路径变了**:
- ~~解析 error 文本~~ → **订阅 `rate_limit_event` 事件**(stream-json 流里就有)
- ~~等真撞墙~~ → **从 allowed_warning 开始就预警 + 暂停 / 降级**
- ~~猜 reset 时间~~ → **resetsAt 直接给**
- ~~按 plan 分 5x/20x~~ → **不用关心,claude 自动告 utilization**

新的 P0 任务清单:
- `streamParser.js` 加 `rate_limit_event` 解析,emit `instance.rate_limit` 事件
- SpawnManager 维护**全局** `quotaState = {fiveHour: {status, util, resetsAt}, sevenDay: {...}}`(全 mate 共用一份,因为同账号同 quota)
- bus.publish('system.quota_update', quotaState) 通知前端
- UI 顶栏 banner 显示当前 utilization + reset 倒计时(seven_day / five_hour 两条)
- `allowed_warning` 状态(util ≥ 0.85?阈值待定) → 暂停自动派工 + UI 红条
- `_handleMarkers` 在 quota warning 时 short-circuit + 给 user 选项"继续(我接受可能撞墙)"

剩余盲区:
- 真撞墙时 `status` 字段长啥样?现在只看到 `allowed` / `allowed_warning`,要等到 100% 才能看到最终态 — 见 §7 测试方案

### §6 需求强化(2026-06-12 user 拍板)

**user 原话**:"撞墙后,你要要记下恢复时间,重置流量后,要自动恢复执行。"

**核心约束**:**全自动**,user 不守在屏幕前。

**完整生命周期**:

```
正常态                                                    
  │                                                       
  ▼                                                       
检测撞墙  ── rate_limit_event status=rate_limited (待观察)
  │           或 utilization=1.0                            
  │           或 result.is_error=true 且文本特征             
  ▼                                                       
进入 QUOTA_PAUSED 态                                      
  - 持久化 resetsAt 到 SQLite(mate_quota_state 行)         
  - 启动 setTimer(resetsAt - now)                          
  - 顶栏红条 banner + 倒计时显示                            
  - 全局拦截:                                              
    * _handleMarkers 全部拒(handoff/done/blocked 都不 fire) 
    * 新 user send 排队(不拒绝,UI 灰 + 显示"队列: N")      
    * 已 spawn 的 child 不杀(claude 自己会等;杀了反而丢 ctx)
                                                          
  ▼                                                       
等到 resetsAt 时刻                                        
  - 自动恢复:emit system.quota_resumed                     
  - banner 消失                                            
  - 自动 flush 暂存的 user send 队列(按 thread/instance 顺序)
  - 自动 flush 暂存的 handoff(按 marker emit 的原始顺序)    
  - SQLite mate_quota_state 行清空                         
                                                          
  ▼                                                       
回到正常态                                                
```

**关键设计点**:

1. **持久化 resetsAt 必须**:即使 mate 自己重启了,撞墙状态也得**自动恢复**,banner 仍展示,setTimer 重新挂上(`resetsAt - now`)。否则 user 必须人肉守 mate 进程,违背"自动恢复"承诺
2. **暂存队列**:撞墙期间 user 还能发,**进队不进 stdin**;一旦恢复,自动按顺序 flush
3. **暂存 handoff**:撞墙瞬间正好有 marker 待 fire,缓存到 quota_resumed 事件后再触发(可能需要扩 `_handleMarkers` 的逻辑,加 "deferred markers" 表)
4. **多窗口同时撞**:5h 和 7d 任一撞了都进 PAUSED;只有**两个都恢复**才回正常态
5. **child process 处理**:撞墙瞬间 child 进程**不杀**,因为 session_id 续命有价值;只是 mate 不再往它 stdin 写东西。child 自己撞 API 错误就在它自己历史里有记录,无伤大雅
6. **setTimer 兜底**:setTimer 精度差,加 SystemAgent / background loop 每 30 秒 double-check `now >= resetsAt`,避免漏触发

**待澄清**:
- 暂存队列的最大长度(防止 user 灌爆)?TTL?
- 用户发现自己挂了想紧急切别的工具,**手动 abort 暂停态**的入口要有吗?(预设:有,顶栏 banner 上加"×"按钮)
- 自动 flush 时如果某条 send 又触发新的撞墙怎么办?(预设:再次进 PAUSED,新的 resetsAt 覆盖,继续等)
- 7d 撞了恢复要 7 天 — 这种长周期里 user 显然不愿等,需不需要"切到其他模型(API key)继续"的逃生通道?(关联 §5 改模型 + §6 自动降级 Haiku)

**DB schema v5**:加 `mate_quota_state` 表
```sql
CREATE TABLE mate_quota_state (
  rate_limit_type TEXT PRIMARY KEY,    -- 'five_hour' | 'seven_day'
  status          TEXT NOT NULL,       -- 'rate_limited' | 'allowed_warning' | 'allowed'
  utilization     REAL,
  resets_at       INTEGER NOT NULL,    -- Unix ms
  updated_at      INTEGER NOT NULL
);

CREATE TABLE mate_pending_sends (    -- 撞墙期间的暂存
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL,     -- 'user_send' | 'handoff_marker'
  payload_json    TEXT NOT NULL,
  enqueued_at     INTEGER NOT NULL
);
```

**预估影响**:
- 在 §6 P0+P1 基础上**追加 ~150 行**
- 主要工作:`mate_quota_state` + `mate_pending_sends` 持久化、QuotaState class、setTimer + cron double-check、`_handleMarkers` 的 PAUSED 拦截、user send endpoint 的 PAUSED 排队、自动 flush 链路

---

## 7. 测试方案:如何在不烧钱前提下,验证 quota / rate_limit_event 处理

**状态**:已实施(Phase 2E,2026-06-13)— QuotaState + 单测 fixture + dev 注入路径(开发期模拟)就绪

**前提**:user 现在 88%,极接近 7 天窗口上限。不想为了测试浪费剩下的 12%,也不想搞坏正在跑的真实任务。

**两层测试目标**:
- 目标 A:验证 mate 能**读懂 + 展示 utilization**(预警态,allowed_warning)。这个**马上可做** — 88% 实际上已经够 warning 了,只要 user 发一条消息就能拿到带 utilization 的事件
- 目标 B:验证 mate 能处理**真正撞墙**(status 变成 `rate_limited` 或类似)。这个**得等自然撞墙**,要么 user 自己刷高,要么用一个测试号刻意撞

**可行测试路径**:

P0(零成本):
1. 让 user 在主视图随便发一条消息(轻量,几百 token 就够)
2. 看 mate.sqlite 最新一条 `rate_limit_event` 的 utilization 数字 — 应该 ≈ 88%
3. 验证 §6 P0 改造后,这条事件能被解析 + 推 banner
4. 这一步**确认 §6 的预警链路 ok**

P1(真撞墙,有风险):
1. 用一个不重要的 sibling project 跑一个"扫全 repo"的任务,故意烧到 100%
2. **代价**:user 真撞了 7 天窗口,接下来几天都用不了 Opus 全力,只能等到 2026-06-17 reset
3. 收益:看到真实的 `rate_limited` 态 payload
4. **替代方案**:跟着自然使用,2-3 天内自然会到 100%,届时**主动抓现场**

P2(隔离测试,理想方案):
- 准备一个**测试用 Anthropic 账号**(单独 OAuth),把 mate 的 `ANTHROPIC_*` 配置切到测试号
- 测试号刻意小额度撞墙,不影响生产 quota
- 缺点:user 没说有第二个号

**模拟测试(写代码测,不真撞)**:
- 给 `streamParser` 写单元测试,喂一个伪造的 `rate_limit_event` payload(`status: rate_limited`, `utilization: 1.0`)
- 验证 mate 的 banner / 暂停派工链路正确触发
- 不验证"真实 claude 撞墙时的 payload 长啥样",但**验证 mate 对 payload 的反应是正确的**
- 加 dev 端的 `/api/dev/inject-rate-limit` 端点,后端假装收到一个 rate_limit_event 推 WS(开发测试用,prod 关掉)

**推荐路径**:
- 立刻做 P0 + 模拟测试(组合):让 user 发一条消息抓真实 allowed_warning 形态,用伪造数据补充 rate_limited 形态做单测
- 等自然撞墙时,**抓真实 payload 入库**,然后 retrofit 单测让数据真实
- P1 不推荐,代价高于收益

**预估影响**:
- P0:0 代码改动,纯查库
- 单元测试 + dev 端点:`probe/` 加 `rate_limit_event_fixtures.json` + `tests/` 加 streamParser test + http.js dev 端点 — 大概 80 行

### §7 测试结果(2026-06-12 18:24 实测)

| 配额 | utilization | status | resetsAt |
|---|---|---|---|
| five_hour | **0.91** | allowed_warning | 2026-06-12 19:30 |
| seven_day | 0.60 | allowed_warning | 2026-06-17 08:00 |

结论:
- §6 前提**完全成立** — utilization 实时,resetsAt 直接给,5h / 7d 双轨独立
- `allowed_warning` 阈值看起来 **≥ 0.6 即触发**(7d 60% 已 warning;不是只在 ≥0.85)
- mate **每次 user 发消息**都会拿到至少 2 条 rate_limit_event(各一条 type)
- 没等到 `rate_limited` 终态(91% 还没撞墙),需要继续观察

---

## 8. 消息显示顺序倒置 — USER 在下,ASSISTANT 在上

**状态**:已实施(Phase 2E,2026-06-13)

**bug 报告**:user 在 §7 测试时发现 —— "显示列表的时候,USER 在下面,ASSISTANT... 在上面。这个问题也记录一下。没有按照时间顺序显示。"

**初步判断**:消息流应该按 `ts ASC`(时间顺序)展示 — user 输入在上,assistant 回应在下。当前实现某处反了。

**待澄清**:
- 哪个 view?
  - 主视图的 thread 对话流(`#stream` in `app.js`)?
  - dashboard tab 4 mateTerm 对话流(`#mt-stream` in `dashboard.js`)?
  - 还是两边都反?
- 是**整体 list 倒序**(从最新往老排)还是**单个 user-assistant pair 内部倒置**(assistant 显示在 user 之前)?
- 是**首次加载历史**反了还是**WS 流式追加**反了,或两者都反?
- 跟 `result` 事件 vs `assistant` 事件的到达顺序有关吗?
  - 一种可能:claude 的 stream-json 流里 `assistant`(final)事件可能在 `user` 事件 echo 后,也可能在前 — 看具体 schema
  - 另一种可能:WS 追加用了 `insertBefore` 不是 `appendChild`(参考 ticker 用的就是 `insertBefore`,可能渲染流也错用了)

**待定位**:
- 先抓主视图(发个消息,看 user 卡片和 assistant 卡片的相对位置)
- 再抓 dashboard tab 4
- 看是 history 接口返回顺序问题(`/api/threads/:slug/history` 用 `ORDER BY ts ASC`,理论上对)还是前端渲染问题
- 检查 `app.js` `renderEventInStream` + `dashboard.js` `renderMatetermMessage` 调用方向

**预估影响**:
- 如果是渲染顺序 bug:`appendChild` vs `insertBefore` 一行改完
- 如果是 history 排序 bug:SQL `ORDER BY` 改
- 如果是事件流时序问题(`result` 事件先到导致先渲染):需要按 ts 排序后再渲染
- 小改动,但要先抓现场定位是哪个 view + 哪条路径

---

## 9. Markdown 代码块渲染空白 — 框出来了但里面没东西

**状态**:已实施(Phase 2E,2026-06-13)

**bug 截图**(2026-06-12 18:32):assistant 在"根因"小节下输出了两段引用代码:
```
**调用方** (ADR-006 Phase 1 MVP 新代码) `kb_backend/app/services/qa_hybrid_lg_agent_service.py:1729`:

<code block 1 — 应该有代码内容,实际空白>

**被调方** `kb_backend/app/core/llm_client.py:143` 的签名:

<code block 2 — 应该有代码内容,实际空白>
```

行内 inline code(文件路径 `kb_backend/...:1729`)**渲染正常**(绿色文件路径标签);多行 fenced code block **框正确画出来了,但内容空白**(可滚动但啥也没有)。

**可能原因**(待定位):
- a) assistant 输出 `python ... ` 时,语言 hint(`python` 等)导致 marked + highlight.js 解析路径失败,内容被吞
- b) assistant 这条是**流式 partial** 状态,代码块的 content 还没到完整 fence 就被渲染了,后续 delta 没追加
- c) 我们的渲染管线:`marked.parse(text)` + 自定义 renderer 重写了 code 块,可能 escape / sanitize 把内容清空了
- d) WebSocket 流里这条 assistant 是 **多段 partial concat** 完成的,某一段拼接漏了
- e) result 事件里的 `result` 字段(终态文本)和增量 partial 不一致,UI 用了 partial 没切到 final

**待定位**:
- 该消息的 raw payload 是啥(查 `messages` 表的 `payload_json`)?代码块内容**入库时**就是空,还是入库时有但渲染时丢
- `public/app.js` 里 `renderEventInStream` / markdown render pipeline 看一遍,看有没有针对 fenced code 的特殊 hook 出错
- 试一下纯 marked.parse(rawText) 在 console 里直接渲染同样 input,看是否复现
- 类似 bug 是新发现的,还是历史就有但 user 之前没注意

**预估影响**:
- 如果是 highlight.js 语言失败:加 fallback 到 plaintext,~5 行
- 如果是 partial concat 漏拼:streamParser 缓存逻辑要查,中等改动
- 如果是 escape sanitize 出错:`marked` 的 sanitizer 配置改,几行

**关联**:跟 §1(tool 框折叠)是同一文件、同一渲染管线,实施时可一起看

---

## 10. 派工沉默 — marker 发了之后 UI 没任何反馈

**状态**:已实施(Phase 2E,2026-06-13)

**bug 场景**(2026-06-12):user 在主视图看到 R 输出末尾打了 `<mate:handoff target="planA-H" reason="..." />`,之后**终端没有任何响应**。user 不知道:
- 派出去了吗?
- mate 收到 marker 了吗?
- H 在想中吗,还是没起?
- 是不是 silently 出错了?

**理论上应该看到**(`app.js` 530+):
```js
} else if (type === 'thread.handoff') {
  pushTickerEvent('handoff', `${payload.from} → ${payload.target}  ...`);
  if (payload.threadSlug === state.focusedSlug) {
    const node = makeMsg('system handoff-card', `→ ${payload.target}`, payload.reason);
    els.stream.appendChild(node);
  }
}
```

→ 顶栏 ticker + 对话流插入一张灰色卡片"→ planA-H ..."。

**实际**:user 说"啥都没看到"。可能的几种 root cause:

- a) **MarkerDetector 没匹配**:assistant text 里 marker 周围可能有特殊空白 / unicode / 多行格式,正则没匹配上 → handoff 根本没触发
- b) **`_performHandoff` 出错被 silent catch 吞了**:
  ```js
  try { await this._performHandoff(inst, handoff.target, handoff.reason); }
  catch (e) { console.warn(...); }
  ```
  console.warn 在 server log,**前端看不到**。如果是这种,user 完全沉默 + 后台 log 有错
- c) **WS 卡片渲染了但 user 没注意**:`makeMsg('system handoff-card', ...)` 的 CSS 是不是太低调?灰底灰字,跟普通文本融在一起,中间 R 的回应很长的时候,卡片"消失"在长 list 里
- d) **H 已经在 spawning,但 UI 没"正在派工 ..."进度态**:派工是异步的,H spawn 启动有几秒延迟,期间 user 完全不知道发生了啥
- e) **WS 断了**:WS 连接虽然 onclose 会自动重连,但断连瞬间错过的事件**永久丢失**(没有 catch-up 机制)

**待细化**:

立刻可做的诊断:
- 查 `data/mate.sqlite` events 表里**最近的 thread.handoff event**是否存在,能直接判定 marker 是否被 fire 过
- 查 mate server log(`/tmp/mate-server.log`),有没有 `handoff marker failed` warn
- 看那条 thread 的 metadata,`current_role_instances.orchestrator` 字段是不是写入了

UX 改进方向:
- 卡片视觉**强化**:加图标 / 边框 / 显眼配色,不要"灰底灰字"
- 加**派工进度态**:卡片显示"→ planA-H 正在初始化 ..." → "正在处理" → "已响应"(根据 H instance.status 切)
- 加**摘要行**:R 的 marker 行下方,**前端自动插一行**"⏩ 已派给 planA-H · ${reason}"(基于 R 自己的 marker text,不依赖 WS 回执);WS 真到了再"勾选"
- **失败时显式提示**:`_performHandoff` 的 catch 改成 bus.publish('thread.handoff_failed') → 前端红条卡片"派工失败: <reason>"
- WS catch-up 机制:重连后拉一次 `/api/events?since=<lastReceivedTs>` 补齐错过的事件

**预估影响**:
- 卡片视觉强化:CSS + makeMsg 改 ~10 行
- 进度态:中等,需要 frontend 跟踪每个 handoff 的状态机
- 派工失败提示:`_performHandoff` catch 加 bus.publish,~10 行
- WS catch-up:加 `since` query 参数 + 后端 events 表查询,~30 行

---

## 11. Doc drift — role markdown 还留有 file-based 协作模式残留措辞

**状态**:已实施(Phase 2E,2026-06-13)

**bug 场景**:同 §10,user 看到 planA-R 输出:

> "派工这步是编排(planA-H)的活:它会拍 A/B 修复路径、**写 WORK_HANDOFF**、再派给 execB。"

"WORK_HANDOFF" 是**旧 file-based 协作模式**的产物(根 dir `协作模式_planAR_planAH_execB_testC_20260609.md` 那份的术语)。Phase 2C 起 mate **改成 marker-based 内存派工**,queue / handoff 文件**不再读不再写**。

但 R 仍这么对 user 说,意味着:
- 要么 `roles/planA-R.md` body 里还残留这种措辞
- 要么 R 通过 auto-memory / 之前 session 的对话记忆里"知道"WORK_HANDOFF 这个词,自然带出来
- 要么 R 读了 sibling project(`D:\dev\kb_backend`)根目录的`协作模式_planAR_planAH_execB_testC_20260609.md`,被"传染"了旧协议措辞

**user 体感**:R 在用一套 mate 早就不用的术语跟 user 沟通,造成认知错乱(以为派工还要看 queue 文件)。

**待细化**:
- 巡检 `roles/*.md` body,grep 所有 `queue` / `WORK_HANDOFF` / `dispatch file` / `doc/queue` / `doc/handoff` 这类措辞,改成 "mate marker `<mate:handoff target=... />`"
- 决策:`协作模式_planAR_planAH_execB_testC_20260609.md` 这份原始 doc 是**保留作为历史**还是**加 deprecated 横幅**?(R/H 可能扫到它就被传染)
- 决策:role markdown 里要不要加一段**显式声明** "mate 已经接管派工。**不要**输出'我去写 WORK_HANDOFF'之类的字眼,只用 `<mate:handoff />` marker"
- 同步检查 mate 自己的`CLAUDE.md` 系列文档,有没有也提了旧协议的措辞

**关联**:跟 §10 是同一个 user 体感问题(派工不透明)的两面 — §10 是 UI 不显,§11 是 R 说话错。两个都解才能让 user 体验回到"派工清晰可见"。

**预估影响**:
- `roles/*.md` 4 个文件文字修订 + roles re-load(grep 完看才能估)
- 主版`协作模式_..._20260609.md` 加 deprecated 横幅,~5 行
- 可能 0 行代码改动,纯文档治理

---

## 12. 发送按钮无即时反馈 — 自己的消息要等服务端回显才出现

**状态**:已实施(Phase 2E,2026-06-13)

**原话**:"我输入完问题,点击发送。应该在对话列表立即看到我的问题,这样,才代表系统收到请求了。现在点击按钮没有反应,过一段儿时间才有响应。体验不好。"

**根因**:当前 send 流程(`app.js`):
1. user 按钮点击 / Ctrl+Enter
2. fetch `POST /api/threads/:slug/message`
3. 等待 mate 把消息写到 child stdin
4. claude 流出 `user` echo event(几百 ms - 几秒)
5. WS 把 echo 推回前端 → 渲染 user bubble

这意味着 user 自己的消息要**等 round-trip**才出现,中间是**静默期**。如果中途网络慢或 mate 阻塞,user 完全不知道点击有没有生效。

**修复方向**(乐观 UI):
- 点击瞬间**立刻在对话流插一条临时 user bubble**(灰色 / 半透明 / 带"sending..."角标)
- 输入框立刻清空 + 失焦
- fetch 成功 → bubble 转正(去掉 sending 角标)
- fetch 失败(网络错 / 409 busy / 404) → bubble 标红"发送失败,点击重试"
- WS 推来真的 user echo event 时,用一个 dedup key(比如 fetch 返回的 message id,或时间戳 + text hash)合并到临时 bubble 上,不重复展示

**待澄清**:
- dedup 怎么实现?fetch 响应里没返回 message id(目前 endpoint 只返 `{ok: true, instance: ..., routedTo: ...}`)— 需要后端补返 id 或前端用 (text + ts) 模糊匹配
- 失败重试是当条原地重试,还是回填到输入框?
- 同 §10 一脉相承的 UX 病:"用户操作 → 沉默 → 不知道发生了什么"。这个 backlog 项跟 §10 应该一起设计

**关联**:跟 §10(派工沉默)同源 — 都是"操作发出去到反馈出现之间没有过渡态"。同一时间一起做,UI 一致性更好。

**预估影响**:`public/app.js` send handler + 对话流 dedup ~50 行;后端 send endpoint 返回 message id ~5 行;mateTerm tab 4 同样问题要一起改 ~20 行

---

## 13. 全局 cap 计数口径错误 — disconnected 实例不该算占用

**状态**:已实施(Phase 2E,2026-06-13)

**bug 报告**(2026-06-12):顶栏红条 banner 显示"实例数 16/16 — 已达全局软上限"。user 反馈"明显没有到 16 个终端"。

**实测**(查 SQLite):
- mate 当前算的 alive:**17**(3 busy + 14 disconnected)
- 真正有 child process 的:**3**
- Cap:16
- 真实跑着的 claude 进程:用 PowerShell 查也确认 3-4 个左右(早期遗留进程除外)

**根因**:`SpawnManager._checkGlobalCap`:
```js
const alive = [...this.instances.values()].filter((i) => i.status !== 'dead').length;
```

把 `disconnected`(SQLite 有记录、有 session_id、但 child 进程没活)也算进 alive。**disconnected 实例占系统资源 = 0**:
- 没有内存(child process 不在)
- 没有 API token 消耗
- 没有占 Anthropic 配额
- 只是 SQLite 里的一行记录 + 内存里一个 RoleInstance 对象(轻量)

**user 心智**:"实例数 = 现在跑着几个 claude" — 不该把"睡着的可唤醒记录"算进去。

**累积效应**:多 project + 多次创建 R → disconnected 实例越攒越多。一周后可能 50+ disconnected,但实际同时跑的只有 2-3 个。cap 形同虚设(永远红条),user 麻木。

**修复方向**:

A. **改计数口径**(推荐):
```js
const alive = [...this.instances.values()].filter(
  (i) => ['idle', 'busy', 'spawning'].includes(i.status)
).length;
```
只算真有 child 的。disconnected 不占 cap。

B. **改 banner 文案**:`alive=17(含 14 个待复活),活进程 3 / 上限 16` — 让 user 知道两层计数。

C. **加 disconnected 清理策略**:超过 N 个 disconnected(比如 30)就批量标 dead,腾出 SQLite。

**待澄清**:
- 选 A 后,撞 cap 时 spawn 一个新的会不会就反向把更多 disconnected 唤醒?(disconnected lazy resurrect 触发就变 busy → 占 cap → 又超)。需要复算"潜在 alive" = busy + disconnected,作为 cap 检查的另一个维度
- B 双口径 banner 文案怎么排版才不挤
- cap 默认 16 在 disconnected 不算的口径下,可能要降到 8 或 10(实际不会有那么多并发活进程)
- §4.1 "卡死 busy" + 这条一起看 — 都是状态字段语义被 misused

**关联**:跟 §4(卡死 busy 状态不刷新)+ §3(busy 时直连被拒)都是**实例状态字段语义混乱**的家族 bug,实施时一起治理。

**预估影响**:
- A:`SpawnManager._checkGlobalCap` + `_countAliveInstances` 改 ~5 行
- B:banner 文案 + `system.cap_warn` payload 加 disconnected count ~10 行
- C:TTL scanner 加 disconnected 老化逻辑 ~20 行

---

## 14. "现在到底是哪个 term 在跑" — 缺一个明确的 SSOT 实时视图

**状态**:已实施(Phase 2E,2026-06-13)— 顶栏 chip + 4 列 swimlane popover 已上线

**场景**(2026-06-12):
- §6 预测的撞墙发生:token 到达限额 → 运行中断
- user 不知道发生了啥,输入"继续"想推进
- 系统反馈:"execB-1 TTL 过期(idle 2.1h > 2h),下次 send 起新 session"
- user 一头雾水:
  - 这跟"继续"有啥关系?
  - 我刚才在哪个 thread 上发的?
  - 现在到底有几个 claude 在跑?
  - 派工链路走到哪一步了?
  - 我"继续"那条消息进 R 了还是被吞了?

**根本问题**:**user 没有一个明确的地方,一眼看清"此刻 mate 内部到底在跑啥"**。

现有视图的不足:
- **主视图**:线索板有状态灯,但只反映该 thread 的局部状态,不告诉 user"整个 mate 在跑啥"
- **顶栏 ticker**:事件流式滚动,**短期内有用,过了就消失**,没法回查"3 分钟前 H 接到 handoff 了吗"
- **顶栏 banner**:只有 warn / error,**正常态空白**
- **仪表盘 tab 1 终端实时**:已经在那了,但
  - 它是**静态轮询**(10s 一次刷新),不是 push,有滞后
  - 显示 status + memory + 活动,但**没有"链路"概念** — user 看不到"这条 user input → 进了哪个 thread → 走到了 R → R 调了 tool → 还在 busy / 已 idle"
  - **没在主视图随时可见**,user 要切 tab,中断当前对话

**user 真正想要的(我推测)**:

一个**"现在运行态"**的小面板,**永远可见**(顶栏下、对话流右上角,或固定一个小方块),内容包括:

1. 此刻有几个 child 进程真的活着(idle / busy 分开计数)
2. 每个 busy 实例:在哪个 thread 上、跑了多久、上次活动几秒前
3. 最近一次 user input:进了哪个 R、目前 R 是 idle / busy / blocked
4. 待处理的派工(handoff queued)有几个、目标是谁
5. quota 状态(5h / 7d 利用率,reset 倒计时)
6. 黄/红条:TTL 临近、quota warn、cap warn 等

→ user 一眼能回答:"我刚才那条消息到底被谁收了、走到了哪一步、需不需要等。"

**设计候选**:

A. **顶栏右侧固定的实时面板**(像 IDE 的 status bar):一行紧凑 chip,例:
```
[3 idle · 1 busy@spike-x] [Q:0] [5h:91%↘19:30] [7d:60%↘06-17]
```
点开展开详情。

B. **侧抽屉**:从主视图右侧滑出"运行态"抽屉,显示完整树形 (R → H → execB → testC 的 swimlane)。

C. **强化主视图线索板**:每个 thread 行下面挂一个 mini-timeline,显示该 thread 当前活跃实例 + 它们的 busy 时长。

D. **WS push 替代轮询**:仪表盘 tab 1 改成 WS 实时推 → 不滞后,但 user 还得切 tab。

**我的倾向**:**A 顶栏 chip + 点开展开** + **D WS 推送替代 tab 1 轮询**。两个互补:
- A 满足"瞥一眼就知道"
- D 满足"想看详细去 tab 1"

**待细化**:
- 主视图顶栏空间够吗(已经有 project picker + banners + 多个按钮)?要不要把"环境检测"等次要按钮收进菜单
- "最近一次 user input 走哪了"这种信息怎么 track — 后端要不要新增一个 `last_user_send` 内存字段
- 派工待处理队列(handoff queued)在哪里?目前架构是同步 fire 的,没"queued" 概念 — 要不要先有 queue 再监控
- 黄/红条聚合:TTL + quota + cap 现在是分别 publish 的,UI 要做统一聚合方便 user 抓 priority

**关联**:这条**汇集**了多条 backlog 子问题的 UI 表达:
- §3 / §4(busy 状态不准)→ 这个面板会暴露准确性问题
- §6(quota 处理)→ quota chip 是这里的子组件
- §10(派工沉默)→ 派工 chip 解决"派出去没"的疑问
- §12(发送无即时反馈)→ "最近一次 user input"chip 让 user 立刻看到"系统收到了"
- §13(cap 计数口径)→ "活进程数"chip 的语义要正确

**预估影响**:大。属于"独立模块",~400 行(后端实时聚合 endpoint + WS push + 顶栏 chip + 展开面板)。但**做完一次性解决一片**。

---

## 本轮 backlog 汇总(2026-06-12 整理)

到目前共 14 项 backlog。按**痛苦度**和**关联度**分组,推荐"统一升级一轮"的组合:

### A 组:可见性 / UX 反馈链(最痛,本轮**第一优先**)

| # | 项目 | 关键作用 |
|---|---|---|
| §14 | 实时运行态 SSOT 面板 | **主线** — user 永远能瞥一眼知道"在跑啥" |
| §12 | 发送即时反馈(乐观 UI) | user 点完按钮立刻看到自己消息 |
| §10 | 派工沉默 — 派出之后 UI 进度可见 | 解决"派出去了吗"疑问 |
| §11 | role markdown 旧协议措辞清理 | R 不再说"WORK_HANDOFF",避免 user 认知错乱 |

→ 这组合做完,user **再也不会问"现在到底咋样了"**。

### B 组:状态语义家族 bug(中等优先,跟 A 组解耦但 A 组里会"暴露"它们)

| # | 项目 |
|---|---|
| §3 | mateTerm busy 实例不让发(改 UX 提示 + 自动重试,B 方案) |
| §4 | "卡死 busy" 状态不刷新(后台 unstick + 主视图状态灯对齐) |
| §13 | cap 计数口径错(disconnected 不该算占用) |

→ 这组做完,**实例 status 字段在所有视图含义一致**。

### C 组:Quota 防撞墙(用户已经撞了,**实战刚需**)

| # | 项目 |
|---|---|
| §6 | 订阅配额耗尽自动暂停 + 自动恢复 |
| §7 | 测试方案(模拟 + 等真实样本)|

→ §6 在 §14 的实时面板里出 chip,串起来很自然。

### D 组:模型管控(中低优先,可延后)

| # | 项目 |
|---|---|
| §5 | 显示 + 改模型 |
| §6 P2 | 配额降级到 Haiku |

### E 组:对话流渲染细节(低优先,有空再做)

| # | 项目 |
|---|---|
| §1 | tool 框可折叠 |
| §8 | 消息顺序倒置 bug |
| §9 | 代码块空白渲染 bug |

### F 组:Sibling project governance(独立方向)

| # | 项目 |
|---|---|
| §2 | 角色实例的 SQL 自查通道 |

---

## 推荐统一升级方案

**本轮做 A 组 + B 组 + C 组**(共 9 项)— 这是**user 当前最痛的部分**,做完后:
- 派工/发送链路全程可见,不再沉默
- 实例状态语义统一,各视图不打架
- 撞墙不再让 user 一脸懵,自动暂停 + 自动恢复
- §11 顺带把 R 说话错的认知错乱也清了

**D / E / F 留到下一轮**。

预估工时:大致 **3-5 天**(主要是 §14 实时面板 + §6 quota 全链路 + 一堆状态语义清理)。改完打 Phase 2E。

具体先后 / 拆分要不要细化,等 user 拍板再说。

---

# 2026-06-13 追加 — UI 对话流细节(架构治理 + 角色重命名后发现)

## §15. user bubble dedup 验证(可能 §12 实现 bug)

**状态**:待细化

**user 提问**:"对话框中,有一个蓝色背景的 USER 标题的框,是干什么用的?"

**初步判断**:那是 §12 乐观 UI 的 user message bubble — user 自己发的话。但 user 这个问法**可能**意味着他看到了:
- 1 个乐观 bubble(`appendOptimisticUserBubble` 立刻渲染)
- 1 个 echo bubble(WS `instance.event` 带 `eventType=user` 后 `renderEventInStream` 重渲)

如果显示**两个**,说明 §12 dedup 没生效。要查:
- `payload.clientMessageId` 在 WS event 里是否真的有
- `appendOptimisticUserBubble` 设的 `data-client-id` 是否匹配
- `CSS.escape(clientMessageId)` 查询是否能命中

**待澄清**:跟 user 确认看到 1 个还是 2 个。1 个就只是认知问题(他不知道那是自己的发言),2 个就是 §12 dedup bug。

**预估影响**:0(认知)~ 10 行(dedup 修复 + 单测)

---

## §16. 流式 assistant 气泡默认折叠

**状态**:待细化

**user 提议**:"过程中的 assistant... 也没有折叠,我认为,也可以默认折叠。"

**当前行为**:`renderEventInStream` 收到 `stream_event` 的 `content_block_delta` 时:
```js
const elNode = makeMsg('assistant streaming', 'assistant…', '');
els.stream.appendChild(elNode);
// 每个 delta:
s.el.querySelector('.body').textContent = s.text;  // 累积更新
```

**目标行为**:流式期间气泡默认折叠成一行 `▸ assistant 写中... (1.2 KB · 32s)`,user 想看再点开。result 到达时:
- 选项 a:**继续折叠**(摘要 / 字数 / 耗时)
- 选项 b:**自动展开**显示完整最终回复(默认 markdown render)
- 选项 c:**结尾"展开看完整"按钮**让 user 主动决定

**待细化**:
- result 到达时的默认展开 vs 保持折叠 — user 拍一个
- 摘要里显示什么:字数 / 字节 / 耗时 / tool calls 数?
- 这个偏好持久化吗:每次新 page load 默认 / localStorage 记?

**关联**:跟 §17 一起做(同一开关)

**预估影响**:`renderEventInStream` stream_event + assistant 分支 + 新 CSS `.msg.assistant.collapsed` ~30 行

---

## §17. 流式渲染 vs 不显示的性能成本

**状态**:待细化

**user 提问**:"是不是流式输出要比不显示内容界面处理要慢?"

**确认**:是。**浏览器端**慢,后端无差异。

| 步骤 | 流式开 | 流式关 |
|---|---|---|
| WS 包数 | 每轮 ~50-200 个 stream_event delta + 1 assistant + 1 result | 1 assistant + 1 result |
| DOM 更新 | 每 delta `body.textContent=...` 触发 reflow/repaint(50-200 次/轮)| 1 次(收到 final 时 markdown 一次性渲染)|
| 浏览器 CPU | 高 | 低 |
| 显示延迟感受 | 快(立刻看到字)| 慢(几秒静默后突然出完整文本)|
| Server CPU | 一样(stream_event 不持久化,只 fan-out)| 一样 |
| 网络带宽 | 每 delta JSON 包(MB 级 / 长回复)| 单 final 包 |

**实施方向**(跟 §16 整合):

**chip 旁边加小开关**:
```
[0 idle · busy:H-1] [排队:0] [quota:ok] [0/8]     [📺 实时 ☑]
```

或 settings dialog 里加一项 "assistant 流式渲染:实时 / 折叠"。

- **实时**(默认):当前行为
- **折叠**:`renderEventInStream` 的 `stream_event` 分支变成"只更新摘要标签 + 计数",不动 `textContent`。result 到达时按 §16 的 a/b/c 决定如何展开。

预估收益:
- 长回复(>2KB)时 browser CPU 下降明显
- 多 thread 同时 streaming 时 UI 不卡
- 多浏览器开 dashboard 不重 fanout 负担

**待细化**:
- 开关位置:chip 旁 / 顶栏 / settings dialog?
- 默认值:实时(保现状)/ 折叠(用 user 偏好默认)?
- 持久化:localStorage / per-project / per-thread?
- 是否也影响 mateTerm tab 4?(理论上一样的渲染管线,顺手做)

**预估影响**:`renderEventInStream` 改 ~20 行 + 开关 UI ~30 行 + localStorage 偏好 ~10 行 = 总 60 行
