# mcp-lazy

Model-controlled MCP server enable/disable, so only the MCP servers you're actively using cost tool-schema context.

## Why

Every connected MCP server injects its tool schemas into the model's context on **every turn**. With many servers configured, that's a large, permanent context tax. `mcp-lazy` lets the model connect a server only when it needs it and disconnect it when done — a disconnected server contributes **zero** tool schemas.

## How it works

1. **Per-turn awareness.** Via `experimental.chat.system.transform`, it appends an "MCP servers" block to the system prompt listing each server as **Active** (connected) or **Available** (configured but disconnected), so the model always knows what exists and its live state.
2. **Runtime toggles.** Two tools:
   - **`mcp_enable(servers: string[])`** — connects one or more servers. When the tool call returns, the model can continue immediately and use the newly loaded tools without waiting for another user message (the toolset is rebuilt per request). Reports `needs_auth` (telling the user to run `opencode mcp auth <name>`) or `needs_client_registration` where relevant.
   - **`mcp_disable(servers: string[])`** — disconnects one or more servers to free their context.

## Always-on protection

Servers configured with `enabled !== false` in your OpenCode config are treated as **always-on** and cannot be disabled by `mcp_disable` — set `"enabled": false` on a server in `opencode.jsonc` to make it lazy-toggleable.

## Requirements & configuration

- No environment variables. It reads your existing OpenCode MCP config via the plugin client.
- Configure which servers are lazy vs always-on through the standard `mcp` block in `opencode.jsonc` (`"enabled": false` ⇒ available-but-off, toggleable; otherwise always-on).

Verified against opencode 1.17.11 (plugin SDK 1.4.10).
