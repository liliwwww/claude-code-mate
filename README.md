<!-- README.md (English) — for international visibility. The full Chinese version is at README.zh-CN.md and is the primary doc for the original audience. -->

# Claude Code Mate

> **One chat, a team of specialized Claude Code agents working behind the scenes.** Describe what you need — Mate orchestrates the rest (clarify → design → implement → validate) without making you switch terminals.

[简体中文 README](./README.zh-CN.md) · [Architecture](./docs/architecture.md) · [Stream-JSON Protocol Findings](./docs/stream-json-protocol.md)

> **Status: Experimental.** Phase 2A (multi-project) + 2B (thread board + lazy spawn) shipped; Phase 2C (auto state-machine + system LLM + markdown rendering + light/dark) in active development. Designed for **personal local use on Windows** with a Claude Max subscription, not for shared/server deployment.

---

## What problem does it solve?

Pushing Claude Code CLI to handle complex engineering work — requirements discussion, design decisions, multi-file code changes, long validation runs — quickly exceeds what a single session can do. You end up running 4–10 PowerShell terminals, each playing a specialized role (one to talk through requirements, one to orchestrate, one to write code, one to test long-running scripts). Most of your day goes to switching windows, copy-pasting handoffs, and tracking which terminal is working on what.

**Mate makes that experience feel like one conversation.**

**What you see in the browser:**

- One thread per requirement, one unified chat, one status light
- **Lazy spawn** — no claude process starts until your first message (no wasted tokens)
- Markdown-rendered responses, light/dark theme, multi-project switcher
- Auto-summarized thread titles, suggested reply templates, persistent conversations (SQLite — survives mate restart, claude restart, and crash recovery via `--resume`)

**What runs behind the scenes:**

- Mate auto-spawns specialized agents — **R** for requirements clarification, **H** for orchestration, **execB** for implementation, **testC** for long validation runs — and routes between them automatically as the thread advances through its lifecycle: `discussing → designing → executing → testing → verified`.
- **You never see the role switches.** Stage badges update silently. Conversation stream stays unified.
- Mate **only interrupts you** when a role genuinely needs your input — a business decision, an ambiguous requirement, a blocking choice. On the relevant thread card, the **yellow light starts flashing**. Otherwise work just flows.
- When all agents finish and self-verify, the thread goes idle. Mate does **not** ask for your business sign-off — that's yours alone (open the browser, test the change, archive when done).

The principle is **"升维不再造" (elevate, don't replace)**: the roles still exist with their own contexts, system prompts, and tool permissions. Mate is not a new agent — it's the conductor that makes a multi-agent orchestra feel like a single voice.

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
| 2B    | ✅ Done | Thread board + lazy spawn + stage state machine                     |
| 2C    | 🚧 In progress | System Agent (mate's own LLM), env-check, markdown rendering, light/dark theme, auto title-summary, suggested reply templates, **auto role state-machine (R → H → B/C, invisible to user)**, status lights |
| 2D    | 📋     | System monitor module, global process cap, session TTL anti-rot     |

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
