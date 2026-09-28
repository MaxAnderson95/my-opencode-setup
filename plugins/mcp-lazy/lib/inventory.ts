/**
 * Pure inventory logic: which servers are protected, how the per-turn system
 * block renders, and the unknown-server message. Kept side-effect free so it
 * is directly testable; the entry wires it to live server state.
 */

import type { Plugin } from "@opencode/plugin"

export type McpServerRow = Awaited<ReturnType<Plugin.Context["mcp"]["list"]>>["data"][number]
export type McpServerConfig = {
  type: "local" | "remote"
  disabled?: boolean
  oauth?: object | false
}

/**
 * Always-on rule, ported from v1's `enabled !== false`: v2 config spells it
 * `disabled?: boolean`, so a server that is in config and NOT marked disabled
 * connects at startup and is protected from mcp_disable. Servers added at
 * runtime (absent from config) are toggleable.
 */
export function isProtected(cfg: Record<string, McpServerConfig>, name: string): boolean {
  const entry = cfg[name]
  return entry !== undefined && entry.disabled !== true
}

export function isOAuth(cfg: Record<string, McpServerConfig>, name: string): boolean {
  const entry = cfg[name]
  return entry?.type === "remote" && entry.oauth !== false
}

export function unknownMsg(validNames: readonly string[], name: string): string {
  return `- ${name}: unknown server (valid: ${validNames.length ? validNames.join(", ") : "none configured"})`
}

export function renderBlock(rows: readonly McpServerRow[], cfg: Record<string, McpServerConfig>): string {
  const active: string[] = []
  const available: string[] = []
  const sessionEnabled: string[] = []

  for (const row of rows) {
    const name = row.name
    const state = row.status.status
    const oauthTag = isOAuth(cfg, name) ? " (OAuth)" : ""

    if (state === "connected") {
      if (isProtected(cfg, name)) {
        active.push(`- ${name} (always-on)`)
      } else {
        active.push(`- ${name} (enabled in this location)`)
        sessionEnabled.push(name)
      }
    } else if (state === "needs_auth") {
      available.push(`- ${name}${oauthTag}: needs auth (open /mcps, select the server, and sign in)`)
    } else if (state === "failed") {
      available.push(`- ${name}${oauthTag}: currently unavailable`)
    } else if (state === "pending") {
      available.push(`- ${name}${oauthTag}: connecting`)
    } else {
      available.push(`- ${name}${oauthTag}`)
    }
  }

  // Concrete, per-turn cleanup nudge: naming the exact servers the model left
  // on is a far stronger signal than generic advice, and it costs nothing when
  // nothing is enabled.
  const cleanup = sessionEnabled.length
    ? "\n\nYou currently have these enabled (each one's tool schemas are spending context every turn): " +
      `${sessionEnabled.join(", ")}. As soon as you no longer need a server, disable it with ` +
      `mcp_disable({"servers":["${sessionEnabled[0]}"]}). State is shared by sessions in this location.`
    : ""

  return [
    "## MCP servers",
    "Each server's tools load only while it is Active, and every Active server's tool schemas cost context on " +
      "every turn. Enable a server with mcp_enable right before you need it; disable it with mcp_disable the " +
      "moment you are done. Connection state alone does not establish tool readiness. Check mcp_enable's " +
      "result and use registered tools without waiting for another user message." +
      cleanup,
    "",
    "Active:",
    active.length ? active.join("\n") : "- (none)",
    "",
    "Available (enable on demand):",
    available.length ? available.join("\n") : "- (none)",
  ].join("\n")
}
