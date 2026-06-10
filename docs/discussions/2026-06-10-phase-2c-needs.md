# Phase 2C 需求 & 设计沉淀(2026-06-10)

> 本文是 Phase 2C 实施的 SSOT(single source of truth)。代码注释里以 `[需求@2026-06-10]` 引用此文件 § 编号,grep 可追溯。
>
> 讨论 7 条原始需求 + 14 个细节问答 + 状态灯映射 + 一条关键设计哲学修订。

---

## §0 关键设计哲学(本次讨论得出的最重要修订)

**Mate 不是"4 个角色的 IDE",Mate 是"一个智能助手,内部恰好用了 4 个角色"。**

具体含义:
- user 视角:**一个对话框,描述需求,看进度,只在真正需要拍板时介入**
- 角色切换(R → H → execB → testC)对 user **完全透明**
- 对话流不画"切到 H"分割线、不弹切换通知、不显示角色身份标签
- **mate 不管业务验收** — H 自验技术通过 = 流程到头 = IDLE。业务验收是 user 自己的事(开浏览器实测、看效果),不在 mate 流程里
- 唯一打断 user 的:
  - **BLOCKED**(业务岔口 / 需求歧义 / 阻塞性选择)→ 线索卡片黄灯闪烁
  - 没有"等 user 验收"这种节点

这意味着 Phase 2C 的"⭐ 状态机自动驱动"是真·全自动:从 R 接收需求到 H 自验通过,**user 中间一句话都不必说**(除非 BLOCKED)。

---

## §1 7 条原始需求(user 提出)

| # | 需求原文 | 我的理解 |
|---|---|---|
| 1 | 所有任务前应该有一个环境检测的按钮 | 顶栏按钮 + modal,**手动触发**,失败**不阻塞** |
| 2 | mate 应该需要 llm 的模型,有一个默认的 claude code 终端处理工具运行时所需的 llm | **System Agent** — mate 内置 LLM,按需 spawn 短命,服务 mate 自己的智能功能(标题摘要、路由判断、回答模板) |
| 3 | 增加亮/暗主题切换按钮 | 默认 `prefers-color-scheme`,手动 override 后 localStorage 锁定 |
| 4 | 新建线索:slug 默认生成,标题可选 / 不选时自动摘要 | slug 内部 ID 不暴露;title 首轮对话结束触发 System Agent 摘要 12 字 |
| 5 | 对话框 markdown 预览模式(看 claude.ai 怎么做) | input 纯文本;**assistant 输出完整 markdown 渲染**(代码块、列表、表格、链接、代码高亮、KaTeX、code copy 按钮) |
| 6 | 上一轮答案有问题时自动生成回答模板 | 每条 assistant final 后 System Agent **一次性**生成模板 → 预填进输入框(为空才填,有内容不覆盖) |
| 7 | ⭐ R 写完 queue 自动切 H,不要再让用户感知节点 | **自动状态机**:R → H → B/C → H 自验 → IDLE,user 全程不感知;mate 流程不再加人为操作节点 |

---

## §2 14 个细节问答(a-n)

| 代号 | 问题 | 拍板 |
|---|---|---|
| a | 环境检测时机:启动每次 / 手动 / 每次 spawn 前? | **手动触发**(顶栏按钮) |
| b | 失败时是否阻塞 spawn? | **不阻塞**,user 自己看着办 |
| c | System Agent 用 `--bare` 隔离 vs 借 sibling cwd? | `--bare`(纯函数式,不污染) |
| d | System Agent 是否在 UI 可见? | 默认隐藏,**Phase 2D 监控面板可见 + cost 统计** |
| e | 主题默认是跟随系统还是默认暗? | **跟随系统,手动 override 后锁定** |
| f | title 摘要触发时机? | **首轮 user+assistant 完成立刻摘**,后续每 5 轮 user 输入再 refresh |
| g | title 摘要失败 fallback? | 用 user 第一条消息**前 20 字截断** |
| h | input 是否支持 markdown 输入? | **input 纯文本**(看 claude.ai chat),不支持 markdown 输入 |
| i | 是否需要 LaTeX/KaTeX? | **加上**(claude.ai 也有) |
| j | 回答模板触发节奏? | **只在 result 事件后触发一次**,不每次 assistant 都触发 |
| k | 模板填入输入框策略? | **空才填,有内容不覆盖**(尊重 user 已输入) |
| l | R/H/B/C markdown 是否加 mate marker? | **加** — 角色定义在 mate,sibling project 透明,一致 |
| m | 自动切角色 UI 表现? | **对话流统一,不画分割线;角色用 display_color 做微妙左侧色条** |
| n | 自动切换是否给 user 撤回窗口? | **不给** — 不增加感知节点 |
| o | BLOCKED 信号怎么呈现? | **线索看板黄灯闪烁** + 卡片提示"等待用户反馈" |

