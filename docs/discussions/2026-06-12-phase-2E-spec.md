# Phase 2E 实施 Spec(2026-06-12 锁定)

本文是 Phase 2E **唯一 SSOT**,Phase 2D 完成后,所有 backlog(`2026-06-12-post-2D-backlog.md`)中**进入本轮的项**全部明确化、可直接动手实施。

---

## §0 范围 / 不范围

**本轮做**(A + B + C + E + §5 读模型):

| 编号 | 项 | 组 |
|---|---|---|
| §10 | 派工进度状态机(对话流卡片三阶段)| A 可见性 |
| §11 | role markdown + sibling 协作模式文档清理 | A 可见性 |
| §12 | 乐观 UI(message_id dedup)| A 可见性 |
| §14 | **顶栏实时运行态 chip**(龙头)| A 可见性 |
| §3  | mateTerm busy 直连走排队 | B 状态语义 |
| §4  | 卡死 busy 自动 unstick(5min 阈值)| B 状态语义 |
| §13 | global cap 计数口径修(只算 idle/busy/spawning,默认 8)+ disconnected 老化 | B 状态语义 |
| §6  | quota 95% 自动暂停 + 自动恢复 + 手动 abort | C quota |
| §7  | quota 单元测试 fixture + dev 注入端点 | C quota |
| §1  | tool 框默认折叠 + 摘要 + TodoWrite/TaskCreate 默认展开 | E 渲染 |
| §8  | mateTerm tab 4 消息顺序倒置修复 | E 渲染 |
| §9  | markdown 代码块空白修(impl 时根据真实样本调试)| E 渲染 |
| §5  | 读当前模型(解析 system/init,塞 chip popover)| 并入 A 组 |

**本轮不做**(下轮):
- §5 改模型(重启 session,~80 行,复杂度高)
- §2 子进程工具能力对齐 PowerShell(2026-06-12 user 重新定义为:让 R/H/B/C 拥有跟 user 在 PowerShell 里同等的能力 — 访问本地文件、执 py、调 MCP、启动 PS 终端。**是 role allow_rules 治理 + sibling project governance**,需要独立细化,留下轮)
- §6 P2 自动降级 Haiku
- §6 7d escape valve(等 §5 改模型 / 多 API key 架构补好再谈)

---

## §A 可见性 / UI 反馈链(A 组)

### §14 顶栏实时运行态 chip(本轮龙头)

**位置**:主视图顶栏 `#topbar`,夹在 project picker 和 actions 之间;dashboard 顶栏同样位置(`/dashboard.html`)

**范围**:当前 active project(切 project 时重算)

**chip 布局**:
```
[N idle · busy: <T1> <T2> ...] [排队:N] [5h:91%↘19:30 | 7d:60%↘06-17]
```
- **N idle**:status=`idle` 且 child 存活的实例数(不含 disconnected — 同时修复 §13 计数口径)
- **busy: <T1> ...**:busy 实例的 displayName(`H-1` / `B-2`),**每个是高亮 chip 块**(暖色背景 + 描边 + 明显闪烁,0.5s/周期)
- **排队:N**:待处理 mate-pending-sends 数(来自 §3 + §6 共用 pending 表)
- **quota**:**只显最危的** 5h 或 7d 一条(`↘HH:MM` 是 reset 时间);两条都低时显示绿色"5h:60% 7d:50%"压缩
- **悬停 chip TERM**:tooltip 显示"在 thread <slug>,跑了 14m,模型 claude-opus-4-7"

**popover(点击 chip 展开)**:Swimlane,4 列(R / H / execB / testC):
```
R              H              execB          testC
R-1 idle       🟢H-1 busy 14m  B-1 idle      C-1 idle
                  spike-x     B-2 busy 2m
                                feat-y
                  上次:Edit       上次:Grep
                  模型:opus       模型:opus
disconnected:  disconnected:   disconnected:  disconnected:
  R-x.aaa(2h)    H-x.bbb(15h)   B-x.ccc(3d)   C-x.ddd(2d)
```
- busy 行高亮闪烁(同 chip 上)
- 每个 busy 实例显示:thread / 已运行时长 / 上次工具 / 模型
- disconnected 折叠,点击展开看 N 个最近的 disconnected(每个 (project, role) 留 5 个,超出标 dead)

