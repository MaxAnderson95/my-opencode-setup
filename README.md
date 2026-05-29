# my-opencode-setup

My personal collection of [OpenCode](https://opencode.ai) plugins.

## Plugins

### Single-file plugins (`plugins/*.ts`)

| Plugin | Description |
|---|---|
| `brrr.ts` | Posts session lifecycle events to a [brrr.now](https://brrr.now) webhook so I get phone notifications when a session goes idle. Requires `BRRR_WEBHOOK_SECRET`. |
| `caffeinate.ts` | Keeps macOS awake while sessions are working. One `caffeinate -di` process per session; the machine can sleep again as soon as every session is idle. |
| `current-session-id.ts` | Exposes the current session ID as the `get_opencode_current_session_id` tool and injects it into the system prompt so the agent can reference it without spending a tool call. |
| `delete-session.ts` | `/delete` slash command — short-circuits the command template and calls `client.session.delete` directly. |
| `ghostty-progress.ts` | Drives Ghostty's OSC 9;4 progress bar indicator while sessions are working. Requires Ghostty 1.2.0+. |
| `open-in-finder.ts` | `/open` slash command — opens the current directory (or a given path) with the macOS `open` command. |
| `sensitive-file-guard.ts` | Blocks LLM reads, edits, and copy-into-bash of `.env`, private keys, kubeconfigs, and similar files. Adds a `list_env_keys` tool so the agent can still inspect env file shape (keys only, never values). |
| `tool-timing.ts` | Appends wall-clock duration to every tool call's title so the TUI shows how long each step took. Works for both native and MCP tools. |

### TUI plugins (`plugins/<dir>/`)

These use the [`@opentui/solid`](https://github.com/sst/opencode) JSX runtime and ship as multi-file plugins with their own `package.json`.

| Plugin | Description |
|---|---|
| `elapsed-timer/` | Shows running session duration in the TUI sidebar. |
| `session-id-badge/` | Shows the current session ID in the TUI sidebar. |
| `tokens-per-sec/` | Live tokens-per-second display with a sliding-window average, useful for benchmarking models. |

## Install

Clone the repo and symlink the plugins you want into `~/.config/opencode/plugins/`:

```bash
git clone https://github.com/MaxAnderson95/my-opencode-setup.git
cd my-opencode-setup
ln -s "$PWD/plugins/tool-timing.ts" ~/.config/opencode/plugins/tool-timing.ts
# ...or symlink the whole plugins directory
```

TUI plugins additionally need their `package.json` resolvable — either install their `peerDependencies` (`@opentui/core`, `@opentui/solid`, `solid-js`) at the `~/.config/opencode/` level, or symlink the directory and let OpenCode pick them up via its own resolution.

## License

[MIT](LICENSE)
