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

## [Unreleased]

For pre-0.4.0 history, see [CHANGELOG.md](./CHANGELOG.md) (Chinese). Older versions (0.3.x, 0.2.x, 0.1.x) tracked internal Phase 2A/2B/2C milestones and are not translated retroactively — they predate the first GitHub release.
