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
| `delete-session.ts` | Compatibility stub retained for older installs. `/delete` is handled by `local-session-commands/`. |
| `ghostty-progress.ts` | Drives Ghostty's OSC 9;4 progress bar indicator while sessions are working. Requires Ghostty 1.2.0+. |
| `open-in-finder.ts` | Compatibility stub retained for older installs. `/open` is handled by `local-session-commands/`. |
| `sensitive-file-guard.ts` | Blocks LLM reads, edits, and copy-into-bash of `.env`, private keys, kubeconfigs, and similar files. Adds a `list_env_keys` tool so the agent can still inspect env file shape (keys only, never values). |
| `tool-timing.ts` | Appends wall-clock duration to every tool call's title so the TUI shows how long each step took. Works for both native and MCP tools. |

### `recall/` — search past conversations

Gives the agent long-term conversational memory: hybrid lexical (FTS5/BM25) + semantic (local embeddings, transformers.js) search over **every past OpenCode conversation on the machine**, exposed as the `recall_search`, `recall_expand`, and `recall_status` tools. Fully local — the OpenCode DB is read read-only into a sidecar index, and the only network access is a one-time ~33 MB model download. Can even recover the current session's own pre-compaction history.

Symlink the file, not the directory (`plugins/recall/recall.ts` → `~/.config/opencode/plugins/recall.ts`). Full docs: [plugins/recall/README.md](plugins/recall/README.md).

### TUI plugins (`plugins/<dir>/`)

These use the [`@opentui/solid`](https://github.com/sst/opencode) JSX runtime and ship as multi-file plugins with their own `package.json`.

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

Clone the repo somewhere persistent (e.g. `~/my-opencode-setup`), then symlink each piece into its OpenCode location.

```bash
git clone https://github.com/MaxAnderson95/my-opencode-setup.git ~/my-opencode-setup
cd ~/my-opencode-setup

# Plugins — symlink the ones you want
ln -s "$PWD/plugins/tool-timing.ts"        ~/.config/opencode/plugins/tool-timing.ts
ln -s "$PWD/plugins/sensitive-file-guard.ts" ~/.config/opencode/plugins/sensitive-file-guard.ts
# ...or symlink the whole plugins directory

# recall — symlink the file, not the directory (the loader only scans plugins/*.ts)
ln -s "$PWD/plugins/recall/recall.ts" ~/.config/opencode/plugins/recall.ts

# Slash commands (only useful if you also installed the paired plugin)
ln -s "$PWD/commands/delete.md" ~/.config/opencode/commands/delete.md
ln -s "$PWD/commands/open.md"   ~/.config/opencode/commands/open.md

# TUI local commands
ln -s "$PWD/plugins/local-session-commands" ~/.config/opencode/plugins/local-session-commands

# Theme
ln -s "$PWD/themes/ayu-max-custom.json" ~/.config/opencode/themes/ayu-max-custom.json
```

TUI plugins additionally need their `package.json` resolvable — either install their `peerDependencies` (`@opentui/core`, `@opentui/solid`, `solid-js`) at the `~/.config/opencode/` level, or symlink the directory and let OpenCode pick them up via its own resolution.

See [`tui.example.jsonc`](tui.example.jsonc) for a complete `tui.jsonc` showing how to wire the theme and TUI plugins together.

## License

[MIT](LICENSE)
