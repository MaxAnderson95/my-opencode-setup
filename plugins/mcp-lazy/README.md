# mcp-lazy

Enable MCP servers when needed and disable them when finished to reduce tool-schema context.

## How it works

The plugin uses `ctx.mcp.transform` and `ctx.mcp.reload` in the hosting OpenCode process. Toggle state and configuration belong to the plugin's Location and are shared by sessions there. Moving a session selects the destination's plugin instance. No HTTP service discovery, credentials, or session-directory cache is involved.

- `mcp_enable({"servers":["docs"]})` enables the named servers. After connection, it waits up to three seconds to observe tools in the registry and reports the count. A connected server with no observed tools is reported as unverified.
- `mcp_disable({"servers":["docs"]})` disables the named servers and waits up to three seconds for their tools to leave the registry.
- A context hook lists connected and available servers. Authentication failures direct the user to `/mcps`.

Registry observation uses OpenCode's normalized MCP namespace. It does not execute a tool, guarantee permissions, or detect a later plugin removing tools after this plugin's transform. Already-captured model tool snapshots are unchanged. An MCP server that exposes only resources or prompts can connect successfully without any tools.

## Configuration

Set `disabled: true` in `mcp.servers` for servers that should start off and allow runtime toggling. Servers enabled by the configuration before this plugin's transform are always-on and cannot be disabled through `mcp_disable`. Configuration reloads recompute this protection. Runtime toggles last until the Location/plugin is unloaded.

The plugin depends on `@opencode/plugin` version `0.0.0-beta-19296`, matching the targeted OpenCode build. Other plugins retain their own SDK dependencies.

## Checks

```sh
bun test plugins/mcp-lazy
./node_modules/.bin/tsc -p plugins/mcp-lazy/tsconfig.json
```
