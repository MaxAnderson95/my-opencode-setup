# mcp-lazy

Model-controlled MCP server enable/disable, so only the MCP servers you're actively using cost tool-schema context.

## Why

Every connected MCP server injects its tool schemas into the model's context on **every turn**. With many servers configured, that's a large, permanent context tax. `mcp-lazy` lets the model connect a server only when it needs it and disconnect it when done — a disconnected server contributes **zero** tool schemas.

## How it works

1. **Per-turn awareness.** Via `ctx.session.hook("context")`, it appends an "MCP servers" block to the system prompt listing each server as **Active** (connected) or **Available** (configured but disconnected), so the model always knows what exists and its live state.
2. **Runtime toggles.** Two tools:
   - **`mcp_enable(servers: string[])`** — connects one or more servers through the server's native `/api/mcp/{name}/connect` endpoint. When the tool call returns, the model can continue immediately and use the newly loaded tools without waiting for another user message (the toolset is rebuilt per request). Reports `needs_auth` (telling the user to run `opencode mcp auth <name>`) where relevant.
   - **`mcp_disable(servers: string[])`** — disconnects one or more servers to free their context.

## Always-on protection

Servers configured without `"disabled": true` in your OpenCode config connect at startup and are treated as **always-on**; `mcp_disable` refuses to touch them. Set `"disabled": true` on a server in `opencode.jsonc` to make it lazy-toggleable (available-but-off until the model enables it).

## Requirements & configuration

- No environment variables. It reads MCP state and config from the hosting server's HTTP API, discovered through the local-service registration file (`$XDG_STATE_HOME/opencode/service.json`).
- Configure which servers are lazy vs always-on through the standard `mcp.servers` block in `opencode.jsonc` (`"disabled": true` ⇒ available-but-off, toggleable; otherwise always-on).

Verified against @opencode-ai/plugin 0.0.0-next-17403 (OpenCode v2 beta).