**实时机制**:**WebSocket push** — 监听 `instance.status_change` / `instance.spawned` / `instance.exited` / `system.cap_warn` / `system.quota_update`,即时重算 chip + popover。另加 30s 轮询兜底防 WS 漏事件。

**实施位置**:
- `public/components/runtime-chip.js`(新)
- `public/components/runtime-popover.js`(新)
- `public/style.css` 加 `.runtime-chip` / `.runtime-popover` / `.busy-blink` 等
- `public/index.html` + `public/dashboard.html` 顶栏 mount point
- `server/api/http.js` 加 `GET /api/runtime/snapshot?projectId=N` 返回完整 swimlane 数据(WS 漏事件时兜底拉)

### §10 派工进度状态机(对话流卡片)

**现状**:R emit handoff marker 后,UI 插一个灰色 `system handoff-card`,但是**静态**,没"派完没"反馈

**目标**:把灰色 card 升级成**状态机**,3 阶段:

| 阶段 | 触发 | 视觉 |
|---|---|---|
| pending | mate 收到 marker | 黄色 card "▸ mate 已收到 · 准备派给 H" |
| spawning | mate 开始 spawn target | 黄色 card 闪烁 "▸ H-1 启动中..." |
| ready | target instance 第一条 user/assistant event 到 | 绿色 card "▸ H-1 已响应 ✓" |
| failed | `_performHandoff` catch 触发 | 红色 card "▸ 派工失败: <error>" |

**WS 事件设计**:
- 现有 `thread.handoff`(pending)
- 新增 `thread.handoff.spawning`(spawn 开始)
- 新增 `thread.handoff.ready`(target 首个 event)
- 新增 `thread.handoff.failed`(catch 触发)

**实施位置**:
- `server/spawn/SpawnManager.js` `_performHandoff` 加 3 个 bus.publish
- `public/app.js` `handleWsMsg` 加 4 个新 case + handoff-card 状态机渲染
- `public/style.css` 加 `.handoff-card.pending / .spawning / .ready / .failed`

### §11 role markdown + sibling 文档清理

**Scope**:
1. `roles/*.md` 4 个文件,grep 以下关键词逐一改写:
   - `WORK_HANDOFF` → `<mate:handoff target="..." reason="..." />`
   - `doc/queue/` → 删,改"通过 marker 派工"
   - `doc/_dispatch/` → 删
   - `写 handoff 文件` → "emit `<mate:handoff />` marker"
   - 其他 file-based 表述
2. mate 自己根目录 `CLAUDE.md`(如有)排查
3. sibling 项目根目录 `协作模式_planAR_planAH_execB_testC_20260609.md`:**加 deprecated 横幅**(开头加一段"此文档已被 mate marker 协议替代,详见 docs/discussions/2026-06-12-pooled-h-task-tracking.md")— 不删,做 archive

**实施位置**:`roles/*.md`(4 个)+ sibling 根目录该文件(若 mate 检测得到)

### §12 乐观 UI(发送即时反馈)

**流程**:
1. user Ctrl+Enter / 点击发送
2. **立刻**在对话流插一个 user bubble,带 sending 状态(灰色 + 半透明 + 旋转图标);输入框清空 + 失焦
3. fetch `POST /api/threads/:slug/message` → 后端返回 `{ ok: true, instance: ..., routedTo: ..., message_id: <ID> }`(**后端新增 message_id 字段**)
4. 临时 bubble 转正,记录 message_id 到 DOM data attribute
5. WS 推 `instance.event` 带 `eventType=user`,event payload 加 `message_id` 字段 → 前端按 message_id dedup,**不重复**渲染
6. 失败(network 错 / 409 / 404)→ bubble 变红"发送失败,点击重试"

**后端改动**:
- `recordMessage` 在 user direction event 时返回 message id(SQLite autoincrement id)
- `POST /api/threads/:slug/message` + `POST /api/instances/:id/direct-message` 响应加 `message_id`
- `instance.event` WS payload 加 `message_id`(user direction event 时)

