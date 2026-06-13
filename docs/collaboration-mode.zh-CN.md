# 多终端协作模式说明 — planA-R / planA-H / execB / testC

> ⚠ **DEPRECATED · 2026-06-13**
>
> 本文描述的是**早期 file-based 协作模式**(`doc/queue/*.md`、
> `doc/WORK_HANDOFF_*.md`、`doc/_dispatch/*.md`、`doc/terminal_status/*.md`)。
> 该协议在 **Phase 2C(2026-06-10)** 已被 `claude-code-mate` 的
> **in-memory marker 协议**取代:R/H/B/C 在 stdout 末尾输出
> `<mate:handoff target="..." reason="..." />` 等 marker,mate 后端解析并
> 在 SQLite 中维护 thread 状态,**不再读不再写任何 queue / handoff 文件**。
>
> 最新协议详见:
> - `docs/discussions/2026-06-12-pooled-h-task-tracking.md`
> - `docs/discussions/2026-06-12-phase-2E-spec.md`
> - `roles/planA-R.md` / `planA-H.md` / `execB.md` / `testC.md`
>
> 本文保留为**历史档案**,**不要**按这套术语跟 user 沟通,**不要**生成
> `WORK_HANDOFF` / `queue` 文件 — mate 已经接管派工。

---

> **生效日期**:2026-06-08 拆 planA → R/H 起,2026-06-09 整理本文档
> **作用**:把当前 4 类终端的协作模式 / 工作原则 / 边界 / skill 定义集中写下,避免散落在 7+ memory + 5 skill 文件里
> **版本基准**:`.claude/commands/planA-R.md` / `planA-H.md` / `execB.md` / `testC.md` + 关键 memory(见末尾"必读 memory")

---

## 1. 整体架构

```
┌──────────────────────────────────────────────────────────┐
│                       USER                                │
│   只跟 R 终端聊需求 / 验收 / 偶尔巡 H BLOCKED              │
└──────────────────────────────────────────────────────────┘
        │
        │  自然语言聊需求 / 给业务岔口拍板
        ▼
┌──────────────────────────────────────────────────────────┐
│       planA-R 终端(可并行多个 R1/R2/R3…)                │
│       ─────────────────────────────────                   │
│       挖需求 / 探现状 / 拍业务岔口 / 写 queue 文件         │
│       讨论默认 / 不做设计 / 不写 handoff / 不派工          │
└──────────────────────────────────────────────────────────┘
        │
        │ 写 doc/queue/<slug>_<YYYYMMDD>.md (status=queued)
        ▼
┌──────────────────────────────────────────────────────────┐
│       planA-H 终端(单例 / 跑 /loop 自循环)              │
│       ─────────────────────────────────                   │
│       读 queue → 设计 handoff → 派工 → 技术验收           │
│       维护 doc/terminal_status/*.md 状态板                │
│       不写业务代码 / 不动 runtime 进程                     │
└──────────────────────────────────────────────────────────┘
        │
        │ Write doc/terminal_status/_dispatch/<term>.md
        │ + Write doc/WORK_HANDOFF_<slug>_<YYYYMMDD>.md
        ▼
┌─────────────────────────┬────────────────────────────────┐
│  execB-1/2/3/4(并行)   │  testC-1/2(并行)              │
│  ─────────────────────  │  ─────────────────────────     │
│  写业务代码:.py/.ts/.vue│  只读验证 / 跑长任务 / 跑脚本  │
│  /.ql/SQL migration     │  spike 诊断 / 全产品扩展验证   │
│  /单测                  │  收 Evidence 数据,不解读      │
│                         │  不写业务代码,不修 ql         │
└─────────────────────────┴────────────────────────────────┘
```

### 各角色定位一句话

| 角色 | 一句话 |
|---|---|
| **planA-R** | user 唯一接口,讨论需求 + 拍业务岔口 + 出 queue 文件 |
| **planA-H** | 编排核心,设计 handoff + 派工 + 技术验收(跑 /loop 自循环) |
| **execB** | 实施者,写业务代码 + 单服务/小范围验证 + 单测 |
| **testC** | 验证者,只读 SQL/grep/跑脚本 + spike 诊断 + 长跑验证 |

---

## 2. 通讯协议(物理隔离的 4 条通道)

| 通道 | 文件 | 写者 | 读者 | 触发 |
|---|---|---|---|---|
| **需求** | `doc/queue/<slug>_<date>.md` (frontmatter status) | R | H | R 完工 status=queued |
| **派工** | `doc/terminal_status/_dispatch/<term>.md` | H | execB/testC | H 派工时写,execB/testC 接受后**自己删** |
| **状态** | `doc/terminal_status/<term>.md` | 该终端自己 | H | execB/testC 翻 RUNNING/AWAITING_VERIFY/BLOCKED |
| **契约** | `doc/WORK_HANDOFF_<slug>_<date>.md` | H | execB/testC | 干活前 Read |

