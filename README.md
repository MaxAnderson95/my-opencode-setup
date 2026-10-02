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
| [`message-timestamps/`](plugins/message-timestamps/README.md) | Gives the model a clock: stamps every user message with local time (plus idle gap and previous-turn duration when they matter) and selectively stamps slow tool results, without breaking prompt caching. Also shows when the last reply finished in the TUI sidebar. | Optional `OPENCODE_MESSAGE_TIMESTAMP*` env overrides. |
| [`overage-guard/`](plugins/overage-guard/README.md) | Pauses a session and its subagents when a subscription provider starts billing beyond the plan (Anthropic extra usage, OpenAI Codex credits) and asks, via a native question form, whether to wait for the reset, allow it until then, or stop. One adapter per provider. Multi-file (`lib/` + `bun test`). | Guards OAuth (subscription) connections only. State in `~/.local/state/opencode/overage-guard.json`; needs the managed OpenCode service to show the question. |
| [`permission-judge/`](plugins/permission-judge/README.md) | Answers permission prompts with a Decisions model (TypeSafe Jev by default): allows low-risk work the user asked for, denies forbidden or unauthorized risky actions with a reason the agent can act on, and leaves everything else to you. Adds `/auto` as a server-side replacement for client auto-accept. | `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`; client auto-accept off. |
| [`token-refresh/`](plugins/token-refresh/README.md) | Keeps every stored OAuth credential fresh, including inactive accounts, by resolving each one through core on a jittered two-minute schedule. Core does the actual refresh and persistence. | Logs to `~/.local/share/opencode/token-refresh.log`. |
| `receipt-printer/` | Adds `receipt_printer_print`, which prints a list of blocks (text, left/right rows, rules, QR codes, feeds) on an Epson TM-T88V over USB and returns a text preview, and `receipt_printer_status`, which reports whether the printer is connected and its paper level. Built for todo lists, notes, and ticket or session summaries. | **macOS**; `uv`, Homebrew `libusb`, the printer on USB (`04b8:0202`). |
| `todo/` | Restores the removed `todowrite` tool. Each call replaces the current session's task list. | State in `~/.local/share/opencode/todo/`. |

## TUI plugins

TUI packages export `./tui` alongside their server entrypoint. OpenCode advertises the installed package's TUI capability to connected terminal clients. These packages do not need duplicate entries in `cli.json`.

| Plugin | Description | Requires |
|---|---|---|
| `active-provider-account/` | Shows active credential labels in the sidebar for providers with multiple saved accounts. | — |
| `background-jobs/` | Active background tools and subagents in the current session's sidebar, with elapsed time. | — |
| `callout/` | Renders the current session's pinned callout in the sidebar (the display half of the `callout` server plugin). | — |
| `elapsed-timer/` | Live session duration in the prompt footer while a session is working. | — |
| `ghostty-progress/` | Drives Ghostty's OSC 9;4 progress-bar indicator while sessions work. Lives in the TUI because OpenCode 2's server runs detached from any terminal. | **Ghostty 1.2.0+** |
| [`question-minimize/`](plugins/question-minimize/README.md) | `alt+m` minimizes a pending question form to a one-line bar so you can read and scroll the transcript, then restores it. Hides the host's form node, since OpenCode has no slot for it. | — |
| `session-close/` | `/close` slash command (and `Session > Close session tab` in the palette) that closes the current tab without deleting its session, then opens a fresh session tab. | Session tabs enabled |
| `session-delete/` | `/delete` slash command (and `Session > Delete session` in the palette) that deletes the session you're looking at, after a confirm that names it and counts its child sessions. | — |
| `session-id-badge/` | Current session ID in the TUI sidebar. | — |
| `session-resume/` | Extends `/resume` to accept a session ID while preserving the native session picker when no ID is supplied. | — |
| `todo/` | Shows the current session's todo list in the sidebar, in the old Todo section. | — |

## Skills

