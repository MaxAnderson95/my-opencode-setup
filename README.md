# my-opencode-setup

Personal [OpenCode](https://opencode.ai) plugins, skills, slash commands, and a theme — packaged so you can cherry-pick the pieces you want. Everything is self-contained: one folder per plugin/skill, each with its own metadata.

> **Platform:** built and tested on **macOS**. A few plugins/skills are macOS-specific (flagged in the tables below); the rest are cross-platform.

## Requirements

- **OpenCode** ≥ 1.3.14 (each plugin declares `engines.opencode`); developed against 1.17.x.
- **[Bun](https://bun.sh)** — resolves plugin dependencies (`bun install`) and is the runtime for several plugins (`bun:sqlite`, `Bun.spawn`).
- Individual plugins/skills may need extra tools — see the **Requires / config** column in each table.

## Contents

```
my-opencode-setup/
├── plugins/          One folder per plugin, each with its own package.json
├── skills/           One folder per skill (SKILL.md)
├── commands/         Slash commands paired with the plugins
├── themes/           Custom theme
├── link.sh           Symlinks the plugins and skills into your OpenCode config
└── tui.example.jsonc Sample tui.jsonc showing how to wire everything together
```

## Server plugins

Regular plugins that hook OpenCode's event/tool system. OpenCode auto-discovers them by scanning `plugins/*.{ts,js}` (**top-level files only**, but it follows symlinks), so each is symlinked into `~/.config/opencode/plugins/<name>.ts` pointing at the folder's inner source file.

| Plugin | Description | Requires / config |
|---|---|---|
| `caffeinate/` | Keeps macOS awake while sessions are working (one `caffeinate -di` per session; sleeps once all are idle). | **macOS** |
| `current-session-id/` | Exposes the `get_opencode_current_session_id` tool and injects the current session ID into the system prompt. | — |
| `ghostty-progress/` | Drives Ghostty's OSC 9;4 progress-bar indicator while sessions work. | **Ghostty 1.2.0+** |
| [`hark/`](plugins/hark/README.md) | Push notifications to a [Hark](https://hark.ryan.ceo) webhook when a long-running session finishes, needs permission, asks a question, or errors — so you get pinged on your iPhone. | `HARK_WEBHOOK_URL` env (no-op without it); a Hark account. |
| [`mcp-lazy/`](plugins/mcp-lazy/README.md) | Model-controlled MCP server enable/disable so only in-use servers cost tool-schema context. Adds `mcp_enable` / `mcp_disable`. | — |
| [`message-timestamps/`](plugins/message-timestamps/README.md) | Gives the model a clock: stamps every user message with local time (plus idle gap and previous-turn duration when they matter) and selectively stamps slow tool results, without breaking prompt caching. | Optional `OPENCODE_MESSAGE_TIMESTAMP*` env overrides. |
| [`recall/`](plugins/recall/README.md) | Long-term conversational memory: hybrid lexical (FTS5/BM25) + semantic (local transformers.js embeddings) search over every past OpenCode conversation. An escalation ladder of tools: `recall_search` (find sessions) / `recall_inspect` (search within one, or outline it) / `recall_expand` (read transcript) / `recall_summarize` (delegate to GLM-5.2 via OpenCode Go, cached) / `recall_status`. | One-time ~model download; reads the OpenCode DB read-only. |
| [`sensitive-file-guard/`](plugins/sensitive-file-guard/README.md) | Blocks LLM reads, edits, and copy-into-bash of `.env`, private keys, kubeconfigs, etc. Adds `list_env_keys` (keys only, never values) and `set_env_value` (writes one assignment, returns no values). | Optional `protected` / `blockCopy` config. |
| `subagent-model/` | Run a subagent on a specific provider **and** model, with an optional reasoning `variant`. Adds `task_with_model` / `list_subagent_models` (with per-provider pricing, since one model is often sold by several providers at different rates). | — |
| `tool-timing/` | Appends wall-clock duration to every tool call's title (works for native and MCP tools). | — |

## TUI plugins

These use the [`@opentui/solid`](https://github.com/sst/opencode) JSX runtime and expose a `./tui` entrypoint via their `package.json`. They are **not** auto-scanned — you symlink the whole directory and list it in `tui.jsonc`.

| Plugin | Description | Requires |
|---|---|---|
| `elapsed-timer/` | Running session duration in the TUI sidebar. | — |
| `local-session-commands/` | Handles `/open [path]` and `/delete` directly in the TUI (no LLM round-trip). | **macOS** for `/open` (`open`) |
| `session-id-badge/` | Current session ID in the TUI sidebar. | — |
| `tokens-per-sec/` | Live tokens-per-second with a sliding-window average (handy for benchmarking models). | — |

## Skills

Instruction sets the agent loads on demand. `link.sh` symlinks each `skills/<name>/` into `~/.config/opencode/skills/<name>`.

| Skill | Description | Requires |
|---|---|---|
| `opencode-db-querying/` | Schema + ready-to-run SQL for OpenCode's local SQLite DB (sessions, messages, parts, projects, todos, tokens/cost). Complements `recall/` with precise SQL. | `opencode` CLI or `sqlite3` |
| `macos-root/` | Run commands as root via `osascript` (because `sudo` can't prompt for a password inside OpenCode). | **macOS** |
| `md2pdf/` | Format/style Markdown for the `md2pdf` CLI (Markdown → HTML → headless Chrome → PDF). | `md2pdf` CLI + Chrome |
| `pdf-reports/` | Author PDF reports by writing Markdown and converting with `md2pdf`. | `md2pdf` CLI |
| `openusage/` | Report AI-subscription usage/limits by reading the local OpenUsage menu-bar app's HTTP API. | **macOS** + the OpenUsage app |

> `md2pdf` and `openusage` target specific local tools (a personal `md2pdf` CLI and the OpenUsage menu-bar app); they're only useful if you run those tools.

## Commands

Slash commands that pair with the TUI plugins:

| File | Triggers | Relies on |
|---|---|---|
| `commands/delete.md` | `/delete` | `local-session-commands/` |
| `commands/open.md` | `/open [path]` | `local-session-commands/` |

Without the matching TUI plugin, the command falls back to sending its template text to the LLM.

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

`link.sh` handles each kind automatically:

- **Server plugins** → symlinks the inner file, e.g. `plugins/tool-timing/tool-timing.ts` → `~/.config/opencode/plugins/tool-timing.ts`. Required because the loader's auto-scan matches only top-level `plugins/*.{ts,js}` — symlinking the whole `plugins/` directory would leave the nested server plugins undiscovered.
- **TUI plugins** → symlinks the directory, e.g. `plugins/elapsed-timer` → `~/.config/opencode/plugins/elapsed-timer`, and reminds you to add it to `tui.jsonc`.
- **Skills** → symlinks the directory, e.g. `skills/opencode-db-querying` → `~/.config/opencode/skills/opencode-db-querying`.

Then wire up the theme and TUI plugins in `tui.jsonc` (see [`tui.example.jsonc`](tui.example.jsonc)):

```jsonc
{
  "theme": "ayu-max-custom",
  "plugin": [
    "file:///Users/you/.config/opencode/plugins/elapsed-timer",
    "file:///Users/you/.config/opencode/plugins/tokens-per-sec",
    "file:///Users/you/.config/opencode/plugins/session-id-badge",
    "file:///Users/you/.config/opencode/plugins/local-session-commands"
  ]
}
```

And symlink the slash commands and theme (commands only matter if you installed the paired TUI plugin):

```bash
ln -s "$PWD/commands/delete.md" ~/.config/opencode/commands/delete.md
ln -s "$PWD/commands/open.md"   ~/.config/opencode/commands/open.md
ln -s "$PWD/themes/ayu-max-custom.json" ~/.config/opencode/themes/ayu-max-custom.json
```

## How plugins load (for adapters)

OpenCode discovers **server plugins** two ways: an explicit entry in `opencode.jsonc`'s `plugin[]` (a `file://` path or npm spec), or the auto-scan of `{plugin,plugins}/*.{ts,js}` (top-level files only, follows symlinks). **TUI plugins** are never auto-scanned — they expose `exports["./tui"]` and are listed in `tui.jsonc`'s `plugin[]` as `file://` **directory** paths.

That's why server plugins here are folders in the repo but symlinked by their **inner file**: the folder gives each plugin its own `package.json` (name, `main`, `engines`, peer deps) while the inner-file symlink keeps the auto-scan working. Passing config to a plugin (e.g. `sensitive-file-guard`) requires listing it explicitly in `opencode.jsonc` with the `["<spec>", { …options }]` form — see that plugin's README.

## License

[MIT](LICENSE)
