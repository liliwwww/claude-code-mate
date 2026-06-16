# RFC: Per-thread Call Stack as State SSOT

**Date**: 2026-06-16
**Status**: Draft(讨论稿,user 已逐场景认可,待实现)
**Author**: discussion 沉淀

---

## Motivation

当前 mate 的状态模型是 **append-only event log**(`thread.metadata.dispatch_chain` + 一堆旁路 metadata 字段),状态从事件流后验重建。这导致:

1. **caller 查找算法有 bug 漏洞**(2026-06-16 撞 H 死循环 bug 770ec88):反向扫 chain 找 caller 不够鲁棒,callback handoff 被误识为 caller
2. **stage 漂移**(2026-06-16 t-mqfgby8l-bxlt 卡 designing):因为没正确翻 verified
3. **breadcrumb 显示要"自愈缺帧"**(commit caa20a5):前端要 reconstruct 栈并兜底
4. **多个旁路字段冗余**:`has_pending_question` / `last_questioner_role_type` / `current_role_instances` 互相重复,容易不一致
5. **PendingSends 状态机另起炉灶**:跟 chain / metadata 是两套字段,要同步

**核心洞察(user 提)**:每个 term 是同步函数,每条线索是一次 main() 调用,handoff = push 栈帧,done = return。
**用栈替代事件日志做 SSOT,以上 5 项一类 bug 自然消失**。

---

## Core Abstractions

### Per-thread Call Stack

每条线索一个独立栈。栈帧从底到顶 = R → H → B/C 的调用链。

```python
class Stack:
    frames: List[Frame]

class Frame:
    role: Literal["R", "H", "B", "C"]
    slot: int | None           # B/C 1-4,H 始终 1,R 不用
    instance_id: str | None    # 实际 claude 进程,可能 stale
    session_id: str            # --resume 续命用
    bound_thread: str
    status: FrameStatus
    pushed_at: int
    last_activity_at: int      # hang scanner 用
    retry_count: int = 0       # transient crash 计
    pending_question: str | None    # blocked 时填
    pending_question_meta: dict | None  # severity / kind 等

class FrameStatus(Enum):
    running              # LLM 正在跑这帧
    awaiting_callee      # 我下方 frame 在跑,我等返回
    awaiting_resource    # 我被 push 但 slot/H 还没拿到
    blocked              # 等 user 输入
    needs_kick           # mate 重启遗留,等 user 触发
    done                 # 即将 pop(transient)
```

### Project-level Slot Pools

```python
class SlotPool:
    H_slot: SlotState                    # 1 个 H slot
    B_slots: dict[int, SlotState]        # 4 个 B slot
    C_slots: dict[int, SlotState]        # 4 个 C slot

class SlotState:
    current_owner_thread: str | None     # 哪条 thread 的 frame 占着
    fifo_queue: deque[str]               # 等该 slot 的 thread 列表(FIFO)
    instance_id: str | None              # 占 slot 的 claude 进程
```

**R 不在池里**,per-thread 1:1。`parallelism_limit=10` 是软上限(全 project 同时活跃 R 上限)。

### 4 种 Frame 返回值

```python
class DoneResult:
    summary: str
    # 正常完工,pop 把 summary 给 caller

class BounceResult:
    reason: str
    # H 专用 — "我搞不定,弹回 R 让 R 跟 user 聊"

class RejectResult:
    reason: str
    subkind: Literal["task_invalid", "crash", "timeout", "conflict"]
    retries_attempted: int = 0
    # 任务坏 / 进程挂 / 超时 / 冲突 — pop 把 reject 给 caller
    # 每个中间 frame 自己决定 catch(自己处理)or re-emit reject 冒泡
```

### Marker 协议(语义一对一)

每个 marker 都对应一种栈操作,**禁止歧义**:

| Marker | 栈操作 | 角色 |
|---|---|---|
| `<mate:handoff target="mate-B-N" />` | push B-N frame | R/H |
| `<mate:handoff target="mate-C-N" />` | push C-N frame | H |
| `<mate:handoff target="mate-H" />` | pop self,DoneResult | B/C 用,代替"callback" |
| `<mate:bounce reason="..." />` | pop self,BounceResult | **H 专用**,代替 `<mate:handoff target="mate-R">` |
| `<mate:done summary="..." />` | pop self,DoneResult | 所有角色 |
| `<mate:reject reason="..." />` | pop self,RejectResult | 所有角色,**不再带 `bounce_to`** |
| `<mate:blocked question="..." />` | 栈不动,frame.status=blocked | R/H |