Instruction sets the agent loads on demand. `link.sh` symlinks each `skills/<name>/` into `~/.config/opencode/skills/<name>`.

| Skill | Description | Requires |
|---|---|---|
| `opencode-db-querying/` | Schema + ready-to-run SQL for OpenCode's local SQLite DB (sessions, messages, parts, projects, todos, tokens/cost). Complements opencode-recall with precise SQL. | `opencode` CLI or `sqlite3` |
| `macos-root/` | Run commands as root via `osascript` (because `sudo` can't prompt for a password inside OpenCode). | **macOS** |
| `md2pdf/` | Format/style Markdown for the `md2pdf` CLI (Markdown → HTML → headless Chrome → PDF). | `md2pdf` CLI + Chrome |
| `pdf-reports/` | Author PDF reports by writing Markdown and converting with `md2pdf`. | `md2pdf` CLI |
| `dark-mode/` | Build a dark/light/system theme system: CSS token structure, the pre-paint script that kills the flash, the three-state control, plus Astro and React wiring. | — |
| `btca-local/` | Read upstream source from local clones in `~/.btca/agent/sandbox`, pinned to the installed version or the remote default branch, without mutating the clone. Forked from [davis7dotsh/better-context](https://github.com/davis7dotsh/better-context). | `git` |
| `writing-opencode-plugins/` | Build, extend, debug, and port OpenCode v2 plugins: server hooks and tools, TUI slots and commands, providers and OAuth, RPC, packaging, and v1 migration. Examples typecheck against `@opencode/plugin` 2.0.20. | — |
| `ultra-mode/` | `/ultra-mode` turns on proactive delegation for the rest of the session: split independent work across subagents, keep working while they run, verify their results. User-invoked only (`opencode/autoinvoke: false`). | — |

> `md2pdf` and `pdf-reports` target a specific local tool (a personal `md2pdf` CLI); they're only useful if you run it.

## Retired plugins

These plugins were dropped because OpenCode or another package now covers them. Their source remains in git history.

| Plugin | Replaced by |
|---|---|
| `cache-stats/` | A per-turn token table with cache read/write and cache-bust detection (`debug.turn_tokens` in `cli.json`). |
| `search-scope-guard/` | Path-scoped `external_directory` permissions, which gate out-of-project `glob`/`grep` by rule. |
| `sensitive-file-guard/` | Ordered `permissions` rules on the `read` action (e.g. deny `**/.env`). The bash-pipeline and content-sniffing halves have no native equivalent. |
| `stuck-watchdog/` | Provider-level retry with jittered backoff and `session.retry.scheduled` events. Hung-tool detection has no native equivalent. |
| `tool-timing/` | Per-call durations recorded on the message and rendered in the timeline. |
| `local-session-commands/` | Nothing, as it turned out. Its `/delete` half is back as `session-delete/`: v2 only deletes sessions from inside the session-list dialog (`ctrl+d` twice), with no slash or palette command. Its `/open` half (macOS `open` on a path) is still gone — v2's native `/open` is the project picker, not the same thing. |
| `ultra/` | The `ultra-mode` skill. The plugin's TUI footer slot re-rendered in a tight loop whenever a session was open, sending ~2,300 `rpc/ultra/status` calls and `/api/event` subscriptions per second and pinning the server at 100% CPU. |
| `recall/` | The standalone [opencode-recall](https://github.com/MaxAnderson95/opencode-recall) plugin, which shares one index across machines through a hub. |
| `model-identity/` | Nothing needed it after the v2 port; it stayed unconfigured. |
| `subagent-model/` | The native `subagent` tool's own `model` parameter. |

## Theme

`themes/ayu-max-custom.json` — a customised [Ayu](https://github.com/ayu-theme/ayu-colors)-style theme with dark and light variants.

## Install

Install the selected plugin packages from GitHub:

```bash
opencode2 plugin add 'github:MaxAnderson95/my-opencode-setup#plugin-callout'
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
