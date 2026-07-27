/**
 * mcp-lazy — model-controlled MCP server enable/disable
 *
 * Lets the model turn entire MCP servers on/off at runtime so only servers in
 * active use cost tool-schema context.
 *
 *   1. experimental.chat.system.transform injects a per-turn "MCP servers" block
 *      (Active / Available) so the model knows what exists and its live state.
 *   2. mcp_enable / mcp_disable connect/disconnect whole servers. A disconnected
 *      server contributes zero tool schemas; newly enabled tools appear when
 *      the model resumes after the tool call (toolset is rebuilt per request).
 *
 * Shape intentionally mirrors current-session-id.ts (a known-good plugin in this
 * setup): named export only, single import, all client.* calls deferred out of
 * init, and the system block appended to the last existing system entry.
 *
 * Always-on rule: servers with config `enabled !== false` are protected from
 * mcp_disable. Names only; capability context lives in AGENTS.md / skills.
 *
 * Verified against opencode 1.17.11 (SDK/plugin 1.4.10).
 */

import { tool, type Plugin } from "@opencode-ai/plugin"

type McpStatusValue = "connected" | "disabled" | "failed" | "needs_auth" | "needs_client_registration"

type McpConfigEntry = {
  type?: "local" | "remote"
  enabled?: boolean
  oauth?: unknown
}

export const McpLazyPlugin: Plugin = async ({ client, directory }) => {
  const query = { directory }

  // Resolve config lazily on first hook/tool use — never during plugin init.
  let configMapPromise: Promise<Record<string, McpConfigEntry>> | undefined
  function getConfigMap(): Promise<Record<string, McpConfigEntry>> {
    if (!configMapPromise) {
      configMapPromise = (async () => {
        try {
          const cfg = await client.config.get()
          return ((cfg?.data as { mcp?: Record<string, McpConfigEntry> } | undefined)?.mcp ?? {}) as Record<
            string,
            McpConfigEntry
          >
        } catch {
          return {}
        }
      })()
    }
    return configMapPromise
  }

  // `enabled !== false` (true or absent) => connected at startup => always-on/protected.
  const isProtected = (cfg: Record<string, McpConfigEntry>, name: string) => !!cfg[name] && cfg[name].enabled !== false
  const isOAuth = (cfg: Record<string, McpConfigEntry>, name: string) =>
    cfg[name]?.type === "remote" && cfg[name]?.oauth !== false

  async function statusMap(): Promise<Record<string, McpStatusValue>> {
    try {
      const res = await client.mcp.status({ query })
      if (!res || (res as { error?: unknown }).error) return {}
      const data = (res.data ?? {}) as Record<string, { status: McpStatusValue }>
      const out: Record<string, McpStatusValue> = {}
      for (const [name, value] of Object.entries(data)) out[name] = value?.status
      return out
    } catch {
      return {}
    }
  }

  function renderBlock(status: Record<string, McpStatusValue>, cfg: Record<string, McpConfigEntry>): string {
    const active: string[] = []
    const available: string[] = []
    // Servers YOU turned on this session (connected but not always-on) — the
    // ones the model is responsible for turning back off.
    const sessionEnabled: string[] = []

    for (const name of Object.keys(cfg)) {
      const state = status[name] ?? "disabled"
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
      } else if (state === "needs_client_registration") {
        available.push(`- ${name}${oauthTag} — needs client registration in config`)
      } else if (state === "failed") {
        available.push(`- ${name}${oauthTag} — currently unavailable`)
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

  const unknownMsg = (cfg: Record<string, McpConfigEntry>, name: string) => {
    const names = Object.keys(cfg)
    return `- ${name}: unknown server (valid: ${names.length ? names.join(", ") : "none configured"})`
  }

  return {
    "experimental.chat.system.transform": async (_input, output) => {
      try {
        const cfg = await getConfigMap()
        if (!Object.keys(cfg).length) return
        const block = renderBlock(await statusMap(), cfg)
        // Append to the last existing system entry rather than pushing a new one
        // (some models reject multiple system messages); matches current-session-id.ts.
        if (output.system.length > 0) {
          output.system[output.system.length - 1] += "\n\n" + block
        } else {
          output.system.push(block)
        }
      } catch {
        /* never break the turn */
      }
    },

    tool: {
      mcp_enable: tool({
        description:
          "Connect entire MCP server(s). After this tool call returns, continue immediately and use the newly " +
          "enabled tools in your next response; do not wait for another user message. Pass multiple names to enable several at once. " +
          "Only servers listed as Available in the MCP servers section can be enabled.",
        args: {
          servers: tool.schema
            .array(tool.schema.string())
            .describe("Server names to enable, e.g. ['atlassian', 'dash0']"),
        },
        async execute({ servers }) {
          const cfg = await getConfigMap()
          const results: string[] = []
          for (const name of servers) {
            if (!cfg[name]) {
              results.push(unknownMsg(cfg, name))
              continue
            }
            const before = await statusMap()
            if (before[name] === "connected") {
              results.push(`- ${name}: already enabled`)
              continue
            }
            try {
              await client.mcp.connect({ path: { name }, query })
            } catch (error) {
              results.push(`- ${name}: connect error — ${error instanceof Error ? error.message : String(error)}`)
              continue
            }
            const after = (await statusMap())[name]
            if (after === "connected")
              results.push(`- ${name}: enabled; continue immediately and use its tools without waiting for another user message`)
            else if (after === "needs_auth")
              results.push(`- ${name}: needs authentication — have the user run: opencode mcp auth ${name}`)
            else if (after === "needs_client_registration")
              results.push(`- ${name}: needs client registration in config`)
            else results.push(`- ${name}: failed to connect (status: ${after ?? "unknown"})`)
          }
          return results.join("\n")
        },
      }),

      mcp_disable: tool({
        description:
          "Disconnect entire MCP server(s) to free their tool-schema context when you are done with them. " +
          "Always-on servers cannot be disabled. Pass multiple names to disable several at once.",
        args: {
          servers: tool.schema
            .array(tool.schema.string())
            .describe("Server names to disable, e.g. ['atlassian', 'dash0']"),
        },
        async execute({ servers }) {
          const cfg = await getConfigMap()
          const results: string[] = []
          for (const name of servers) {
            if (!cfg[name]) {
              results.push(unknownMsg(cfg, name))
              continue
            }
            if (isProtected(cfg, name)) {
              results.push(`- ${name}: always-on, cannot be disabled`)
              continue
            }
            const before = await statusMap()
            if (before[name] === "disabled") {
              results.push(`- ${name}: already disabled`)
              continue
            }
            try {
              await client.mcp.disconnect({ path: { name }, query })
              results.push(`- ${name}: disabled`)
            } catch (error) {
              results.push(`- ${name}: disconnect error — ${error instanceof Error ? error.message : String(error)}`)
            }
          }
          return results.join("\n")
        },
      }),
    },
  }
}