---

## Boundary Scenarios — 8 项决议

### 1. H bounce 回 R → pop 带 BounceResult

H 觉得"我搞不定,需要 user clarify" → `<mate:bounce reason="..."/>`:
- pop H frame
- R frame 收 BounceResult,跟 user 沟通后:
  - 再 `<mate:handoff target="mate-H">` push H 重试
  - 或 `<mate:done summary="...">` 弃任务

**栈高度受控** ≤ 4 帧(R/H/B 或 R/H/C),不会因 clarify 多轮无限增长。

**协议升级**:`<mate:handoff target="mate-R">` 改名为 `<mate:bounce>`,语义对齐"函数 return"。

### 2. `<mate:blocked>` 是 frame 状态,不是栈操作

- frame.status: running → blocked
- pending_question 字段填问题
- 栈结构**不动**
- user 输入(主视图)→ 直接灌给栈顶 frame → frame.status: blocked → running

**`blocked` / `awaiting_callee` / `awaiting_resource` / `needs_kick` 是 4 种 Suspended 子状态**,机制一样(等外部事件唤醒),只是事件源不同。

`thread.metadata.has_pending_question` / `last_questioner_role_type` / `last_questioner_instance_id` 三个旁路字段**全删** — 栈顶就是 SSOT。

### 3. `<mate:reject>` 是 pop 带 RejectResult

- pop 自己
- RejectResult 给 caller
- caller 自己决定 catch or re-emit reject 继续冒泡(try/catch 语义)
- 多层 unwind 自然发生,无需 `bounce_to` 字段

**整栈 unwind 完毕 → thread 进 `aborted` stage**(新增,跟 verified 平级)。

**协议升级**:`<mate:reject reason="..." bounce_to="..." />` 简化为 `<mate:reject reason="..." />`。

### 4. 多 thread 抢 project 唯一 H

H 是 project singleton。N 条线索同时要 H → FIFO 排队。

```
t-X.stack = [R_X, H(running)]                # 占着 H
t-Y.stack = [R_Y, H(awaiting_resource, q=1)] # 等 H 第 1 位
t-Z.stack = [R_Z, H(awaiting_resource, q=2)] # 等 H 第 2 位
```

- frame 状态 `awaiting_resource` + `queue_position` 字段
- H 释放(t-X 的 H frame pop)→ 队首 t-Y 自动转 running
- UI breadcrumb 显排队位置

**PendingSends 表替换**:fifo_queue 在 SlotPool 里(内存),持久化由 stack 持久化负责(重启 reload 时从所有 stack 顶 awaiting_resource frame 重建 queue)。

### 5. H 指定的 B/C slot 在跑别 thread

跟场景 4 同机制,只是粒度不同(per-slot FIFO 而非 project-level)。

- H 指定哪个 slot 由 H 的 LLM 决定(根据 task board snapshot 中的 Pool state)
- mate 不替 H 决策,只做 syntax 校验(slot 1-4 有效)
- **slot 被占 ≡ 该 slot 的 frame 在某栈上**(无论 running / awaiting_callee / blocked / awaiting_resource 子层)
- frame pop 才释放 slot

H 选 slot 的智能策略放 mate-H.md 强化(亲和性、idle 优先、不同 thread 间冲突时优先亲和)。

**Syntax 校验**:`<mate:handoff target="mate-B">` 不带 slot 应当 reject(强制 H 显式选)— 但当前实现是自动选,可以分阶段切换。

### 6. mate 重启栈 reload — lazy

- 启动时:从 DB 反序列化所有 thread 的 `call_stack_json` 重建栈结构
- **不主动 spawn 任何 claude 进程**
- `running` frame 一律转 `needs_kick`(实例死了,逻辑该跑但没 LLM)
- `awaiting_callee` / `awaiting_resource` / `blocked` 保留
- 重建各 slot 的 FIFO queue(扫所有 stack 顶 = awaiting_resource 的 frame,按 pushed_at 排序)

`needs_kick` 唤醒:user 点击该 thread 任何方式发消息 → lazy resurrect 实例 + 重发上次 user_to_role msg(从 messages log 找)+ frame.status → running。

