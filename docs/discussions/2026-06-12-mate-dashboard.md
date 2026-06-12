# Mate 仪表盘 — 怎么问"应用程序本身的状态"(2026-06-12)

> Backlog 沉淀,Phase 2D 一并落地。`[需求@2026-06-12]` 标签可 grep。

---

## §0 触发问题

User 实测 2C+ 后问了两个看起来很简单但点中 gap 的问题:

> 1. 界面左边的线索,都有和 PROJECT 的关联关系吗?
> 2. 如果我想问应用程序本身的状态,应该在哪儿问?

第 1 个我答了:是,`threads.project_id` NOT NULL FK,看板按 active project 过滤。

第 2 个戳破了一个 gap:**目前没有 first-class 入口问 mate 自己**。

---

## §1 当前能问"mate 自己"的渠道(都不够)

| 渠道 | 能问什么 | 局限 |
|---|---|---|
| **环境检测**按钮 | claude binary / 代理 / DB / auth 4 项 | 固定 4 项,不能自由问 |
| **终端 (N)** modal | 当前活实例列表 | 只是列表,不能聚合统计 / 不能 NL 查询 |
| 直接 SQLite | events/messages/instances 全量 | 不给 user |

缺的:

- "今天总共花了多少钱?"
- "最近 10 条 BLOCKED 是哪些线索?"
- "哪个 project 进度最慢?"
- "mate 最近有什么变化?"(version / commit / 配置改动)
- "今天 spawn 了多少 claude 进程?"

---

## §2 三个候选方向(已与 user 讨论)

| 方向 | 形态 | 工作量 | 优点 | 缺点 |
|---|---|---|---|---|
| **A — System project** | 顶栏 project 切换器加一个 🔧 System,切到它后看板是"跟 mate 对话的线索",有专门 `mateBot` 角色读 DB | 2-3 天(新角色 + DB 工具) | 跟"升维不再造"100% 一致,持久化对话历史,可回看 | 工作量最大 |
| **B — "🤖 问 mate" 按钮** | 顶栏小按钮 → 弹临时 chat dialog → 关掉就没了 | 1 天 | 轻量,Quick win | 不持久化,问完就没 |
| **C — 终端 modal 升级成仪表盘** ⭐ | 现有"终端"按钮改成"系统",modal 内统计卡片 + 实例列表 + 底部 chat 输入框跟 System Agent 自然语言问答 | 1.5-2 天 | 整合零碎信息,跟现有 UI 模式一致 | dialog 内嵌 chat 不持久化 |

**User 选 C**(2026-06-12)。

---

## §3 方向 C 实施草图(到时候照这个改)

### 3.1 改动范围

**顶栏按钮**:`终端 (N)` → `系统 (N)`,N 仍是当前活实例数。点击弹 dialog(沿用现有 `#terminals-dialog` 升级)。

**dialog 内容**(从上到下):

```
┌─ Mate 系统状态 ────────────────────────────┐
│                                            │
│ ┌──────────┬──────────┬──────────┬───────┐ │
│ │ 总线索    │ 活实例    │ 今日 cost  │ 事件   │  ← 统计卡片(4 个)
│ │   24     │    7     │ $4.21    │ 142   │
│ └──────────┴──────────┴──────────┴───────┘ │
│                                            │
│ Claude 终端实例(沿用现有列表)             │  ← 终端列表(原有)
│ ┌────────────────────────────────────────┐ │
│ │ planA-R.abc │ R │ Default │ idle │ ... │ │
│ │ planA-H.xyz │ H │ kb_back │ busy │ ... │ │
│ │ ...                                    │ │
│ └────────────────────────────────────────┘ │
│                                            │
│ ──── 问 mate 自己 ────                    │
│ ┌────────────────────────────────────────┐ │
│ │ user: 今天总共花了多少钱?             │ │  ← Chat 对话流
│ │ mate: 今天 (2026-06-12) 累计 $4.21,   │ │     (dialog 内只显示
│ │       其中 R 占 $2.10,H 占 $1.50,    │ │      最近 N 条;
│ │       execB $0.61。                    │ │      关 dialog 后保留
│ │ user: 最近 5 条 BLOCKED?              │ │      在 sessionStorage
│ │ mate: ...                              │ │      下次打开还在)
│ └────────────────────────────────────────┘ │
│ [问 mate...                          ] [发] │
└────────────────────────────────────────────┘
```

### 3.2 后端

- 新 endpoint `POST /api/system/ask` body `{question}`,返回 `{answer, sources?}`
- 内部:System Agent 加一个 task `dashboard-query`:
  - System prompt 列出 mate SQLite schema(`threads/messages/role_instances/events/projects`)+ 常用聚合查询 SQL 模板
  - Schema 输出 `{intent: "stats" | "list" | "explain", sql_or_filter, natural_answer}`
  - mate 后端拿到结果后执行 SQL 或调内部 API,把结果格式化成自然语言
- 新 endpoint `GET /api/system/stats` 返回 4 张卡片的数据(总线索 / 活实例 / 今日 cost / 今日事件)
- 今日 cost = `events` 表 kind LIKE 'system_agent.*' + claude 子进程的 result.total_cost_usd 累加(注:Max 订阅 cost 是估算,不是真扣费)

### 3.3 前端

- 顶栏按钮文案改 "系统"
- dialog HTML 调整:加 4 个统计卡片 + 加 chat 区
- chat 区:输入框 + 滚动消息列表
- session storage 持久化 chat 历史(关 dialog 不丢)
- WS 不需要新事件类型(同步 REST 问答就够,反正这是 read-only 查询)

### 3.4 安全

- mateBot 只**读** DB,不写
- SQL 走预编译模板 + 白名单表名,不让 LLM 任意拼 SQL(防止"DROP TABLE")
- 实际上更安全:**LLM 输出 intent + 参数,后端用预定义 query**,不让 LLM 直接写 SQL

---

## §4 何时做?

合并到 **Phase 2D 系统监控**里。Phase 2D 原本只是"列实例 + 全局 cap",现在加上"自然语言问答" — 仪表盘形态。

CHANGELOG.md 的 "进行中" 段已经包含 Phase 2D,补一句方向 C 即可。

---

## §5 相关 grep 标签

`[需求@2026-06-12]` — 任何为这个仪表盘做的代码改动注释里挂这个标签,grep 可回溯。