---

## §3 状态灯映射(线索看板每张卡片左上角)

| 灯 | 触发状态 | 视觉 |
|---|---|---|
| 🟢 绿 | 后台干活(R/H/B/C 任一 busy/spawning) | 常亮 |
| 🟡 黄 | BLOCKED(等 user 回答关键问题) | **闪烁**(CSS keyframes) |
| ⚪ 灰 | IDLE / disconnected / 初始 | 静默 |
| 🔴 红 | 异常(spawn 失败 / 进程 dead / 错误) | 常亮 + 卡片背景微红 |

**没有"等验收"的红色**(因为 mate 不管业务验收,见 §0)。

---

## §4 线索阶段状态机(与 §3 状态灯正交)

```
discussing → designing → executing → testing → verified
                                                  │
                                                  │ user 主动归档
                                                  ▼
                                                closed (默认主视图不显示)
```

- 所有阶段切换由 mate 自动驱动(R 完工 → H 接、H 派工 → B 接、B 完 → C 接 …)
- **verified 是终点**(H 自验通过 → 该实例 IDLE,等 user 下一条指令)
- closed **必须 user 手动**(线索看板右键 / 详情页"归档"按钮)

---

## §5 System Agent 设计(2C.1)

### 5.1 启动 argv

```
claude -p
  --input-format stream-json
  --output-format json          # 单次性结果,非 stream-json
  --verbose
  --bare                        # 纯隔离,不读 .claude/、CLAUDE.md、user 偏好等
  --no-session-persistence      # 不留 jsonl,不影响 sibling project session pool
  --permission-mode dontAsk
  --tools ""                    # 默认禁所有工具,task 自带就好
  --json-schema <schema>        # 强制结构化输出
  --max-budget-usd 0.10         # cost 闸
  --append-system-prompt <system prompt>
```

### 5.2 用例(三类 task)

| 用例 | schema | 调用方 |
|---|---|---|
| title 摘要 | `{title: string(<=24 chars)}` | 2C.5 — 首轮对话结束 / 每 5 轮 |
| 回答模板生成 | `{has_question: bool, template: string?, reasoning: string}` | 2C.6 — 每条 assistant final 后 |
| BLOCKED 信号识别 | `{is_blocked: bool, question: string?, severity: 'low'|'mid'|'high'}` | 2C.7 — 每条 assistant final 后(跟回答模板可合并一次调用) |

### 5.3 API 形态

```js
// server/system-agent/SystemAgent.js
const SystemAgent = {
  async query({ task, input, schema, maxBudgetUsd = 0.10 }) {
    // 返回 { result: <validated>, costUsd, durationMs }
  }
};
```

`task` 取值:`title-summary` / `reply-template` / `blocked-detection`,内部映射到对应 system prompt 和 schema。

### 5.4 cost / 监控

- 每次调用记 SQLite `events` 表,kind=`system_agent.query`,payload={task, costUsd}
- Phase 2D 监控面板汇总展示

---

## §6 自动状态机驱动(2C.7 ⭐)

### 6.1 角色完工信号(in-band marker)

R/H/B/C 的 system prompt(`roles/*.md` body)统一加一段教学:

> 当你完成本轮工作 + 阶段使命时,在最后一条 assistant 消息**末尾单独一行**输出:
> ```
> <mate:handoff target="<下一角色 name>" reason="<一句话原因>" />
> ```
> 没有这个 marker 等于"还在跟 user 来回中,不要切角色"。