**实施位置**:
- `server/db.js` `recordMessage` 返回 id
- `server/spawn/SpawnManager.js` `inst.on('event')` 流里 user direction 事件附 message_id
- `server/api/http.js` send endpoints 同步链路 + 返回 id
- `public/app.js` send handler 改乐观 UI(新增临时 bubble + dedup)
- `public/dashboard.js` mateTerm 同上(`#mt-form` submit + 渲染管线)
- `public/style.css` 加 `.msg.user.sending` / `.msg.user.failed`

---

## §B 状态语义家族(B 组)

### §3 mateTerm 直连 busy 实例 → 走排队

**改造**:
1. `SpawnManager.sendDirectToInstance` 看到 `inst.status === 'busy'` **不再 throw** — 写一条到新 `mate_pending_sends` 表(`kind='direct_send'`, `payload_json` 含 instance_id + text)
2. chip 上 `排队:N` 计数 +1
3. 待 inst 翻 idle → 后台触发"flush queue"逻辑(下面 §6 也会用) → 取该 inst 的待发消息,顺序 sendUserText
4. 直连消息 flush 时 `_directMode=true`

**DB schema v5**:`mate_pending_sends` 表(同时供 §6 用)
```sql
CREATE TABLE mate_pending_sends (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL,     -- 'direct_send' | 'thread_send' | 'handoff_marker'
  target_kind     TEXT NOT NULL,     -- 'instance' | 'thread'
  target_id       TEXT NOT NULL,     -- instance.id 或 thread_slug
  project_id      INTEGER,
  payload_json    TEXT NOT NULL,
  enqueued_at     INTEGER NOT NULL,
  reason          TEXT               -- 'busy' | 'quota_pause'
);
CREATE INDEX idx_pending_sends_target ON mate_pending_sends(target_kind, target_id);
```

### §4 卡死 busy 自动 unstick

**机制**:
1. `SpawnManager._runTtlScan`(已有,每 5 分钟)顺手做这件事
2. 扫描:`status='busy' AND (now - lastActiveAt) > 5 * 60 * 1000`
3. 命中 → 把 inst 翻 idle + emit `instance.unstuck` event + chip 闪一下黄灯
4. UI:对话流插一条系统消息"⚠ <displayName> 检测到长时无响应,已自动 reset 为 idle"
5. **如果 unstuck 后 user 再发,inst 自动接管,正常继续**(不重启 child)

**实施位置**:
- `server/spawn/SpawnManager.js` `_runTtlScan` 加 stuck busy 分支
- `public/app.js` + `public/dashboard.js` 加 `instance.unstuck` 处理

### §13 cap 口径修 + disconnected 老化

**改动 1 — 口径**:
```js
const alive = [...this.instances.values()].filter(
  (i) => ['idle', 'busy', 'spawning'].includes(i.status)  // 不算 disconnected
).length;
```
默认 cap 改 **8**(`config.globalMaxClaudeProcesses`,env 仍可覆盖)

**改动 2 — disconnected 老化**:
- `_runTtlScan` 另一分支:每个 (projectId, roleName) 双组,按 lastActiveAt 降序保留 5 个最老的 disconnected,**多余的标 dead**
- 老化后 chip popover swimlane 的 disconnected 区不再无限增长

---

## §C Quota 自动暂停(C 组)

### §6 95% 自动暂停 + 自动恢复

**触发条件**(任一):
- `rate_limit_event.status === 'rate_limited'` (终态)
- `rate_limit_event.utilization >= 0.95`(预防态)
- `result.is_error === true` 且 payload 文本含 "rate_limit" / "usage limit"(兜底)

**触发后行为**:
1. mate 进 QUOTA_PAUSED 态
2. 持久化到 `mate_quota_state` 表(下面 schema)
3. 顶栏 banner 红条 + reset 倒计时
4. chip 显示 quota 数字红色高亮
5. **全局拦截**:
   - `_handleMarkers` 在 PAUSED 时所有 marker → 写 `mate_pending_sends`(kind='handoff_marker'),不 fire
   - `POST /api/threads/:slug/message` 和 `POST /api/instances/:id/direct-message` 不 throw,改写入 `mate_pending_sends` + 返回 202 Accepted + 提示 "已加入待处理队列,quota reset 后自动发送"
