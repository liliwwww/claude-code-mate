<!-- CHANGELOG.en.md — English version. The Chinese version (primary) is at CHANGELOG.md. -->

# Changelog

[简体中文版本](./CHANGELOG.md) · All notable changes are recorded here. Versions follow [Semantic Versioning](https://semver.org/), categories follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.4.0] — 2026-06-15 · First GitHub release (i18n + cumulative Phase 2E/2F/2G)

**First git-tagged release.** Covers ~3 months of cumulative work since Phase 2C: role system renamed from `planA-*` to `mate-R/H/B/C`, marker-based dispatch protocol shipped, Phase 2F main-view smoothness improvements, log-stream tab, session TTL default bumped to 720h (effectively never), per-role/per-instance model switching, and — the highlight of this release — i18n (Chinese + English).

### Added · i18n (highlight)
- **Chinese / English toggle** — new `中/EN` button in topbar, persisted to localStorage, no mate restart needed
- `public/components/i18n.js` — core i18n runtime (`t()` / `setLang()` / `applyDom()` / `onChange()`)
- `public/components/messages.js` — 238 keys, zh/en fully symmetric
- HTML uses `data-i18n` / `data-i18n-attr-<attr>` for declarative translation
- JS uses `t('key', {params})`; switching language re-renders main view + dashboard + chip automatically
- Coverage:
  - 100% — index.html / dashboard.html / runtime-chip.js
  - ~80% — app.js (all hot UI paths translated)
  - ~70% — dashboard.js (main tabs + interactions)
- NOT translated: `roles/*.md` (LLM prompts), backend error messages, console.log, code comments, `答:` protocol field (would break SystemAgent reply-template parser)

### Added · Roles / Dispatch (Phase 2E/2F cumulative)
- **Role rename**: `planA-R/planA-H/execB/testC` → `mate-R/mate-H/mate-B/mate-C` — mate's role definitions are now fully separated from sibling project's
- **Marker dispatch protocol**: `<mate:handoff target="..." reason="..." />` / `<mate:done summary="..." />` / `<mate:blocked question="..." severity="..." />`
- **Dispatch state-machine cards**: pending → spawning → ready → failed, live in main view
- **PoolAllocator + ScanRecycler + HandoffTracker + MarkerDispatcher** module split (Phase 2E arch §1.4)
- **Marker malformed observability**: dedicated event + 17 adversarial fixture test cases
- **eventType predicates centralized** (arch-debt §14): `isResult`/`isAssistantFinal`/etc

### Added · UI / Main view (Phase 2F smoothness)
- **Streaming assistant bubble collapsed by default** (§16) — wrapped in `<details>`, char count updated live
- **Streaming render toggle** (§17) — `📺 Live` checkbox in conv-header
- **Input disabled when thread is busy + red ■ Stop button** (§18) — `POST /threads/:slug/stop`
- **LLM waiting indicator** (§19) — `⌛ Waiting for LLM... <seconds>`
- **System noise muted**: `hook_started`/`hook_response`/`status` no longer enter main conversation stream
- **Dispatch silence fix** (§10): 4-stage handoff card, including failure state
- **User bubble dedup** (§12 + §15): optimistic UI render immediately, WS echo dedup via clientMessageId
- **chip busy term inline currentActivity**: `busy:[H-1 · 🔧 Grep]`
- **Thread ID copy button**: left panel each row + next to conv-header title, one-click copy slug
- **tool_result collapsed amber block**: previously showed as large blue user bubble (visual noise); now matches tool_use color

### Added · Dashboard / System Monitor
- **5th tab: Log Stream** — global aggregation of all claude terminal stream events, 4-dimension filtering (instance/thread/type/time-window) + text search + WS live append
- **Terminals tab adds Model column**: 9-column layout, model now a dropdown
- **skill / slash command dialog**: `skill` button per row → popup with 8 common slash + freeform input
- **New instance ops endpoints**: `POST /api/instances/:id/slash` + `POST /api/instances/:id/switch-model`

### Added · Model switching
- **`model` field in role frontmatter**: each role can specify a claude model (e.g. mate-R on haiku to save money)
- **Per-instance runtime switch**: dashboard dropdown → `inst.preferredModel` overrides → kills child → next sendUserText spawns a fresh session with the new model
- **Schema adds `model`**; `buildSpawnArgs` supports `modelOverride`

### Added · TTL / Session
- **Default session TTL: 4h → 720h** (30 days, effectively never) — user feedback that claude sessions don't need auto-expire in daily use
- `role.session_ttl_hours` schema max 168 → 8760 (1 year)
- ENV `DEFAULT_SESSION_TTL_HOURS` still overrides

### Added · Tooling
- `scripts/kill-port.ps1` adds **busy check**: before killing mate, scans busy/spawning instances; non-interactive mode refuses default-yes (prevents accidental kill)
- `POST /api/threads/:slug/retry-handoff`: re-trigger marker dispatch when stuck, without starting a fresh thread

### Changed · Tool permissions
- **mate-R loses Edit/Write**, gains hard constraint "shell must not write files" — R is investigate-only
- All 4 roles add `mcp__ssh-monitor__*` (opt-in usage)
- mate-H/mate-B/mate-C all include Bash + PowerShell by default

### Changed · Architecture
- **mate process files must not be written into sibling projects** (architecture red-line §11)
- **arch-debt §12–§15** all completed: adversarial fixtures + marker observability + predicate centralization + marker protocol review
- **§5 reading model shipped, switching model defers to next round**

### Fixed
- `currentActivity:[object Object]` fixed (`texts.map(t=>t.text||'').join`)
- Thread auto title summary drift: when user explicitly sets a title, `metadata.title_locked=true` is set, SystemAgent no longer overwrites
- Model switch `/model slash` ineffective in headless → switched to kill+respawn path
- `sendUserText` no longer throws on disconnected + sessionId=null (unblocks switchModel path)
- `result/*` events not rendered in frontend (`=== 'result'` → `startsWith('result')`)
- §18 red ■Stop button didn't revert after claude finished a turn, required switching threads to turn green (missing `applyBusyUiState()` in `status_change` WS branch)
- Marker regex truncation: reason containing `"` was truncated → switched to `.*?` non-greedy + `s` flag

### Known limitations (targets for next release)
- **No queue / no concurrent thread tracking when multiple R dispatch to the same H**: H has `parallelism_limit: 1`; a busy H receiving a second marker writes directly to stdin; `inst.threadSlug` gets overwritten, causing thread1's status light to go dark (see docs/discussions/2026-06-15-multi-r-handoff.md)
- **PendingSends table exists but is unused**: queued dispatch was Phase 2D work that was skipped

## [0.5.0] — 2026-06-27 · stack-model SSOT + anti-hallucination + 429 auto-recovery + breadcrumb guards

50+ commits since v0.4.0 (2026-06-15). Three main themes:

### Stack-model architecture (full 5-phase RFC)

Stack replaces event log as the dispatch-state SSOT. Detail RFC: [`docs/discussions/2026-06-16-stack-model-rfc.md`](docs/discussions/2026-06-16-stack-model-rfc.md).

- Phase 1 (`a4b4efd`) — DB v11 + ThreadCallStack + SlotPool + 48 unit tests
- Phase 2.1/2.2 (`3080ad5`) — replay algorithm + migration
- Phase 2.3 (`c991096`) — kb_knowledge session_id validation tool
- Phase 3 (`c85982c`) — MarkerDispatcher operates stack directly, drop reverse-scan caller lookup
- Phase 3.6 (`18b035f`) — stack derived purely from chain replay (eliminates accumulation bugs)
- Phase 4 (`f271852`) — `<mate:bounce reason="..." />` replaces `<mate:handoff target="mate-R" />` for explicit semantics

### Dispatch logging to sibling project (`84f8811`)

Auto-write dispatch records to `<project>/doc/dispatch/<task_slug>_<NNN>_<from>_to_<to>_<ts>.md`. User reversed earlier "mate must not pollute managed projects" stance after realizing the 270+ `WORK_HANDOFF_*.md` files in `kb_backend/doc/` were the trail they actually grep'd. `doc/` is process docs anyway.

### E2E test suite (`345167a` + `610bc46`)

Playwright + MockRoleInstance, 10 specs / 11 assertions pass (2 multi-thread skipped for Phase 3), ~50s runtime. Required for confident SSOT refactor.

### Anti-hallucination prompts

- `516c9aa` — "Marker emit is the only authentication" sections in R/H prompts; LLM saying "I dispatched" without emitting marker no longer fools mate
- `48e7c53` — every role must `curl` mate API before reporting status; task tag now includes `Project: <id>` for the curl URL
- `8197a42` — fixed `_performDone` string-mismatch bug where R never received delegate-done callback because condition checked `'requirements'` but actual value was `'mate-R'`

### Server-side 429 auto-recovery (`497a11a` + `df1f2e4`)

- `_ingestServerReject` — recognize RLI `{status:"rejected"}` (2-field edge case, no rateLimitType), borrow `five_hour` resetsAt as pause deadline, fall through to `_performPause` (setTimer + cron + banner broadcast)
- `sendToThread` / `sendDirectToInstance` gated on `QuotaState.isPaused()` — paused → enqueue PendingSends (`reason='quota_pause'`); `system.quota_resumed` listener triggers FIFO flush

### Breadcrumb alignment (`77a961b`)

Frontend `renderBreadcrumb` replay logic was out of sync with server `replayChain._applyHandoff` since `dc416c5` — user reported "dispatch chain growing endlessly". For thread `t-mqmi7hu3-hxf1` (163-segment chain): server stack depth=2, frontend depth=16. Sync'd frontend: pop abandoned frames when stack top ≠ from, instead of pushing.

### Chip popover readability (`6ecf724`)

Pending-send chip now shows `**mate-B-1** [mate-B] [busy] × 1` / `thread: [AI Report]` / `from: mate-H-1` / `[handoff] [⏳ target busy]` instead of opaque internal IDs.

### Other notable fixes

- `94f012b` — old threads (5000+ messages) couldn't see latest UI / LLM output (history API was ORDER BY ASC, taking oldest N)
- `dc416c5` — `replayChain._applyHandoff` self-heal: pop abandoned frames when interrupting B/C long task; line t-mqmi7hu3-hxf1 stack 8 → 1
- `06fd6af` — `/api/runtime/snapshot` was missing `projectId` field; dashboard state graph H/B/C disappeared when scoped
- `c7de54f` — autoscroll respects user scrolling up; "↓ Jump to latest" button appears when off-bottom
- `913a787` — verified threads / reused instances no longer falsely lock input
- `7111f1b` — H/B/C `allowed_tools` include `mcp__kb__*` (LLM was bypassing dontAsk via Bash + SQL)

### Files added

- `docs/discussions/2026-06-16-stack-model-rfc.md` — stack model RFC, 8 edge cases + 5-phase migration
- `docs/backlog.md` — project-level backlog tracking
- `tests/e2e/` — 10 Playwright specs + fixtures
- `tests/unit/` — replayChain / threadCallStack / quotaState / slotPool / pendingSends regression tests

---

## [Unreleased]