UI 上 `needs_kick` 的 thread 显 ⏸ 图标,提示"上次激活: <time>,继续 / 取消栈顶"。

### 7. 栈帧对应的 term 中途 crash

term 进程意外死(OOM / hang / API 错 / malformed)→ mate 检测到 instance.exited 事件:

```python
def on_term_crash(thread_id, frame, crash_info):
    frame.retry_count += 1
    if frame.retry_count < 2 and crash_info.category in ["api_error", "hang"]:
        # transient → lazy resurrect 同 session_id + 重发 last user msg
        resurrect_and_retry(frame)
    else:
        # 致命 / 重试用完 → pop with RejectResult(subkind="crash", retries=N)
        pop_frame_with_result(thread_id, RejectResult(
            reason=crash_info.reason,
            subkind=crash_info.category,
            retries_attempted=frame.retry_count,
        ))
```

新增基础设施:**hang scanner**,每 30s 扫所有 thread 栈顶 frame.last_activity_at,超 `HANG_TIMEOUT`(默认 10min)→ 当 hang 处理。

mate-H.md 强化:**连续 ≥3 次 callee crash → 必须 reject 升级,不要无脑 retry**。**subkind="hang" 优先改派 C(visible PS protocol)而非 retry B**。

### 8. 干预模式 user 直发

- **干预 intervention** = signal/interrupt 到栈顶 frame,**栈不变** — 给 frame 的 instance 灌 user msg
- **直连 direct** = 栈外的 instance 直接对话(不挂任何 thread),保留现状

intervention 严格只允许**针对栈顶 frame**(校验 `target_instance == stack.top.instance_id`)。

主视图 user 输入 = "路由到栈顶 frame 的简写";dashboard 干预 = "显式选 instance 的等价物"。两条入口合并成同一 `inject_user_msg_to_top_frame(thread_id, text)` 函数。

直连模式跟栈模型**正交**,不参与栈状态机。

---

## 控制流 / 数据流分离

**控制流** = 栈本身,后端 SSOT,push/pop 由 marker 触发。

**数据流** = 实时流,跟控制流并发:

```
bus.publish(`thread.<slug>.event`, ...)   # 所有 frame 输出聚合
UI 单订一个 topic 看完整流
```

UI 视角:**栈顶是谁就实时显谁的输出**。栈是后端控制结构,UI 不感知(只看 breadcrumb 显当前帧名 + 实时流)。

---

## 删除的旁路状态

以下字段全部可删(SSOT 在栈):

| 旧字段 | 替换 |
|---|---|
| `thread.metadata.current_role_instances` | 栈帧里的 `instance_id` |
| `thread.metadata.has_pending_question` | `stack.top.status == "blocked"` |
| `thread.metadata.last_questioner_role_type` | `stack.top.role` |
| `thread.metadata.last_questioner_instance_id` | `stack.top.instance_id` |
| `thread.stage` | 派生:`stack.top.role` 的 stage_name;栈空 + DoneResult 弹底 = `verified`;栈空 + RejectResult 弹底 = `aborted` |
| Marker 的 `bounce_to` 字段 | 栈知道往哪 pop |
| `PendingSends` 表 | `SlotPool.fifo_queue` + frame.status=awaiting_resource |
| `_currentPendingSend` 实例字段 | 实例当前服务的 thread = stack.top.bound_thread |

---

## `dispatch_chain` 角色变化

从**状态 SSOT** 退化为**append-only journal**:

- 仍记每个 push/pop 事件(给 dashboard 历史浏览看)
- **不参与任何状态决策**
- 灾难恢复:可 replay 还原栈状态(冗余备份)

UI 端 breadcrumb 不再需要"自愈缺帧"或"isTerminal 兜底"(commit caa20a5 / be60fb2 的逻辑可全删)— 直接渲染 `thread.call_stack`。

---

## Stage 重映射

```python
def derive_stage(stack: Stack, thread_outcome: str | None) -> str:
    if thread_outcome == "verified":
        return "verified"
    if thread_outcome == "aborted":
        return "aborted"
    if not stack.frames:
        return "discussing"    # 新建,还没 push 任何 frame
    top = stack.top()
    return {
        "R": "discussing",
        "H": "designing",
        "B": "executing",
        "C": "testing",
    }[top.role]
```

`thread.stage` 字段可保留(派生量,UI 直接查询方便),但**写入只通过栈变化触发**,不直接 setStage。

