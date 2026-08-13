/**
 * mcp-lazy — model-controlled MCP server enable/disable (OpenCode v2 plugin)
 *
 * Lets the model turn entire MCP servers on/off at runtime so only servers in
 * active use cost tool-schema context.
 *
 *   1. ctx.session.hook("context") injects a per-turn "MCP servers" block
 *      (Active / Available) so the model knows what exists and its live state.
 *   2. mcp_enable / mcp_disable connect/disconnect whole servers through the
 *      server's native /api/mcp endpoints (v2 supports runtime MCP
 *      connect/disconnect natively). A disconnected server contributes zero
 *      tool schemas; newly enabled tools appear when the model resumes after
 *      the tool call (the toolset is rebuilt per request).
 *
 * Always-on rule, carried over from v1: servers whose config entry is not
 * `disabled: true` connect at startup and are protected from mcp_disable
 * (v1 spelled this `enabled !== false`; v2 config uses `disabled`).
 *
 * The v2 plugin context has no MCP domain, so lib/server.ts talks to the
 * hosting server's HTTP API via the local-service discovery contract — see
 * that file for the details and the wire-contract citations.
 *
 * Verified against @opencode-ai/plugin 0.0.0-next-17403.
 */

import { Plugin } from "@opencode-ai/plugin"
import { isProtected, renderBlock, unknownMsg } from "./lib/inventory"
import { createServerApi, type McpServerConfig, type McpServerRow } from "./lib/server"

type EnableInput = { servers?: string[] }

const serversInputSchema = {
  type: "object",
  properties: {
    servers: {
      type: "array",
      items: { type: "string" },
      description: "Server names, e.g. ['atlassian', 'dash0']",
    },
  },
  required: ["servers"],
  additionalProperties: false,
} as const

function statusOf(rows: readonly McpServerRow[], name: string): McpServerRow["status"]["status"] | undefined {
  return rows.find((row) => row.name === name)?.status.status
}

export default Plugin.define({
  id: "mcp-lazy",
  setup: async (ctx) => {
    const api = createServerApi()

    // MCP state is location-scoped on the server, so requests carry the
    // session's directory. Sessions never move between directories mid-life,
    // hence the permanent cache.
    const directories = new Map<string, string>()
    async function directoryFor(sessionID: string): Promise<string | undefined> {
      const cached = directories.get(sessionID)
      if (cached) return cached
      try {
        const session = await ctx.session.get({ sessionID })
        directories.set(sessionID, session.location.directory)
        return session.location.directory
      } catch {
        return undefined
      }
    }

    // Config resolves lazily on first use and is then memoized: the always-on
    // set is a startup-time property, matching v1's one-shot config read.
    let configPromise: Promise<Record<string, McpServerConfig>> | undefined
    function getConfig(directory?: string): Promise<Record<string, McpServerConfig>> {
      configPromise ??= api.mcpConfig(directory).catch(() => ({}))
      return configPromise
    }

    await ctx.session.hook("context", async (event) => {
      try {
        const directory = await directoryFor(event.sessionID)
        const rows = await api.mcpList(directory)
        if (!rows.length) return
        const cfg = await getConfig(directory)
        const block = renderBlock(rows, cfg)
        // Append to the last existing system entry rather than pushing a new one
        // (some models reject multiple system messages), matching v1.
        const last = event.system[event.system.length - 1]
        if (last) {
          event.system[event.system.length - 1] = { ...last, text: last.text + "\n\n" + block }
        } else {
          event.system.push({ type: "text", text: block })
        }
      } catch {
        /* never break the turn */
      }
    })

    await ctx.tool.transform((tools) => {
      tools.add({
        name: "mcp_enable",
        // codemode: false keeps the tool on the provider's native tool list;
        // the default would bury it inside the CodeMode `execute` catalog.
        options: { codemode: false },
        description:
          "Connect entire MCP server(s). After this tool call returns, continue immediately and use the newly " +
          "enabled tools in your next response; do not wait for another user message. Pass multiple names to enable several at once. " +
          "Only servers listed as Available in the MCP servers section can be enabled.",
        input: serversInputSchema,
        async execute(input, context) {
          const servers = (input as EnableInput).servers ?? []
          const directory = await directoryFor(context.sessionID)
          const results: string[] = []
          for (const name of servers) {
            const before = await api.mcpList(directory)
            if (!before.some((row) => row.name === name)) {
              results.push(unknownMsg(before.map((row) => row.name), name))
              continue
            }
            if (statusOf(before, name) === "connected") {
              results.push(`- ${name}: already enabled`)
              continue
            }
            try {
              await api.mcpConnect(name, directory)
            } catch (error) {
              results.push(`- ${name}: connect error — ${error instanceof Error ? error.message : String(error)}`)
              continue
            }
            const after = statusOf(await api.mcpList(directory), name)
            if (after === "connected")
              results.push(
                `- ${name}: enabled; continue immediately and use its tools without waiting for another user message`,
              )
            else if (after === "needs_auth")
              results.push(`- ${name}: needs authentication — have the user run: opencode mcp auth ${name}`)
            else results.push(`- ${name}: failed to connect (status: ${after ?? "unknown"})`)
          }
          return { content: results.join("\n") }
        },
      })

      tools.add({
        name: "mcp_disable",
        options: { codemode: false },
        description:
          "Disconnect entire MCP server(s) to free their tool-schema context when you are done with them. " +
          "Always-on servers cannot be disabled. Pass multiple names to disable several at once.",
        input: serversInputSchema,
        async execute(input, context) {
          const servers = (input as EnableInput).servers ?? []
          const directory = await directoryFor(context.sessionID)
          const cfg = await getConfig(directory)
          const results: string[] = []
          for (const name of servers) {
            const before = await api.mcpList(directory)
            if (!before.some((row) => row.name === name)) {
              results.push(unknownMsg(before.map((row) => row.name), name))
              continue
            }
            if (isProtected(cfg, name)) {
              results.push(`- ${name}: always-on, cannot be disabled`)
              continue
            }
            if (statusOf(before, name) === "disabled") {
              results.push(`- ${name}: already disabled`)
              continue
            }
            try {
              await api.mcpDisconnect(name, directory)
              results.push(`- ${name}: disabled`)
            } catch (error) {
              results.push(`- ${name}: disconnect error — ${error instanceof Error ? error.message : String(error)}`)
            }
          }
          return { content: results.join("\n") }
        },
      })
    })
  },
})