具体规则:

| 当前角色 | 完工 marker 应指向 |
|---|---|
| planA-R | `<mate:handoff target="planA-H" />` |
| planA-H(分发模式) | `<mate:handoff target="execB" />` 或 `<mate:handoff target="testC" />` |
| execB | `<mate:handoff target="planA-H" reason="验收" />` |
| testC | `<mate:handoff target="planA-H" reason="验收" />` |
| planA-H(验收模式) | `<mate:done />`(线索完工,翻 verified) |

### 6.2 BLOCKED 信号

业务岔口 / 阻塞性疑问由 R/H/B/C 输出:

```
<mate:blocked question="<必须由 user 回答的关键问题>" />
```

StreamParser 识别后:
- 线索阶段不变(仍 designing/executing)
- 线索看板该卡片黄灯**开始闪烁**
- 对话流追加一条系统消息卡片高亮显示 question

### 6.3 fallback(marker 没出现)

- 如果 result 事件到了 + 没有 marker → 视为"还在 user 来回中",**不切角色**
- 如果连续 N 轮没 marker → System Agent 兜底判断(2C.7 第二层)

### 6.4 自动派工链路

```
[R 输出 <mate:handoff target="planA-H" />]
   ↓
StreamParser 提取 marker
   ↓
SpawnManager.handoffThread(slug, targetRole='planA-H', reason)
   ↓ 内部:
   1. ThreadStore.setStage(slug, 'designing')
   2. ThreadStore.bindInstance(slug, 'orchestrator', null)  # 解绑旧 R(可选)
   3. sendToThread({roleType:'orchestrator', text: "<thread上下文 + reason>"})
   ↓
H 接到任务,设计 handoff,输出 <mate:handoff target="execB" />
   ↓ 同上循环
```

H 的 first stdin 文本需要包含线索元信息(slug、之前的对话摘要、queue 文件路径等),让 H 拿到上下文。

### 6.5 user 体验

- 线索看板 stage 徽章:`discussing` → `designing` → `executing` → `testing` → `verified`(自动变)
- 对话流:R/H/B/C 的回复连续显示,只通过左侧 3px 色条区分(display_color)
- 没有"角色切换"任何通知

---

## §7 实施顺序(任务 ID 见 TaskList)

| ID | 子阶段 | 依赖 |
|---|---|---|
| 2C.0 | 沉淀本文档 + 建任务清单 | — |
| 2C.1 | System Agent | — |
| 2C.2 | 环境检测按钮 | — |
| 2C.3 | Markdown 渲染 | — |
| 2C.4 | 亮/暗主题 | — |
| 2C.5 | slug 自动 + title 摘要 | 2C.1 |
| 2C.6 | 回答模板自动填 | 2C.1 |
| 2C.7 | ⭐ 状态机自动驱动 | 2C.1(BLOCKED fallback 判断) |
| 2C.8 | 状态灯 + BLOCKED 检测 | 2C.7(marker 协议) |
| 2C.9 | 端到端 + commit + push | 全部 |

并行机会:2C.2 / 2C.3 / 2C.4 跟 2C.1 互不依赖,可并行。

---

## §8 验证清单(Phase 2C 完工时所有打勾)

- [ ] 顶栏环境检测按钮可点,失败不阻塞
- [ ] System Agent 三种 task 都能返回结构化结果(单测)
- [ ] assistant 消息能渲染 markdown + 代码高亮 + KaTeX + copy 按钮
- [ ] 顶栏主题切换按钮,localStorage 锁定生效
- [ ] 新建线索 dialog 无 slug 字段;创建后 title 自动摘要
- [ ] 每条 assistant 后输入框预填回答模板(空才填)
- [ ] R 输出 `<mate:handoff target="planA-H" />` → 线索自动 stage=designing + H 上线
- [ ] BLOCKED 线索看板黄灯闪烁
- [ ] H 输出 `<mate:done />` → 线索 stage=verified + 实例 IDLE
- [ ] user 全程**只在 BLOCKED 时被打断**(否则一气呵成)