> **物理隔离铁律**([[feedback_dispatch_flag_transient_confusion]]):
> - 派工 flag 在 `_dispatch/` 专属通道(H 写 / execB-testC 接受即删)
> - 状态写在该终端自己的 `<term>.md`(该终端写 / 别人不碰)
> - **永不互相覆盖** — 派工和状态历史性混在一个文件 → 反复"派单丢失"的根因

### Queue 状态机

```
discussing      ← R 还在跟 user 聊
queued          ← R 完工等 H 取
blocked_design  ← H 接 + 发现设计岔口需 user 拍 + 写 banner
blocked_requirement ← H 发现需求不清 + 打回 R + R 补完再 queued
dispatched      ← H 派工 _dispatch/<term>.md 落盘
verifying       ← execB/testC AWAITING_VERIFY + H 在验
closed          ← H 验通过 + queue 文件移 doc/queue/_history/
```

### Terminal 状态机(`doc/terminal_status/<term>.md` frontmatter)

```
IDLE              ← 空闲待派工
PENDING_DISPATCH  ← Level 1 派工已写 _dispatch,等终端接(已废,改纯 _dispatch 通道)
RUNNING           ← 在干活
AWAITING_VERIFY   ← 完工等 H 验
BLOCKED           ← 卡住等解锁(unblock 字段写"解锁需要什么动作")
```

---

## 3. 各角色 skill 定义(摘要)

### 3.1 planA-R(`.claude/commands/planA-R.md`)

**做**:
- 跟 user 自然语言聊需求(挖痛点 / 列期望 / 拍业务岔口)
- 只读探现状(grep / SQL SELECT / git log / Read)
- 写 queue 文件(模板见 R skill)
- 写 user 偏好类 feedback memory

**不做**:
- ❌ 做设计(实现路径 a/b 怎么选,留 H 决)
- ❌ 拍技术岔口
- ❌ 起 handoff / 派工 / 验收 / 写终端板
- ❌ 改任何业务代码

**默认讨论模式** [[feedback_planA_discussion_default_mode]]:
- 加载时进讨论(答完概念就停)
- 触发实现词:"起 handoff"/"派工"/"出方案"/"落地"/"改哪些文件"/"工时多少"
- 触发回讨论词:`[讨论]` 前缀 / "先聊聊" / "我想想"

**完工标志**:queue 文件 `status: queued`,等 H 取。

---

### 3.2 planA-H(`.claude/commands/planA-H.md`)

**做**:
- 跑 /loop autonomous(180-1800s 自适应 cadence)
- 读 queue 文件取需求 + 合并/串行/并行判定
- 设计 handoff(scope / 不变量 / 验收 / STOP / 时间)
- 派工(Level 1 写 `_dispatch/<term>.md`)
- 技术验收(commit 稳定 + grep + SQL/MCP 实证)
- 维护终端状态板 / queue 状态 / memory / CLAUDE.md / 路线图

**不做**:
- ❌ 跟 user 讨论需求(收到需求层问题 → queue 状态翻 `blocked_requirement` 让 R 转达)
- ❌ 业务验收(技术 PASS 后翻 IDLE,业务效果 user 自己看)
- ❌ 改业务代码 / 重启长驻进程

**派工四约束**(硬规则,[[feedback_dispatch_no_premature_terminate]]):
1. **文件冲突感知** — 不把改重叠文件的派给并行终端
2. **依赖顺序** — prereq 未闭环不派
3. **WIP ≤ 3 execB 并发** — 防 working-tree 交织 + planA 自己验收瓶颈
4. **目标终端"明确完成"** — 派新工单前自检三要素:
   - A. status = IDLE(终端自翻,不是 H 单方面)
   - B. user 明确表态通过 OR H 复核 + Evidence 全
   - C. `git log --oneline -8` 看 `updated:` 戳后无新增 commit

**严禁**:
- ❌ RUNNING / AWAITING_VERIFY / PENDING_DISPATCH 时单方面改派 / 撤工单
- ❌ RUNNING 时 Edit 它正在做的 handoff scope([[feedback_planA_scope_creep_after_dispatch]])

---

### 3.3 execB(`.claude/commands/execB.md`)

**做**:
- 代码改动:.py / .ts / .vue / .ql / .qll / migration(handoff Step scope 内)
- 单服务/小范围验证:5-10 接口 facts.json 生成核验 / 单 codeql query
- 诊断:grep / Read 源码 / SQL SELECT 核根因
- 写 py 脚本**给 testC 跑**(全产品扩展用)
- 完工只报 Evidence A-X 实测数据 + 文件改动清单

