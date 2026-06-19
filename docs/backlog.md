# Backlog

未完成 / 已知限制 / 后续改进的清单。**约定**:每条带 status + 优先级 + 上下文 link。

格式:
- **`[id]`** — 标题
  - **status**: `pending` / `in_progress` / `wontfix` / `done`
  - **来源**: 哪天哪个 commit / 哪次 conversation 提出
  - **痛点**: 用 user 原话
  - **建议修法**: 一句话
  - **优先级**: high / mid / low

---

## 当前 pending

### `[157]` 派工链显示停留在过期栈状态

- **status**: `pending`
- **来源**: 2026-06-19 conversation,在派工文件落盘工作期间被旁观提及
- **痛点**: t-mqfgby8l-bxlt 已 verified 的栈帧后续派工没及时清理,UI 派工链 [R, H, C] 持续显示,跟用户对线索"已完工"的认知不一致
- **建议修法**: Phase 3.6 后栈派生自 chain,正确性已修。但已有 thread 的 stale `call_stack_json` 不主动迁移,等下次 marker 触发自动覆盖。可加一次性 migration 全量 replay
- **优先级**: low(功能无碍,只显示)

### `[158]` 派工链 UI 跟实例 chip 双源显示割裂

- **status**: `pending`
- **来源**: 2026-06-19 user 反馈"R 在跑但派工链显 H"
- **痛点**: user 期望"派工链 = 谁在干活",但实际栈 = marker 派工历史,inst.status = 实时活跃。两者正交但 UI 只显前者
- **建议修法**: 派工链 frame 上叠加实时状态指示(用 inst.status 当 overlay,不动栈派生数据)
- **优先级**: mid(用户多次误解)

### `[159]` 多线索并发抢 H singleton — chain 段在 queue 路径里丢失

- **status**: `pending`(E2E.5 测试 `05-multi-thread.spec.js` skip 标记)
- **来源**: 2026-06-17 E2E 补覆盖时发现
- **痛点**: thread B 的 R 派 H 走 queue 路径(H 正忙 thread A),`_performHandoff` 提前 return 跳过 `appendDispatchChain`,thread B chain 不增长 → 多线索状态机失真
- **建议修法**: Phase 3 栈模型 + SlotPool + 帧 FIFO 完整实现后,queue 派工也是 SSOT 一等公民
- **优先级**: mid(实际单用户场景少见,2 个测试一直 skip 标记)

### `[160]` Phase 2D 池化 H 架构 — 任务跟踪 + dashboard 4 tab

- **status**: `in_progress`(框架已部分落地,详细规约见 `docs/discussions/2026-06-12-pooled-h-task-tracking.md`)
- **来源**: 2026-06-12 大讨论
- **痛点**: 池化 H 跨多 thread 服务时,user 看不清 H 当前在为谁服务 / 队列里还有谁
- **建议修法**: `docs/discussions/2026-06-12-pooled-h-task-tracking.md` §1-§8 已冻结
- **优先级**: mid

---

## 已知设计边界(不修)

### 栈 `frame.status` 不反映实时 inst.status

- **status**: `wontfix`(2026-06-19 设计澄清,见 commit `18b035f`)
- **意图**: 栈是 marker 派工历史的派生,inst.status 是实时活跃,两者**正交**
- **影响**: user 多次误以为"派工链显示就是当前谁在干活"
- **缓解**: 用 `[158]` 的"双源叠加"思路改 UI,不动数据模型

### 老 chain 数据格式漂移

- **status**: `wontfix`(向后兼容靠 replayChain 兜底)
- **意图**: 早期 chain 段没存 `isTerminal` 字段(undefined),后期加上后老数据无法回填
- **缓解**: `replayChain.js` 算法对 isTerminal=undefined 时按"栈只剩 R 视为 terminal" 推断

### 单 mate 进程跨多 project 共享 16 个 claude cap

- **status**: `wontfix`
- **意图**: 防 OOM,16 个进程粗略对应 32GB RAM 上限
- **缓解**: dashboard 显示 `cap` 警告,user 自己 reset 不用的实例

---

## 完成历史

| ID | 完成日期 | Commit | 标题 |
|---|---|---|---|
| `[162]` | 2026-06-19 | `8197a42` | terminal done R-notify 字符串错配 — R 收不到 [<delegate done>] 回调 |
| `[163]` | 2026-06-19 | `48e7c53` | term 报状态前必须 curl mate API 查实 — 反幻觉根治 |
| `[154]` | 2026-06-19 | `18b035f` | 栈 frame.status 跟实际 inst 状态脱节 — 改 chain SSOT 后变设计边界 |
| `[156]` | 2026-06-19 | `18b035f` | 栈双写 push 累积重复帧 — 改 chain SSOT 派生消除 |
| `[155]` | 2026-06-18 | — | 误判线索:focusedSlug 跨 project 鬼影(实际是 history API ASC 取早 5000 bug,真因 `94f012b` 修) |
| `[147]` | 2026-06-17 | `c85982c` | Phase 3.2 双写栈 |
| `[146]` | 2026-06-17 | `c85982c` | Phase 3.1 caller 栈派生 |

---

## 工作流约定

新加 backlog 条目时:
1. 取一个 id(看 task list 最大 id +1)
2. 填上面 5 个字段
3. 提交时 commit message 引用 `[id]`,方便 grep
4. 完成后挪到"完成历史"表
