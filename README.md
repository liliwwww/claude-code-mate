<!-- README.md (English) — for international visibility. The full Chinese version is at README.zh-CN.md and is the primary doc for the original audience. -->

# Claude Code Mate

> Local Web UI for managing **N concurrent Claude Code CLI sessions** across a multi-role collaboration workflow — without losing your mind switching between PowerShell terminals.

[简体中文 README](./README.zh-CN.md) · [Architecture](./docs/architecture.md) · [Stream-JSON Protocol Findings](./docs/stream-json-protocol.md)

> **Status: Experimental.** Phase 2A (multi-project foundation) shipped; Phases 2B–2D and intent routing are in progress. Designed for **personal local use on Windows** with the Claude Max subscription, not for shared/server deployment.

---

## What problem does it solve?

If you use Claude Code CLI for complex work — say, a **multi-role collaboration workflow** with separate terminals for *requirements clarification*, *orchestration*, *implementation*, and *validation* — you can quickly end up with **7–10 PowerShell windows** to babysit. Switching focus, copy-pasting between them, tracking which thread each terminal is working on becomes the bottleneck.

Claude Code Mate collapses that experience into one browser tab:

- One unified input → routed to the right role's session
- A central board of all **threads** (your actual requirements) with their lifecycle state
- All conversations persisted in SQLite — **restarts don't lose data**
- Idle sessions are restored as `disconnected` and lazily re-spawned with `--resume` when you talk to them again
- Multi-project support: manage `D:\dev\kb_backend`, `D:\dev\web_gmail`, and Mate itself from a single UI

The principle is **"升维不再造" (elevate, don't replace)**: roles still exist with their own context, prompts, and tool permissions; Mate is a router + view aggregator, not a new agent.

## How it works (high level)

```
┌────────────────────────────────────────────────────┐
│  Browser UI: thread board + active conversation    │
└────────────────────────────────────────────────────┘
           │  WebSocket events / REST API
           ▼
┌────────────────────────────────────────────────────┐
│  Node.js backend                                   │
│  • SpawnManager (per-project, per-role pool)       │
│  • StreamParser (NDJSON, partial-message aware)    │
│  • SQLite (threads, messages, instances, projects) │
└────────────────────────────────────────────────────┘
           │  child_process.spawn (no shell wrapper)
           ▼
┌────────────────────────────────────────────────────┐
│  `claude -p --input-format stream-json …`          │
│  N headless processes, one per active role-thread  │
└────────────────────────────────────────────────────┘
```

Long-running scripts (testing/validation) launch a **visible PowerShell window** via `Start-Process` so you can watch progress and Ctrl+C if needed — the rest of the work stays headless.

See [docs/architecture.md](./docs/architecture.md) for the full picture.

## Quick start

**Prerequisites**

- Windows 10/11 (native — not WSL)
- Node.js 18+ (`nvm use` will read `.nvmrc`)
- Claude Code CLI installed globally (`@anthropic-ai/claude-code`) and authenticated with a Max subscription (no API key needed)
- A local HTTP/HTTPS proxy if your network requires one — by default we expect `http://127.0.0.1:10808`

**Install and run**

```powershell
git clone https://github.com/liliwwww/claude-code-mate.git
cd claude-code-mate
npm install
copy .env.example .env
# Edit .env: set HTTP_PROXY to your real proxy port if not 10808
npm start
```

Then open <http://127.0.0.1:8721>.

See [docs/development.md](./docs/development.md) for development setup, debugging, and the technical-probe directory.

## Configuration

All configuration goes through `.env` (see `.env.example`):

| Variable              | Default                  | Purpose                                            |
| --------------------- | ------------------------ | -------------------------------------------------- |
| `PORT`                | `8721`                   | HTTP/WebSocket port                                |
| `HTTP_PROXY`          | `http://127.0.0.1:10808` | Required — injected into every claude child       |
| `HTTPS_PROXY`         | same as HTTP_PROXY       | Required for HTTPS calls                           |
| `CLAUDE_BIN`          | `claude` (from PATH)     | Custom path to the claude executable               |
| `SIBLING_PROJECT_DIR` | (project root)           | Legacy Phase 1 default; projects are DB-managed now |
| `LOG_LEVEL`           | `info`                   | `error` \| `warn` \| `info` \| `debug`            |

## Roadmap

| Phase | Status | Headline                                                            |
| ----- | ------ | ------------------------------------------------------------------- |
| 0     | ✅ Done | Stream-JSON protocol probes ([findings](./docs/stream-json-protocol.md)) |
| 1     | ✅ Done | SpawnManager + minimal observer UI                                  |
| 2A    | ✅ Done | Multi-project foundation                                            |
| 2B    | ⏳ Next | **Thread board** as primary view (kill the spawn dropdown)          |
| 2C    | 📋     | Instance pool, `[slug]` routing, session TTL anti-rot               |
| 2D    | 📋     | System monitor module, global process cap                           |

## Documentation map

- [**Architecture**](./docs/architecture.md) — system design, "升维不再造" principle, role catalog model
- [**Stream-JSON Protocol Findings**](./docs/stream-json-protocol.md) — empirical schema for `claude --input-format stream-json`, including bits not in official docs
- [**Role Authoring**](./docs/role-authoring.md) — how to write a new role markdown file
- [**Development**](./docs/development.md) — setup, debugging, probe scripts
- [**Collaboration Mode (zh-CN)**](./docs/collaboration-mode.zh-CN.md) — the multi-role workflow Mate is built for
- [**Project Spec**](./docs/spec.md) — original technical specification

## Contributing

PRs and issues welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT — see [LICENSE](./LICENSE).

## Acknowledgements

Built with [Claude Code](https://docs.anthropic.com/claude-code) for managing Claude Code. The roles and collaboration model originated from a real project workflow at the author's day-job; many design tradeoffs were discovered by hitting them.
