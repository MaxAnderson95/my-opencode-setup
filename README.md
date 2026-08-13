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

Regular plugins that hook OpenCode's event/tool system. OpenCode auto-discovers them by scanning `plugins/*.{ts,js}` (**top-level files only**, but it follows symlinks), so each is symlinked into `~/.config/opencode/plugins/<name>.ts` pointing at the folder's inner source file.

Top-level-only applies to *discovery* of that entry file, not to what it may import: Bun resolves relative specifiers against a module's real path, so a plugin can split into a `lib/` folder and still be found. `recall/` does exactly that.

| Plugin | Description | Requires / config |
|---|---|---|
| `caffeinate/` | Keeps macOS awake while sessions are working (one `caffeinate -di` per session; sleeps once all are idle). | **macOS** |
| `current-session-id/` | Exposes the `get_opencode_current_session_id` tool and injects the current session ID into the system prompt. | — |
| [`hark/`](plugins/hark/README.md) | Push notifications to a [Hark](https://hark.ryan.ceo) webhook when a long-running session finishes, needs permission, asks a question, or errors — so you get pinged on your iPhone. | `HARK_WEBHOOK_URL` env (no-op without it); a Hark account. |
| [`mcp-lazy/`](plugins/mcp-lazy/README.md) | Model-controlled MCP server enable/disable so only in-use servers cost tool-schema context. Adds `mcp_enable` / `mcp_disable`. | — |
| [`message-timestamps/`](plugins/message-timestamps/README.md) | Gives the model a clock: stamps every user message with local time (plus idle gap and previous-turn duration when they matter) and selectively stamps slow tool results, without breaking prompt caching. | Optional `OPENCODE_MESSAGE_TIMESTAMP*` env overrides. |
| [`recall/`](plugins/recall/README.md) | Long-term conversational memory: hybrid lexical (FTS5/BM25) + semantic (local transformers.js embeddings) search over every past OpenCode conversation. An escalation ladder of tools: `recall_search` (find sessions) / `recall_inspect` (search within one, or outline it) / `recall_expand` (read transcript) / `recall_summarize` (delegate to a cheap worker model, cached permanently) / `recall_status`. Announces long background indexing via TUI toasts and stays silent for routine catch-up. The only multi-file plugin here (`lib/` + `bun test`). | One-time ~33 MB model download; reads the OpenCode DB read-only. Optional `~/.config/opencode/recall.json`. |
| `model-identity/` | Stamps each user message with the resolved model and reasoning effort (`<model-slug>` / `<model-effort>`), so the model knows what it is. | — |

## TUI plugins

These use the [`@opentui/solid`](https://github.com/sst/opencode) JSX runtime and claim slots in the TUI's layout. OpenCode 2 auto-scans `<config>/plugins/tui/` for `*.{ts,tsx,js,jsx}` (symlinks included), so `link.sh` symlinks the inner `tui.tsx` there. No config entry is needed — v1's `tui.jsonc` `plugin[]` array is gone.

| Plugin | Description | Requires |
|---|---|---|
| `callout/` | Renders the current session's pinned callout in the sidebar (the display half of the `callout` server plugin). | — |
| `elapsed-timer/` | Live session duration in the prompt footer while a session is working. | — |
| `ghostty-progress/` | Drives Ghostty's OSC 9;4 progress-bar indicator while sessions work. Lives in the TUI because OpenCode 2's server runs detached from any terminal. | **Ghostty 1.2.0+** |
| `session-id-badge/` | Current session ID in the TUI sidebar. | — |
| `tokens-per-sec/` | Live tokens-per-second with a sliding-window average, and a per-turn average once idle. | — |

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

Seven plugins were dropped in the OpenCode 2 port because v2 grew a native equivalent. They remain in git history (`d536794`) if any needs resurrecting.

| Plugin | Replaced by |
|---|---|
| `cache-stats/` | A per-turn token table with cache read/write and cache-bust detection (`debug.turn_tokens` in `cli.json`). |
| `search-scope-guard/` | Path-scoped `external_directory` permissions, which gate out-of-project `glob`/`grep` by rule. |
| `sensitive-file-guard/` | Ordered `permissions` rules on the `read` action (e.g. deny `**/.env`). The bash-pipeline and content-sniffing halves have no native equivalent. |
| `stuck-watchdog/` | Provider-level retry with jittered backoff and `session.retry.scheduled` events. Hung-tool detection has no native equivalent. |
| `tool-timing/` | Per-call durations recorded on the message and rendered in the timeline. |
| `local-session-commands/` | Native `/open` and `/delete` slash commands. |
| `subagent-model/` | The native `subagent` tool plus per-agent `model:` pinning. |

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

- **Server plugins** → symlinks the inner file, e.g. `plugins/recall/recall.ts` → `~/.config/opencode/plugins/recall.ts`. Required because the loader's auto-scan matches only top-level `plugins/*.{ts,js}` — symlinking the whole `plugins/` directory would leave the nested server plugins undiscovered.
- **TUI plugins** → symlinks the inner entrypoint, e.g. `plugins/elapsed-timer/tui.tsx` → `~/.config/opencode/plugins/tui/elapsed-timer.tsx`.
- **Skills** → symlinks the directory, e.g. `skills/opencode-db-querying` → `~/.config/opencode/skills/opencode-db-querying`.
- **Upgrading from v1** → removes stale directory symlinks left by the old layout. That matters: a leftover `plugins/callout/` still resolves under OpenCode 2's package discovery and would load the v1 source alongside its v2 replacement.

Then set the theme in `cli.json` (see [`cli.example.json`](cli.example.json)) and symlink it:

```bash
ln -s "$PWD/themes/ayu-max-custom.json" ~/.config/opencode/themes/ayu-max-custom.json
```

## How plugins load (for adapters)

OpenCode 2 discovers **server plugins** two ways: an explicit entry in `opencode.jsonc`'s `plugins[]` (a `file://` path, npm spec, or `{ "package": …, "options": … }` object), or the auto-scan of `{plugin,plugins}/*.{ts,js}` (top-level files only, follows symlinks). It also loads a child *directory* as a package when that directory has a string `main`/`module`/`exports` or an `index.ts|js` — which is why stale v1 directory symlinks are actively harmful rather than merely inert.

**TUI plugins** are auto-scanned separately from `<config>/plugins/tui/`, matching `*.{ts,tsx,js,jsx}` including symlinks. The v1 mechanism (a `./tui` export listed in `tui.jsonc`) is gone; `tui.json(c)` is migrated once into `cli.json` on first run.

That's why server plugins here are folders in the repo but symlinked by their **inner file**: the folder gives each plugin its own `package.json` (name, `main`, `engines`, peer deps) while the inner-file symlink keeps the auto-scan working. Passing options to a plugin requires listing it explicitly in `opencode.jsonc` with the object form; the plugin reads them from `ctx.options`.

## License

[MIT](LICENSE)