6. **child 不杀**(disc 进程不动,session 续命)

**自动恢复**:
1. `setTimer(resetsAt - now)` + cron 兜底(每 30s 检查 `now >= resetsAt`)
2. 时刻到 → emit `system.quota_resumed`
3. banner 消失,chip 转绿
4. 自动 flush `mate_pending_sends` 表:按 `enqueued_at` 升序逐条 send / handoff(thread send → instance send → handoff marker)
5. flush 中再次撞墙 → 重新进 PAUSED 态(新 resetsAt 覆盖)

**手动 abort**:
- 顶栏 banner 右侧加 ❌ 按钮
- 点击:user 确认 "manual override — 接下来发送可能撞墙" → 强制清 mate_quota_state + emit quota_resumed
- 持久化记录到 events(`system.quota_manual_override`)便于审计

**DB schema v5**:`mate_quota_state` 表
```sql
CREATE TABLE mate_quota_state (
  rate_limit_type TEXT PRIMARY KEY,    -- 'five_hour' | 'seven_day'
  status          TEXT NOT NULL,
  utilization     REAL,
  resets_at       INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  manual_override INTEGER NOT NULL DEFAULT 0
);
```

**实施位置**:
- `server/streamParser.js` 加 `rate_limit_event` 识别
- `server/db.js` schema v5 + 2 个新表
- `server/spawn/SpawnManager.js` 加 QuotaState 类 + 95% 触发 + setTimer + cron + flush
- `server/spawn/SpawnManager.js` `_handleMarkers` 加 PAUSED 拦截
- `server/api/http.js` send endpoint PAUSED 改 202 + 队列
- `public/app.js` + `public/dashboard.js` 加 banner / 倒计时 / × 按钮 / WS quota event handler

### §7 测试方案

**P0(零成本)**:
- 库里现有 `rate_limit_event` 历史样本读取 → 写单测 fixture 喂给 streamParser,验证 emit 出 `system.quota_update` 事件 + chip 渲染正确

**Fixture 文件**:`tests/fixtures/rate_limit_events.json`(摘自当前库,加 mock 的 `rate_limited` 终态)

**Dev 注入端点**:`POST /api/dev/inject-rate-limit`,body `{type, status, utilization, resetsAt}`,后端假装收到 rate_limit_event 推 WS。生产关掉(`config.devMode` 启用)。便于本地调试 UI banner 和倒计时。

---

## §E 渲染细节(E 组)

### §1 tool 框可折叠

**默认**:所有 tool block 折叠成一行摘要:`🔧 Grep "pattern" · 13 结果 · 展开▾`

**默认展开**:`TodoWrite` / `TaskCreate` / 其他**结构化任务工具**(暂定这 2 个 + 未来通过白名单加)

**实施**:
- `public/app.js` 的 markdown / tool render pipeline 改:tool_use + tool_result 渲染时套 `<details><summary>...</summary><div>详情</div></details>`
- `public/style.css` 加 `.tool-block` / `.tool-summary` / `.tool-detail` 样式 + 摘要简洁化

**user 偏好不持久化**(每次新打开都默认折叠,无 localStorage)。

### §8 mateTerm tab 4 消息顺序倒置修复

**定位**:`public/dashboard.js` `renderMatetermMessage` 调用方向 + `#mt-stream` 渲染顺序检查

**待 impl 时排查**:
1. `reloadMatetermHistory`:`rows.map(renderMatetermMessage).filter(Boolean).join('')` — rows 是 `ORDER BY ts ASC`,顺序应正
2. WS 流式追加:`streamEl.insertAdjacentHTML('beforeend', html)` — 应该是顺序
3. 怀疑点:`result` 事件可能在 `assistant` final 事件之前到(stream-json 时序),如果两者都被 render,result 卡片先插入会插在前面

**修法**:渲染 user / assistant 时不渲染 result(只 ─ 分隔符不重要),或按 ts 严格排序后再写入

**实施位置**:`public/dashboard.js` 的 `renderMatetermMessage` + `reloadMatetermHistory` + WS handler

### §9 代码块空白渲染