**不做**:
- ❌ 长任务(>5min / 全产品扩展 / 需 run_in_background)— **转 testC 跑**
- ❌ 超出 handoff scope 的改动("顺手修"是禁区)
- ❌ 启停 celery / uvicorn / 任何长驻进程 [[feedback_execB_no_runtime_process_touch]]
- ❌ mid-task 接新任务
- ❌ 编 line 号 / 编 commit hash(找不到 = 编的)
- ❌ 跳过 STOP 条件硬闯

**完工双动作绑定**([[feedback_execB_completion_report_required]]):
- 翻 `AWAITING_VERIFY` + 板上"完工报告"段写齐(Evidence + commit + adapted + followup)
- 只翻 status 不写报告 = 验收 FAIL 退回 RUNNING

**中途发现 scope 外真根因**:
- 立即停下不擅扩
- 提诊断证据(grep + SQL + 推理 + 影响范围)
- 等 H 授权新 handoff 才动代码

---

### 3.4 testC(`.claude/commands/testC.md`)

**做**:
- 跑 py 脚本(execB 交付的全产品扩展脚本)
- 跑 SQL 只读 / grep 实测(行号必须 grep -n 前置核实)
- 跑 codeql query / bqrs decode / facts.json 重生成验证
- spike 诊断(本轮 spike-kb-interface-yh-backstage-scan-gap 是典型)
- 收 Evidence 按格式报数

**不做**:
- ❌ 方案设计 / 写 handoff
- ❌ 业务代码改动(.py / .ts / .vue / .ql / migration)
- ❌ 看到 bug "顺手修"— 发现报告不修
- ❌ 解读数据 / 延伸结论(数据归数据,结论归 H)
- ❌ 改 execB 写的 py 脚本(脚本有 bug 也只报不动)
- ❌ 启停 celery [[feedback_execB_no_runtime_process_touch]]

**长脚本可见窗口模式**(2026-05-25 立,首选):
- 弹可见 PowerShell 窗口跑(user 实时看 + 可 Ctrl+C 干预)
- 用启动器 `scripts/_testc_run_visible.ps1` + `-File`(不用 `-Command`)
- 完成哨兵 `DONE rc=N`(runlog UTF-16 用 `Select-String` 读,不用 bash grep)
- 轮询不 sleep(harness 自动通知)

---

## 4. 工作原则(跨角色)

### 4.1 角色边界硬约束 [[feedback_role_boundary]]
- 即使 user 给"你担两角色"明确指令也**不破例** — 边界即纪律
- 越界发现 → 反问 + 提议替代路径,不带病开干

### 4.2 接任务前 4 项自检 [[feedback_pre_task_role_check]]
1. **角色匹配** — 任务对得上当前角色定义?
2. **终端饱和度** — in-flight 长任务?
3. **文件冲突** — 动其它终端正在改的文件?
4. **风险/可逆性** — 含推送/删除/跨进程/外部系统?

任一不匹配 → 反问 + 提议替代路径。

### 4.3 派工前 30s 必做 [[feedback_grep_before_dispatch]]
H 派 handoff 前必做:
- `grep -rn "[需求@<日期> <slug>]"` 列同 slug 历史标签
- `git log -- <预期改动文件>` 看是否已落实

不做 = 派"已闭环"工单(空跑 execB)。

### 4.4 验收纪律
- **commits 稳定性** [[feedback_dispatch_no_premature_terminate]] 规则 1.C — `updated:` 戳后无新增 commit
- **runtime 实证** [[feedback_planA_skill_mvp_runtime_audit]] — LLM 集成单必跑 task_type SQL 看 LLM 真被调
- **Evidence 独立核** — 不信终端报告,grep/SQL/读代码自己查
- **user 浏览器实测项** — H 不主动翻 IDLE,等 user 明确"验收通过"

### 4.5 schema/字段实证 [[CLAUDE.md 强制]]
改 SQL/ORM 字段前必先实证:
```powershell
python kb_backend/scripts/_db_helper.py "SHOW COLUMNS FROM <table>"
python kb_backend/scripts/_db_helper.py "SELECT <field>, COUNT(*) FROM <table> GROUP BY <field>"
```

凭印象写字段名/枚举值 = 真实事故(PCBT 2026-05-16 / mapper_scan 等)。

### 4.6 业务需求注释规则 [[CLAUDE.md 强制]]
源于 user 业务规则的改动必须留 `[需求@YYYY-MM-DD]` 标签;再改前必 grep 核对。

### 4.7 Python 脚本规约 [[CLAUDE.md 强制]]
- 新脚本第一行:`import _bootstrap  # noqa: F401`
- 跑脚本:`conda activate kb_backend; python kb_backend/scripts/xxx.py`
- **禁止** `$env:PYTHONPATH=` / `$env:PYTHONIOENCODING=` shell 前置