---

## Migration Path

新栈模型不是颠覆式重写,可以分阶段切:

### Phase 1: 数据模型并行
- 新增 `threads.call_stack_json` 字段
- 旧 `dispatch_chain` 继续维护(冗余写入)
- 新增 SlotPool 数据结构,跟 PendingSends 并行
- 后端读老字段 + 写双字段,**用户无感**

### Phase 2: 老 thread 历史 replay
- migration 脚本:把所有现有 `dispatch_chain` replay 推出 `call_stack_json`
- 校验:replay 出的栈跟事件日志最终状态一致

### Phase 3: 切换 SSOT
- 改 `_performHandoff` / `_performDone` / `_performReject` / `_performBlocked` 直接操作栈
- `dispatch_chain` 退化为只写不读(audit log)
- 删 caller 查找算法(770ec88 bug fix 那段)
- 删 metadata 的 4 个旁路字段

### Phase 4: 协议升级
- `<mate:bounce>` 替代 `<mate:handoff target="mate-R">`
- `<mate:reject>` 去 `bounce_to` 字段
- 强制 `<mate:handoff target="mate-B-N">` 必须带 slot
- 同步更新 mate-R.md / mate-H.md / mate-B.md / mate-C.md prompt

### Phase 5: 清理
- 删 `PendingSends` 表
- 删 `thread.metadata` 4 个旁路字段
- 删 `_currentPendingSend`
- 删 caller 反向扫算法

每阶段独立可回滚。Phase 1+2 是数据迁移,产品行为不变;Phase 3 切 SSOT 是关键节点;Phase 4 是协议升级(需要重启所有 role 实例让新 prompt 生效)。

---

## Tradeoffs

### 优势

| | 收益 |
|---|---|
| caller 反向扫 bug 那类自然消失 | 770ec88 fix 不再需要 |
| breadcrumb 自愈兜底不再需要 | caa20a5 / be60fb2 删 |
| 多个旁路状态字段不再不一致 | DB 干净 |
| reject / bounce / done 语义统一 | LLM 容易写 prompt 不混 |
| 资源竞争用 FIFO queue 自然描述 | PendingSends 替成 SlotPool |
| 重启 lazy reload 资源 0 消耗 | mate 启动飞快 |

### 代价

| | 工作量 |
|---|---|
| 新数据结构 + 持久化 | ~150 行(Stack/Frame/SlotPool) |
| 重写 MarkerDispatcher 4 个 _perform 函数 | ~200 行 |
| migration 脚本 replay 老 chain | ~100 行 |
| 前端 breadcrumb 直接读栈 | ~80 行(删旧逻辑 + 加新) |
| Dashboard 控制 tab 适配 | ~50 行 |
| 协议升级 + 4 个 role prompt 改 | ~100 行 |
| **合计** | **~700 行变更 + 测试** |

### 风险

| 风险 | 缓解 |
|---|---|
| migration 把老 chain replay 错 → 老 thread 状态损坏 | Phase 1+2 并行写,出错可回滚到旧字段 |
| 栈模型在并发资源争抢下逻辑死锁 | R/H/B/C 协议是 DAG(B 不主调 H),无死锁可能 |
| Phase 4 协议升级时,在跑的 role 实例不认新 marker | Phase 4 配合 mate 重启,让所有实例加载新 prompt |

---

## Open Questions(后续讨论)

1. R 的 parallelism_limit=10 超出时,新线索 R 是排队还是 reject 创建?(R 没池,这是"全 project 同时活跃线索数"软上限)
2. 优先级:加 `thread.urgency` 字段让高优插队 FIFO?
3. 持久化 schema 细节:`call_stack_json` schema 版本号怎么演进?
4. 跨 project 派工(将来):H-project-A 派工给 B-project-B 的栈模型扩展?
5. 监控指标:每个 thread 的栈高度统计 / FIFO 等待时长 / 重试率 — 进 dashboard 哪里?

---

## 参考

- bug 排查脉络:commit 770ec88 (H 死循环修)、caa20a5 (breadcrumb 自愈)、be60fb2 (isTerminal 兜底)
- 当前实现:`server/spawn/MarkerDispatcher.js` / `server/spawn/QueueDispatcher.js` / `server/spawn/PendingSends.js`
- 讨论上下文:本次会话 8 个边界场景,user 全部认可上面方案