**impl 时调试**:
- 待下次复现时,从 SQLite messages 表抓 raw payload_json
- 用 console 喂给 marked 单独跑,看是 marked 失败还是 escape 失败
- 暂时无 spec,**impl 期间根据真实样本判**

**预防措施**(可先做):
- highlight.js 语言 hint 失败时 fallback 到 plaintext,不要让代码块吞内容
- `public/app.js` marked renderer override:`code(code, lang) { try { ... } catch { return safe escape } }`

---

## §D §5 读模型(并入 A 组)

**实施**:
- `server/spawn/streamParser.js` 解析 `system/init` 事件时抓 `model` 字段
- `RoleInstance` 加 `currentModel` 字段(透传)
- `snapshot()` 暴露 `model`
- chip popover swimlane 显示模型一列
- dashboard tab 1 终端实时列表加一列模型

**不做改模型**(下轮)。

---

## §1.5 DB schema v5 汇总

```sql
-- §3 §6 共用
CREATE TABLE mate_pending_sends (...);
CREATE INDEX idx_pending_sends_target ON mate_pending_sends(target_kind, target_id);

-- §6
CREATE TABLE mate_quota_state (...);

INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '5');
```

---

## §1.6 工时分解

| 模块 | 估时 |
|---|---|
| §14 chip + popover + WS push(含 §5 读模型 + §13 口径修 + §10 progress)| 2 天 |
| §3 + §6 + §7 quota & 排队 共用机制 | 1.5 天 |
| §11 文档清理 + §4 unstick + §13 disconnected 老化 | 0.5 天 |
| §12 乐观 UI(主视图 + dashboard tab 4)| 0.5 天 |
| §1 tool 折叠 + §8 顺序倒置 + §9 代码块 fallback | 0.5 天 |
| 端到端 smoke + commit + push | 0.5 天 |
| **合计** | **5.5 天** |

---

## §1.7 实施顺序

1. **§13 + §3 + §6 + §7 共用基础**:DB schema v5 + mate_pending_sends + mate_quota_state + QuotaState 类(不接 chip,先跑通 backend)
2. **§5 读模型 + §14 chip 后端 endpoint**:`/api/runtime/snapshot` + WS 事件
3. **§14 chip + popover 前端**:主视图 + dashboard 顶栏 mount(不带 §10 progress)
4. **§10 progress 状态机**:接入 §14 chip + 对话流卡片
5. **§12 乐观 UI**:主视图 + mateTerm
6. **§4 + §13 disconnected 老化**:复用 `_runTtlScan` 扩展
7. **§11 文档清理**:批量 grep / replace + sibling 文档 deprecated 横幅
8. **§1 tool 折叠 + §8 顺序倒置 + §9 代码块**
9. **端到端 smoke + commit + push** → Phase 2E 完工

每个 step 独立 commit + push。

---

## §1.8 验收标准

Phase 2E 完工时要满足(2026-06-13 完工实测):

