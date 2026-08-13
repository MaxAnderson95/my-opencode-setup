/**
 * Pure inventory logic: which servers are protected, how the per-turn system
 * block renders, and the unknown-server message. Kept side-effect free so it
 * is directly testable; the entry wires it to live server state.
 *
 * Text is preserved verbatim from the v1 plugin — AGENTS.md documents this
 * exact block and the tool result phrasing, so wording is a compatibility
 * surface, not prose.
 */

import type { McpServerConfig, McpServerRow } from "./server"

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
  // Servers YOU turned on this session (connected but not always-on) — the
  // ones the model is responsible for turning back off.
  const sessionEnabled: string[] = []

  for (const row of rows) {
    const name = row.name
    const state = row.status.status
    const oauthTag = isOAuth(cfg, name) ? " (OAuth)" : ""

    if (state === "connected") {
      if (isProtected(cfg, name)) {
        active.push(`- ${name} (always-on)`)
      } else {
        active.push(`- ${name} (enabled this session)`)
        sessionEnabled.push(name)
      }
    } else if (state === "needs_auth") {
      available.push(`- ${name}${oauthTag} — needs auth (have the user run: opencode mcp auth ${name})`)
    } else if (state === "failed") {
      available.push(`- ${name}${oauthTag} — currently unavailable`)
    } else if (state === "pending") {
      available.push(`- ${name}${oauthTag} — connecting`)
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
      `mcp_disable(["${sessionEnabled[0]}"]). Do not leave servers enabled \u201Cjust in case\u201D — re-enabling is cheap.`
    : ""

  return [
    "## MCP servers",
    "Each server's tools load only while it is Active, and every Active server's tool schemas cost context on " +
      "every turn. Enable a server with mcp_enable right before you need it; disable it with mcp_disable the " +
      "moment you are done. After mcp_enable returns, continue immediately: the newly enabled tools will be " +
      "available when you respond again. Do not wait for the user to send another message." +
      cleanup,
    "",
    "Active:",
    active.length ? active.join("\n") : "- (none)",
    "",
    "Available (enable on demand):",
    available.length ? available.join("\n") : "- (none)",
  ].join("\n")
}
