# my-opencode-setup

My personal [OpenCode](https://opencode.ai) plugins, slash commands, theme, and a sample TUI config.

## Contents

```
my-opencode-setup/
├── plugins/          OpenCode plugins — one folder per plugin, each with its own package.json
├── commands/         Slash commands paired with the plugins
├── themes/           Custom theme
├── link.sh           Symlinks each plugin into your OpenCode config
└── tui.example.jsonc Sample tui.jsonc showing how to wire everything together
```

Every plugin is a self-contained folder (`plugins/<name>/`) with its own `package.json`. There are two kinds, and they load differently — see [Install](#install).

## Server plugins

Regular plugins that hook OpenCode's event/tool system. OpenCode auto-discovers them by scanning `plugins/*.{ts,js}` (**top-level files only**, but it follows symlinks), so each one is symlinked into `~/.config/opencode/plugins/<name>.ts` pointing at the folder's inner source file.

| Plugin | Description |
|---|---|
| `brrr/` | Posts session lifecycle events to a [brrr.now](https://brrr.now) webhook so I get phone notifications when a session goes idle. Requires `BRRR_WEBHOOK_SECRET`. |
| `caffeinate/` | Keeps macOS awake while sessions are working. One `caffeinate -di` process per session; the machine can sleep again once every session is idle. |
| `current-session-id/` | Exposes the current session ID as the `get_opencode_current_session_id` tool and injects it into the system prompt so the agent can reference it without spending a tool call. |
| `delete-session/` | Compatibility stub retained for older installs. `/delete` is handled by `local-session-commands/`. |
| `engram/` | Thin adapter connecting OpenCode's event system to the [Engram](https://github.com/) persistent-memory binary (a local HTTP server backed by SQLite). Injects the memory protocol into context and forwards lifecycle events. |
| `ghostty-progress/` | Drives Ghostty's OSC 9;4 progress-bar indicator while sessions are working. Requires Ghostty 1.2.0+. |
| `mcp-lazy/` | Model-controlled MCP server enable/disable so only in-use servers cost tool-schema context. Injects a per-turn Active/Available MCP block and adds `mcp_enable` / `mcp_disable` tools; always-on servers (`enabled !== false`) are protected from disable. |
| `open-in-finder/` | Compatibility stub retained for older installs. `/open` is handled by `local-session-commands/`. |
| `recall/` | Long-term conversational memory: hybrid lexical (FTS5/BM25) + semantic (local embeddings via transformers.js) search over **every past OpenCode conversation on the machine**, exposed as `recall_search`, `recall_expand`, and `recall_status`. Fully local — reads the OpenCode DB read-only into a sidecar index; the only network access is a one-time model download. Full docs: [plugins/recall/README.md](plugins/recall/README.md). |
| `sensitive-file-guard/` | Blocks LLM reads, edits, and copy-into-bash of `.env`, private keys, kubeconfigs, and similar files. Adds a `list_env_keys` tool so the agent can still inspect env-file shape (keys only, never values). |
| `tool-timing/` | Appends wall-clock duration to every tool call's title so the TUI shows how long each step took. Works for both native and MCP tools. |

## TUI plugins

These use the [`@opentui/solid`](https://github.com/sst/opencode) JSX runtime and expose a `./tui` entrypoint via their `package.json`. They are **not** auto-scanned — you symlink the whole directory and list it in `tui.jsonc`.

| Plugin | Description |
|---|---|
| `elapsed-timer/` | Shows running session duration in the TUI sidebar. |
| `local-session-commands/` | Handles `/open [path]` and `/delete` directly in the TUI without sending command templates to the LLM. |
| `session-id-badge/` | Shows the current session ID in the TUI sidebar. |
| `tokens-per-sec/` | Live tokens-per-second display with a sliding-window average, useful for benchmarking models. |

## Commands

Slash commands that pair with the plugins above:

| File | Triggers | Plugin it relies on |
|---|---|---|
| `commands/delete.md` | `/delete` | `local-session-commands/` |
| `commands/open.md` | `/open [path]` | `local-session-commands/` |

Without the matching TUI plugin, the command falls back to sending its template text to the LLM.

## Theme

`themes/ayu-max-custom.json` — a customised [Ayu](https://github.com/ayu-theme/ayu-colors)-style theme with both dark and light variants.

## Install

Clone the repo somewhere persistent, then symlink each piece into its OpenCode location.

```bash
git clone https://github.com/MaxAnderson95/my-opencode-setup.git ~/my-opencode-setup
cd ~/my-opencode-setup
bun install            # resolves @opencode-ai/plugin, transformers.js, etc.
./link.sh              # symlinks every plugin into ~/.config/opencode/plugins/
```

`link.sh` handles both kinds automatically:

- **Server plugins** → symlinks the inner file, e.g. `plugins/tool-timing/tool-timing.ts` → `~/.config/opencode/plugins/tool-timing.ts`. This is required because the loader's auto-scan matches only top-level `plugins/*.{ts,js}` — symlinking the whole `plugins/` directory would leave the nested server plugins undiscovered.
- **TUI plugins** → symlinks the directory, e.g. `plugins/elapsed-timer` → `~/.config/opencode/plugins/elapsed-timer`, and reminds you to add it to `tui.jsonc`.

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

And symlink the slash commands (only useful if you also installed the paired TUI plugin):

```bash
ln -s "$PWD/commands/delete.md" ~/.config/opencode/commands/delete.md
ln -s "$PWD/commands/open.md"   ~/.config/opencode/commands/open.md
ln -s "$PWD/themes/ayu-max-custom.json" ~/.config/opencode/themes/ayu-max-custom.json
```

## License

[MIT](LICENSE)