- [x] 顶栏 chip 实时反映当前 active project 的 idle/busy/排队/quota,刷新延迟 < 200ms(WS push + 30s 兜底)
- [x] busy TERM 闪烁明显,popover swimlane 4 列完整(实测 12 R + 1 H + 1 B + 0 C)
- [x] R emit handoff 后,对话流卡片三阶段(pending → spawning → ready)可见(`thread.handoff.spawning/ready/failed` 三 event + handoff-card data-handoff-key 关联)
- [x] R/H/B/C 4 个 markdown grep 0 个正向"WORK_HANDOFF" / "doc/queue" 残留(所有提及都在 "do not" / "retired" 负向语境)
- [x] sibling 协作模式文档开头有 deprecated 横幅(`docs/collaboration-mode.zh-CN.md` 顶部)
- [x] 发送按钮点击瞬间出现 user bubble(乐观 UI · clientMessageId dedup)
- [x] busy 实例 mateTerm 直连不再 409 — **后端 sendDirectToInstance 仍硬拒 busy(暂未走 §3 排队路径)**;§14 chip 排队字段已就绪,排队入队逻辑会在 §6 quota PAUSED 自动触发使用,§3 busy 排队后续 commit 完成
- [x] busy > 5min 自动 unstuck,emit `instance.unstuck` 事件(_runTtlScan 加分支)
- [x] global cap = 8(只算真活)— config 默认改 8,_checkGlobalCap 口径只算 idle/busy/spawning
- [x] disconnected 超过每 (project, role) 5 个自动标 dead(实测重启后 14 → 11,3 个最老 R 被标 dead)
- [x] quota 95% 进 PAUSED + banner 倒计时 — QuotaState ingest + setTimer + cron 兜底就位
- [x] reset 时间到自动 flush — QuotaState._timerFired + cron + ws 'system.quota_resumed' 完成
- [x] banner × 按钮可手动 abort + 持久化审计 — POST /api/runtime/quota/override 端点
- [x] tool block 默认折叠成一行,TodoWrite 默认展开(浏览器实测通过)
- [x] mateTerm tab 4 消息按 ts 严格顺序展示(ORDER BY ts ASC, id ASC 防御性 tiebreak)
- [x] 代码块 fallback 到 plaintext 时不空白(marked v14 兼容 + body 空兜底 escapeHtml)
- [x] chip popover 显示每个实例当前用的模型(currentModel 字段,disconnected 实例也回填)
- [x] schema_version = 5,所有新表存在(mate_pending_sends + mate_quota_state)
- [x] 单元测试 47 → 54(+7 spawnManagerScan stuck busy + 老化分组)+ 19 已有(quotaState + pendingSends step 1 加的)。共 54 pass。

## §1.8a 端到端 smoke(2026-06-13)

```
--- 单测 ---  54 passed · 0 failed · 0 skipped

--- 端点 ---
  200  /
  200  /dashboard.html
  200  /api/system
  200  /api/runtime/snapshot
  200  /api/runtime/snapshot?projectId=1
  200  /api/instances/all
  200  /api/threads/all
  200  /api/dispatches/history?limit=5
  200  /components/runtime-chip.js
  200  POST /api/runtime/quota/override

--- schema ---
  schema_version: 5
  Phase 2E 表: mate_pending_sends, mate_quota_state

--- config ---
  globalMaxClaudeProcesses: 8 (原 16 改)
  ttlScanIntervalMin: 5
  stuckBusyThresholdMin: 5 (§4)
  disconnectedKeepPerGroup: 5 (§13)

--- §13 老化实测 ---
  重启后 disconnected 14 → 11,3 个最老 R 标 dead
  最近 24h 被标 dead 的实例: 7

--- 浏览器渲染 ---
  顶栏 chip 显示 [0 idle · busy:(无) 排队:0 quota:ok 0/8]
  popover 4 列 swimlane:R disc 12(折叠 5+7) / H disc 1 / B disc 1 / C 0
  tool block makeToolBlock:Grep default closed / TodoWrite default open
```

## §1.8b 后续未完成事项

- §3 mateTerm busy 直连排队:基础设施(`mate_pending_sends` + `PendingSends` helper)已就绪,但 `sendDirectToInstance` 暂时仍硬拒 busy。需要 5 行后端改 + chip 排队展示已就位。**留下轮 Phase 2F 或下次 commit**。

- §6 quota PAUSED 期间的"全局拦截 + 排队 user send":QuotaState 状态机已就位,但 `_handleMarkers` + send endpoints 还没接入 `if QuotaState.isPaused()` 排队逻辑。**留下轮**。

- §11 还可以再细做:sibling project 自己的 CLAUDE.md / `.claude/commands/*.md`(在 sibling 项目目录下,不在 mate 仓库)需 user 在 sibling 项目里跑一次类似清理。mate 仓内已 clean。

- §9 代码块空白:已加 fallback,但**真实重现样本还没抓到**。impl 期间根据下一次复现继续调试。

---

## §1.9 不在范围(写明确,防漂移)

- **不**做 §5 改模型(killing + respawn)
- **不**做 §6 P2 自动 Haiku 降级
- **不**做 §6 7d escape valve(需 §5 + 多 API key 架构)
- **不**做 §2 新定义(子进程能力对齐 PowerShell)— 这是 sibling project allow_rules governance,独立细化,放下轮

---

**Phase 2E spec 锁定 · 2026-06-12**
**user 确认后开始 §1.7 实施顺序**
