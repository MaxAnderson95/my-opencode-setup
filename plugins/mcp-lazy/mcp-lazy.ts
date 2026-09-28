import { Plugin } from "@opencode/plugin"
import { isProtected, renderBlock, unknownMsg, type McpServerConfig } from "./lib/inventory"

const serversInputSchema = {
  type: "object",
  properties: {
    servers: { type: "array", items: { type: "string" }, description: "MCP server names" },
  },
  required: ["servers"],
  additionalProperties: false,
} as const

export default Plugin.define({
  id: "mcp-lazy",
  async setup(ctx) {
    // Each plugin instance belongs to one Location. Session moves select the
    // destination's instance, including its configuration and toggle state.
    const enabled = new Map<string, boolean>()
    let config: Record<string, McpServerConfig> = {}
    await ctx.mcp.transform((editor) => {
      config = Object.fromEntries(editor.list().map(([name, server]) => [name, { ...server }]))
      for (const [name, active] of enabled) {
        if (!isProtected(config, name)) editor.update(name, (server) => { server.disabled = !active })
      }
    })

    let registered: readonly string[] = []
    const listeners = new Set<() => void>()
    const namespace = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "_")
    const toolsFor = (name: string) => registered.filter((entry) => entry === namespace(name)).length
    async function waitForTools(name: string, active: boolean): Promise<boolean> {
      const ready = () => active ? toolsFor(name) > 0 : toolsFor(name) === 0
      if (ready()) return true
      // MCP connection and tool registration are separate operations in core.
      // Observe registry rebuilds rather than assuming connected means ready.
      return new Promise((resolve) => {
        const finish = (result: boolean) => {
          clearTimeout(timer)
          listeners.delete(check)
          resolve(result)
        }
        const check = () => { if (ready()) finish(true) }
        const timer = setTimeout(() => finish(false), 3_000)
        listeners.add(check)
      })
    }

    await ctx.session.hook("context", async (event) => {
      try {
        const { data } = await ctx.mcp.list()
        if (!data.length) return
        const block = renderBlock(data, config)
        const last = event.system[event.system.length - 1]
        if (last) event.system[event.system.length - 1] = { ...last, text: `${last.text}\n\n${block}` }
        else event.system.push({ type: "text", text: block })
      } catch {
        // An unavailable inventory must not prevent a model request.
      }
    })

    await ctx.tool.transform((tools) => {
      registered = tools.list().flatMap((tool) => tool.options?.namespace ? [tool.options.namespace] : [])
      for (const listener of listeners) listener()

      for (const active of [true, false]) {
        tools.add({
          name: active ? "mcp_enable" : "mcp_disable",
          options: { codemode: false },
          description: active
            ? "Enable MCP servers in this location. Check the result for tool readiness, then continue using available tools without waiting for another user message."
            : "Disable MCP servers in this location when finished. Always-on servers cannot be disabled. Other sessions in the same location share this state.",
          input: serversInputSchema,
          async execute(input) {
            const { servers } = input as { servers: string[] }
            const results: string[] = []
            for (const name of servers) {
              try {
                const { data } = await ctx.mcp.list()
                if (!data.some((row) => row.name === name)) {
                  results.push(unknownMsg(data.map((row) => row.name), name))
                  continue
                }
                if (!active && isProtected(config, name)) {
                  results.push(`- ${name}: always-on, cannot be disabled`)
                  continue
                }
                enabled.set(name, active)
                await ctx.mcp.reload()
                const after = (await ctx.mcp.list()).data.find((row) => row.name === name)?.status.status
                if (after === "needs_auth") {
                  results.push(`- ${name}: needs authentication; open /mcps, select the server, and sign in`)
                } else if (active && after === "connected") {
                  const ready = await waitForTools(name, true)
                  results.push(ready
                    ? `- ${name}: enabled; ${toolsFor(name)} registered tools. Continue using its tools now.`
                    : `- ${name}: connected, but no tools observed in the registry within 3 seconds. Tool readiness is unverified; the server may expose no tools.`)
                } else if (!active && after === "disabled") {
                  const ready = await waitForTools(name, false)
                  results.push(ready ? `- ${name}: disabled; tools removed from the registry`
                    : `- ${name}: disconnected, but tools remain in the registry after 3 seconds`)
                } else results.push(`- ${name}: requested ${active ? "enable" : "disable"}; status: ${after ?? "unknown"}`)
              } catch (error) {
                results.push(`- ${name}: ${active ? "enable" : "disable"} error: ${error instanceof Error ? error.message : String(error)}`)
              }
            }
            return { content: results.join("\n") }
          },
        })
      }
    })
  },
})
