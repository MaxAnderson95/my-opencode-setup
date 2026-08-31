# my-opencode-setup

Personal [OpenCode](https://opencode.ai) plugins, skills, slash commands, and a theme — packaged so you can cherry-pick the pieces you want. Everything is self-contained: one folder per plugin/skill, each with its own metadata.

> **Platform:** built and tested on **macOS**. A few plugins/skills are macOS-specific (flagged in the tables below); the rest are cross-platform.

## Requirements

- **OpenCode 2** (the `opencode2` binary, `@opencode-ai/cli@next`); developed against `0.0.0-next-17403`. These plugins use the v2 plugin API and **do not load in OpenCode 1**.
- **[Bun](https://bun.sh)** — resolves plugin dependencies (`bun install`) and is the runtime for several plugins (`bun:sqlite`, `Bun.spawn`).
- Individual plugins/skills may need extra tools — see the **Requires / config** column in each table.

## Contents

```
my-opencode-setup/
├── plugins/          One folder per plugin, each with its own package.json
├── skills/           One folder per skill (SKILL.md)
├── themes/           Custom theme
├── link.sh           Symlinks the plugins and skills into your OpenCode config
└── cli.example.json  Sample cli.json (theme + TUI options)
```

## Server plugins

Regular plugins that hook OpenCode's event/tool system. Server-only plugins use OpenCode's top-level `plugins/*.{ts,js}` discovery. Plugins that also have a TUI entrypoint use the package-directory layout described below.

Top-level-only applies to discovery of a server-only entry file, not to what it may import. Bun resolves relative specifiers against a module's real path, so a plugin can split into a `lib/` folder and still be found. `recall/` does exactly that.

| Plugin | Description | Requires / config |
|---|---|---|
| `caffeinate/` | Keeps macOS awake while sessions are working (one `caffeinate -di` per session; sleeps once all are idle). | **macOS** |
| `current-session-id/` | Exposes the `get_opencode_current_session_id` tool and injects the current session ID into the system prompt. | — |
| [`hark/`](plugins/hark/README.md) | Push notifications to a [Hark](https://hark.ryan.ceo) webhook when a long-running session finishes, needs permission, asks a question, or errors — so you get pinged on your iPhone. | `HARK_WEBHOOK_URL` env (no-op without it); a Hark account. |
| [`mcp-lazy/`](plugins/mcp-lazy/README.md) | Model-controlled MCP server enable/disable so only in-use servers cost tool-schema context. Adds `mcp_enable` / `mcp_disable`. | — |
| [`message-timestamps/`](plugins/message-timestamps/README.md) | Gives the model a clock: stamps every user message with local time (plus idle gap and previous-turn duration when they matter) and selectively stamps slow tool results, without breaking prompt caching. | Optional `OPENCODE_MESSAGE_TIMESTAMP*` env overrides. |
| [`recall/`](plugins/recall/README.md) | Long-term conversational memory: hybrid lexical (FTS5/BM25) + semantic (local transformers.js embeddings) search over every past OpenCode conversation. An escalation ladder of tools: `recall_search` (find sessions) / `recall_inspect` (search within one, or outline it) / `recall_expand` (read transcript) / `recall_summarize` (delegate to a cheap worker model, cached permanently) / `recall_status`. Announces long background indexing via TUI toasts and stays silent for routine catch-up. The only multi-file plugin here (`lib/` + `bun test`). | One-time ~33 MB model download; reads the OpenCode DB read-only. Optional `~/.config/opencode/recall.json`. |
| `model-identity/` | Stamps each user message with the resolved model and reasoning effort (`<model-slug>` / `<model-effort>`), so the model knows what it is. | — |
| `subagent-model/` | Adds an optional per-invocation `model` override to the native `subagent` tool while retaining native child sessions, jobs, and TUI rendering. | — |

## TUI plugins

These use the [`@opentui/solid`](https://github.com/sst/opencode) JSX runtime and claim slots in the TUI's layout. Each package has an `index.ts` server entrypoint beside `tui.tsx`. `link.sh` symlinks the package directory into `<config>/plugins/<name>`, allowing the server to advertise the TUI entrypoint to connected clients. No `cli.json` entry is needed.

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

Clone the repo somewhere persistent, then wire it into your OpenCode config.

```bash
git clone https://github.com/MaxAnderson95/my-opencode-setup.git ~/my-opencode-setup
cd ~/my-opencode-setup
bun install            # resolves @opencode-ai/plugin, transformers.js, etc.
./link.sh              # symlinks plugins and skills into ~/.config/opencode/
```

`link.sh` handles each kind automatically, and is idempotent:

- **Server-only plugins** → symlinks the inner file, e.g. `plugins/recall/recall.ts` → `~/.config/opencode/plugins/recall.ts`.
- **Plugins with a TUI entrypoint** → symlinks the package directory, e.g. `plugins/elapsed-timer` → `~/.config/opencode/plugins/elapsed-timer`. OpenCode loads `index.ts` on the server and its sibling `tui.tsx` in connected terminal clients.
- **Skills** → symlinks the directory, e.g. `skills/opencode-db-querying` → `~/.config/opencode/skills/opencode-db-querying`.
- **Upgrading** → removes links from the retired flat TUI layout before creating current links.

Then set the theme in `cli.json` (see [`cli.example.json`](cli.example.json)) and symlink it:

```bash
ln -s "$PWD/themes/ayu-max-custom.json" ~/.config/opencode/themes/ayu-max-custom.json
```

## How plugins load (for adapters)

OpenCode 2 discovers **server plugins** from an explicit entry in `opencode.jsonc`'s `plugins[]`, top-level `{plugin,plugins}/*.{ts,js}` files, or immediate package directories containing `index.ts` or `index.js`. Configured local paths must name a directory, not an entrypoint file.

**TUI plugins** load from `tui.*` beside a package's `index.*`. A connected TUI receives this capability from the active server plugin list. CLI-only packages can instead be configured as directories in `cli.json`.

Passing options to a plugin requires listing its directory explicitly in `opencode.jsonc` with the object form; the plugin reads them from `ctx.options`.

## License

[MIT](LICENSE)
