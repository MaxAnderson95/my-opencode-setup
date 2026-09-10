# my-opencode-setup

Personal [OpenCode](https://opencode.ai) plugins, skills, slash commands, and a theme — packaged so you can cherry-pick the pieces you want. Everything is self-contained: one folder per plugin/skill, each with its own metadata.

> **Platform:** built and tested on **macOS**. A few plugins/skills are macOS-specific (flagged in the tables below); the rest are cross-platform.

## Requirements

- **OpenCode 2 beta**, installed as the native `opencode2` binary through the upstream shell installer. Package manifests pin their compatible plugin SDK.
- **[Bun](https://bun.sh)** — resolves plugin dependencies (`bun install`) and is the runtime for several plugins (`bun:sqlite`, `Bun.spawn`).
- Individual plugins/skills may need extra tools — see the **Requires / config** column in each table.

## Contents

```
my-opencode-setup/
├── plugins/          One folder per plugin, each with its own package.json
├── skills/           One folder per skill (SKILL.md)
├── themes/           Custom theme
├── link.sh           Links skills and themes; plugins install from GitHub
└── cli.example.json  Sample cli.json (theme + TUI options)
```

## Server plugins

Each plugin is a self-contained package directory with its own `package.json`, entrypoint and dependencies. `scripts/publish-plugins.sh` publishes each folder to a `plugin-NAME` branch in this repository, placing its package at the Git dependency root. Imports stay within the package or use declared package dependencies.

| Plugin | Description | Requires / config |
|---|---|---|
| `caffeinate/` | Keeps macOS awake while sessions are working (one `caffeinate -di` per session; sleeps once all are idle). | **macOS** |
| [`hark/`](plugins/hark/README.md) | Push notifications to a [Hark](https://hark.ryan.ceo) webhook when a long-running session finishes, needs permission, asks a question, or errors — so you get pinged on your iPhone. | `HARK_WEBHOOK_URL` env (no-op without it); a Hark account. |
| [`mcp-lazy/`](plugins/mcp-lazy/README.md) | Model-controlled MCP server enable/disable so only in-use servers cost tool-schema context. Adds `mcp_enable` / `mcp_disable`. | — |
| [`message-timestamps/`](plugins/message-timestamps/README.md) | Gives the model a clock: stamps every user message with local time (plus idle gap and previous-turn duration when they matter) and selectively stamps slow tool results, without breaking prompt caching. | Optional `OPENCODE_MESSAGE_TIMESTAMP*` env overrides. |
| [`recall/`](plugins/recall/README.md) | Long-term conversational memory: hybrid lexical (FTS5/BM25) + semantic (local transformers.js embeddings) search over every past OpenCode conversation. An escalation ladder of tools: `recall_search` (find sessions) / `recall_inspect` (search within one, or outline it) / `recall_expand` (read transcript) / `recall_summarize` (delegate to a cheap worker model, cached permanently) / `recall_status`. Announces long background indexing via TUI toasts and stays silent for routine catch-up. Multi-file (`lib/` + `bun test`). | One-time ~33 MB model download; reads the OpenCode DB read-only. Optional `~/.config/opencode/recall.json`. |
| [`overage-guard/`](plugins/overage-guard/README.md) | Pauses a session and its subagents when a subscription provider starts billing beyond the plan (Anthropic extra usage, OpenAI Codex credits) and asks, via a native question form, whether to wait for the reset, allow it until then, or stop. One adapter per provider. Multi-file (`lib/` + `bun test`). | Guards OAuth (subscription) connections only. State in `~/.local/state/opencode/overage-guard.json`; needs the managed OpenCode service to show the question. |
| `model-identity/` | Stamps each user message with the resolved model and reasoning effort (`<model-slug>` / `<model-effort>`), so the model knows what it is. | — |
| `subagent-model/` | Adds an optional per-invocation `model` override to the native `subagent` tool while retaining native child sessions, jobs, and TUI rendering. | — |
| [`token-refresh/`](plugins/token-refresh/README.md) | Keeps every stored OAuth credential fresh, including inactive accounts, by resolving each one through core on a jittered two-minute schedule. Core does the actual refresh and persistence. | Logs to `~/.local/share/opencode/token-refresh.log`. |

## TUI plugins

TUI packages export `./tui` alongside their server entrypoint. OpenCode advertises the installed package's TUI capability to connected terminal clients. These packages do not need duplicate entries in `cli.json`.

| Plugin | Description | Requires |
|---|---|---|
| `active-provider-account/` | Shows active credential labels in the sidebar for providers with multiple saved accounts. | — |
| `background-jobs/` | Active background tools and subagents in the current session's sidebar, with elapsed time. | — |
| `callout/` | Renders the current session's pinned callout in the sidebar (the display half of the `callout` server plugin). | — |
| `elapsed-timer/` | Live session duration in the prompt footer while a session is working. | — |
| `ghostty-progress/` | Drives Ghostty's OSC 9;4 progress-bar indicator while sessions work. Lives in the TUI because OpenCode 2's server runs detached from any terminal. | **Ghostty 1.2.0+** |
| `session-close/` | `/close` slash command (and `Session > Close session tab` in the palette) that closes the current tab without deleting its session, then opens a fresh session tab. | Session tabs enabled |
| `session-delete/` | `/delete` slash command (and `Session > Delete session` in the palette) that deletes the session you're looking at, after a confirm that names it and counts its child sessions. | — |
| `session-id-badge/` | Current session ID in the TUI sidebar. | — |

## Skills

Instruction sets the agent loads on demand. `link.sh` symlinks each `skills/<name>/` into `~/.config/opencode/skills/<name>`.

| Skill | Description | Requires |
|---|---|---|
| `opencode-db-querying/` | Schema + ready-to-run SQL for OpenCode's local SQLite DB (sessions, messages, parts, projects, todos, tokens/cost). Complements `recall/` with precise SQL. | `opencode` CLI or `sqlite3` |
| `macos-root/` | Run commands as root via `osascript` (because `sudo` can't prompt for a password inside OpenCode). | **macOS** |
| `md2pdf/` | Format/style Markdown for the `md2pdf` CLI (Markdown → HTML → headless Chrome → PDF). | `md2pdf` CLI + Chrome |
| `pdf-reports/` | Author PDF reports by writing Markdown and converting with `md2pdf`. | `md2pdf` CLI |
| `openusage/` | Report AI-subscription usage/limits by reading the local OpenUsage menu-bar app's HTTP API. | **macOS** + the OpenUsage app |
| `dark-mode/` | Build a dark/light/system theme system: CSS token structure, the pre-paint script that kills the flash, the three-state control, plus Astro and React wiring. | — |

> `md2pdf` and `openusage` target specific local tools (a personal `md2pdf` CLI and the OpenUsage menu-bar app); they're only useful if you run those tools.

## Retired plugins

Seven plugins were dropped in the OpenCode 2 port on the belief that v2 grew a native equivalent. They remain in git history (`d536794`) if any needs resurrecting — one already did.

| Plugin | Replaced by |
|---|---|
| `cache-stats/` | A per-turn token table with cache read/write and cache-bust detection (`debug.turn_tokens` in `cli.json`). |
| `search-scope-guard/` | Path-scoped `external_directory` permissions, which gate out-of-project `glob`/`grep` by rule. |
| `sensitive-file-guard/` | Ordered `permissions` rules on the `read` action (e.g. deny `**/.env`). The bash-pipeline and content-sniffing halves have no native equivalent. |
| `stuck-watchdog/` | Provider-level retry with jittered backoff and `session.retry.scheduled` events. Hung-tool detection has no native equivalent. |
| `tool-timing/` | Per-call durations recorded on the message and rendered in the timeline. |
| `local-session-commands/` | Nothing, as it turned out. Its `/delete` half is back as `session-delete/`: v2 only deletes sessions from inside the session-list dialog (`ctrl+d` twice), with no slash or palette command. Its `/open` half (macOS `open` on a path) is still gone — v2's native `/open` is the project picker, not the same thing. |
| `subagent-model/` | Resurrected below: per-invocation model selection was still missing from the native `subagent` tool. |

## Theme

`themes/ayu-max-custom.json` — a customised [Ayu](https://github.com/ayu-theme/ayu-colors)-style theme with dark and light variants.

## Install

Install the selected plugin packages from GitHub:

```bash
opencode2 plugin add 'github:MaxAnderson95/my-opencode-setup#plugin-recall'
opencode2 plugin add 'github:MaxAnderson95/my-opencode-setup#plugin-background-jobs'
```

For skills and the theme, clone the repo and run the idempotent `link.sh`:

```bash
git clone https://github.com/MaxAnderson95/my-opencode-setup.git ~/my-opencode-setup
cd ~/my-opencode-setup
./link.sh
```

## How plugins load (for adapters)

Package resolution uses `./server`, then the root export or `main`, with conventional index entrypoints as fallback. TUI packages export `./tui`. Branch specifications are mutable but updates are explicit: edit locally, run checks, commit and push, run `bash scripts/publish-plugins.sh`, then run `opencode2 plugin update` for the selected GitHub package and verify its installed revision and behavior. A local source edit alone is not a deployment.

The native OpenCode beta-19425 installer accepted a `::path:` specification but installed the repository root instead of the selected package contents during verification. Package branches avoid that behavior. npm 12 also requires explicit Git-dependency opt-in (`--allow-git=all`) for dependency installation. Do not create local plugin symlinks or edit OpenCode's installed package cache.

## License

[MIT](LICENSE)
