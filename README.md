# my-opencode-setup

My personal [OpenCode](https://opencode.ai) plugins, slash commands, theme, and a sample TUI config.

## Contents

```
my-opencode-setup/
├── plugins/          OpenCode plugins
├── commands/         Slash commands paired with the plugins
├── themes/           Custom theme
└── tui.example.jsonc Sample tui.jsonc showing how to wire everything together
```

## Plugins

### Single-file plugins (`plugins/*.ts`)

| Plugin | Description |
|---|---|
| `brrr.ts` | Posts session lifecycle events to a [brrr.now](https://brrr.now) webhook so I get phone notifications when a session goes idle. Requires `BRRR_WEBHOOK_SECRET`. |
| `caffeinate.ts` | Keeps macOS awake while sessions are working. One `caffeinate -di` process per session; the machine can sleep again as soon as every session is idle. |
| `current-session-id.ts` | Exposes the current session ID as the `get_opencode_current_session_id` tool and injects it into the system prompt so the agent can reference it without spending a tool call. |
| `delete-session.ts` | Backs the `/delete` slash command — short-circuits the command template and calls `client.session.delete` directly. |
| `ghostty-progress.ts` | Drives Ghostty's OSC 9;4 progress bar indicator while sessions are working. Requires Ghostty 1.2.0+. |
| `open-in-finder.ts` | Backs the `/open` slash command — opens the current directory (or a given path) with the macOS `open` command. |
| `sensitive-file-guard.ts` | Blocks LLM reads, edits, and copy-into-bash of `.env`, private keys, kubeconfigs, and similar files. Adds a `list_env_keys` tool so the agent can still inspect env file shape (keys only, never values). |
| `tool-timing.ts` | Appends wall-clock duration to every tool call's title so the TUI shows how long each step took. Works for both native and MCP tools. |

### TUI plugins (`plugins/<dir>/`)

These use the [`@opentui/solid`](https://github.com/sst/opencode) JSX runtime and ship as multi-file plugins with their own `package.json`.

| Plugin | Description |
|---|---|
| `elapsed-timer/` | Shows running session duration in the TUI sidebar. |
| `session-id-badge/` | Shows the current session ID in the TUI sidebar. |
| `tokens-per-sec/` | Live tokens-per-second display with a sliding-window average, useful for benchmarking models. |

## Commands

Slash commands that pair with the plugins above:

| File | Triggers | Plugin it relies on |
|---|---|---|
| `commands/delete.md` | `/delete` | `delete-session.ts` |
| `commands/open.md` | `/open [path]` | `open-in-finder.ts` |

Without the matching plugin, the command falls back to sending its template text to the LLM.

## Theme

`themes/ayu-max-custom.json` — a customised [Ayu](https://github.com/ayu-theme/ayu-colors)-style theme with both dark and light variants.

## Install

Clone the repo somewhere persistent (e.g. `~/my-opencode-setup`), then symlink each piece into its OpenCode location.

```bash
git clone https://github.com/MaxAnderson95/my-opencode-setup.git ~/my-opencode-setup
cd ~/my-opencode-setup

# Plugins — symlink the ones you want
ln -s "$PWD/plugins/tool-timing.ts"        ~/.config/opencode/plugins/tool-timing.ts
ln -s "$PWD/plugins/sensitive-file-guard.ts" ~/.config/opencode/plugins/sensitive-file-guard.ts
# ...or symlink the whole plugins directory

# Slash commands (only useful if you also installed the paired plugin)
ln -s "$PWD/commands/delete.md" ~/.config/opencode/commands/delete.md
ln -s "$PWD/commands/open.md"   ~/.config/opencode/commands/open.md

# Theme
ln -s "$PWD/themes/ayu-max-custom.json" ~/.config/opencode/themes/ayu-max-custom.json
```

TUI plugins additionally need their `package.json` resolvable — either install their `peerDependencies` (`@opentui/core`, `@opentui/solid`, `solid-js`) at the `~/.config/opencode/` level, or symlink the directory and let OpenCode pick them up via its own resolution.

See [`tui.example.jsonc`](tui.example.jsonc) for a complete `tui.jsonc` showing how to wire the theme and TUI plugins together.

## License

[MIT](LICENSE)