### 4.8 测试产品矩阵 [[feedback_test_product_matrix]]
- 多态治理 → **umf_profit_settle**(不再用 brandApi)
- FF-L1 / L1 pipeline / 数据完整性 → **offline_pos_new**(2796 接口齐)
- sxpay_aggregate 仅 doc/ 参考,不跑 FF-L1

---

## 5. 关键 antipattern(已发生事故,各角色防御)

| Antipattern | 角色 | 防御 |
|---|---|---|
| H 派"已闭环"工单 | H | 派前 grep 标签 + git log 验落实 |
| H 派后扩 handoff scope | H | 派后必开新独立 handoff,Edit 已派 = 违纪 |
| H 给 RUNNING 终端派新单 | H | 派工四约束 1.C(commits 稳定)+ status=IDLE |
| execB 翻 AWAITING_VERIFY 不写完工报告 | execB | 双动作绑定,缺报告 = 验收 FAIL |
| execB / testC 启停 uvicorn / celery | execB/testC | 改了需重启 → 提示 user 不自己来 |
| execB scope 外"顺手修" | execB | 立即停 + 提诊断,等 H 授权新 handoff |
| testC 解读数据 / 给结论 | testC | 只报数,结论归 H |
| H 跟 user 讨论需求 | H | queue 翻 blocked_requirement 让 R 转 |
| R 越界做设计 | R | queue 写技术方案 → H Edit 删 + 退 blocked_requirement |
| 凭印象写字段名 | 全角色 | _db_helper.py "SHOW COLUMNS" 实证 |
| 并行 migration revision 撞车 | execB | H 派前预分配 revision 号或串行 |
| LLM 改 prompt 错工具名 | execB | prompt 校工具名清单(get_concept_detail not get_concept) |

---

## 6. 必读 memory(按重要度)

- [[feedback_role_boundary]] — 角色边界硬约束
- [[feedback_pre_task_role_check]] — 4 项自检
- [[feedback_terminal_roles_division]] — planA/execB/testC 分工 user 2026-05-18 立
- [[feedback_dispatch_no_premature_terminate]] — 派工四约束
- [[feedback_dispatch_flag_transient_confusion]] — _dispatch/ 通道物理隔离
- [[feedback_planA_scope_creep_after_dispatch]] — 派后禁改 handoff scope
- [[feedback_planA_scope_creep_antipattern]] — 4 自检 + 不给 RUNNING 派新单
- [[feedback_planA_discussion_default_mode]] — R 默认讨论 + 切换词
- [[feedback_planA_skill_mvp_runtime_audit]] — LLM 集成必跑 task_type SQL
- [[feedback_planA_diagnose_code_not_ask]] — 诊断 bug 先读代码不让 user 试错
- [[feedback_execB_completion_report_required]] — 完工双动作绑定
- [[feedback_execB_no_runtime_process_touch]] — 不动 runtime 进程
- [[feedback_grep_before_dispatch]] — 派工前 30s grep + git log
- [[feedback_handoff_collaboration_sop]] — handoff 5 SOP
- [[feedback_new_mode_reuse_harness_parity]] — 新模式复用骨架 + parity 清单
- [[feedback_test_product_matrix]] — 测试产品矩阵
- [[project_planA_R_H_split_architecture]] — 本架构源(2026-06-08 拆 R/H 设计源)

---

## 7. 常用文件路径速查

| 路径 | 作用 |
|---|---|
| `doc/queue/<slug>_<date>.md` | R 出需求 / H 取需求 |
| `doc/queue/README.md` | queue 协议 + 模板 |
| `doc/queue/_history/` | H 闭环后移这里 |
| `doc/terminal_status/<term>.md` | 终端自维护状态板 |
| `doc/terminal_status/_dispatch/<term>.md` | H 派工通道 |
| `doc/terminal_status/README.md` | 终端协议 + 状态机 |
| `doc/terminal_status/_template.md` | 新终端复制此 |
| `doc/WORK_HANDOFF_<slug>_<date>.md` | H 写 / execB-testC 读 |
| `.claude/commands/planA-R.md` | R skill 定义 |
| `.claude/commands/planA-H.md` | H skill 定义 |
| `.claude/commands/execB.md` | execB skill 定义 |
| `.claude/commands/testC.md` | testC skill 定义 |
| `.claude/commands/continue.md` | /continue 续推命令 |
| `CLAUDE.md` | 项目硬约束(全角色生效) |
| `MEMORY.md` | memory 索引 |

---

## 8. 文档维护

- skill 改动 → 同步本文档 §3 对应小节
- 新 antipattern 入 §5 表 + 写 memory + 回链
- 工作原则改动 → §4 + 关联 memory
- 新通讯通道 → §2

**本文档不是 skill,只是给 user 巡视 + 新终端入职的速查参考**。skill 定义的 SSOT 仍是 `.claude/commands/<name>.md`(.claude 在 .gitignore 不跨机)。
