/**
 * subagent-model — spawn a subagent with an explicitly chosen model AND provider.
 *
 * The built-in `task` tool gives the calling model no way to choose the
 * subagent's model: task.ts resolves it as `subagent.model ?? parentModel`, and
 * the tool schema exposes only `subagent_type`. This plugin adds a
 * `task_with_model` tool that lets the model spawn a subagent on ANY configured
 * provider+model pair.
 *
 * BOTH providerID and modelID are required on purpose: the same underlying model
 * is frequently served by several providers (e.g. a Claude model via `anthropic`
 * vs `amazon-bedrock` vs `google-vertex-anthropic`), each billed differently, so
 * "the model" alone is ambiguous. `list_subagent_models` lets the caller discover
 * valid pairs and compare per-provider pricing before choosing.
 *
 * Implementation (strictly a v1 plugin, SDK-driven — no core changes):
 *   1. Validate providerID/modelID against client.config.providers() and the
 *      agent name against client.app.agents().
 *   2. Create a child session (parentID = current session).
 *   3. client.session.prompt(childID, { agent, model: { providerID, modelID },
 *      parts }) — the prompt endpoint honors a per-call model override.
 *   4. Return the subagent's final assistant text.
 *
 * Verified against the opencode SDK: session.create body { parentID, title };
 * session.prompt body { agent, model: { providerID, modelID }, parts };
 * session.abort; /config/providers; /agent. Model cost is USD per 1,000,000
 * tokens (see Session.getUsage: tokens * cost / 1_000_000).
 */

import { tool, type Plugin } from "@opencode-ai/plugin"

type CatalogModel = {
  id: string
  name?: string
  cost?: { input?: number; output?: number; cache?: { read?: number; write?: number } }
  limit?: { context?: number; output?: number }
  status?: string
}
type CatalogProvider = { id: string; name?: string; models: Record<string, CatalogModel> }
type AgentInfo = { name: string; mode: "subagent" | "primary" | "all"; description?: string }

const DEFAULT_AGENT = "general"
const MAX_LIST_ROWS = 200

function fmtErr(error: unknown): string {
  if (!error) return "unknown error"
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  try {
    const data = (error as { data?: unknown }).data ?? error
    return typeof data === "string" ? data : JSON.stringify(data)
  } catch {
    return String(error)
  }
}

function fmtNum(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "?"
  // Trim trailing zeros without forcing scientific notation.
  return Number(n.toFixed(6)).toString()
}

function fmtContext(n: number | undefined): string {
  if (!n || !Number.isFinite(n)) return "?"
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1))}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

function fmtCost(m: CatalogModel): string {
  const c = m.cost
  if (!c || (c.input === undefined && c.output === undefined)) return "cost n/a"
  return `$${fmtNum(c.input)}/1M in, $${fmtNum(c.output)}/1M out`
}

function modelLine(providerID: string, m: CatalogModel): string {
  const name = m.name && m.name !== m.id ? ` (${m.name})` : ""
  const status = m.status && m.status !== "active" ? ` [${m.status}]` : ""
  return `${providerID}/${m.id}${name} — ${fmtCost(m)} — ctx ${fmtContext(m.limit?.context)}${status}`
}

export const SubagentModelPlugin: Plugin = async ({ client, directory }) => {
  const query = { directory }

  // Fetched fresh (not cached) so newly authenticated providers / added agents
  // are always reflected. These are cheap local server calls.
  async function getProviders(): Promise<CatalogProvider[]> {
    try {
      const res = await client.config.providers({ query })
      return (res.data?.providers as CatalogProvider[] | undefined) ?? []
    } catch {
      return []
    }
  }

  async function getAgents(): Promise<AgentInfo[]> {
    try {
      const res = await client.app.agents({ query })
      return (res.data as AgentInfo[] | undefined) ?? []
    } catch {
      return []
    }
  }

  function providerNotFound(providerID: string, providers: CatalogProvider[]): string {
    const ids = providers.map((p) => p.id)
    return (
      `Unknown provider "${providerID}". ` +
      (ids.length
        ? `Configured providers: ${ids.join(", ")}. Call list_subagent_models to see provider/model pairs and pricing.`
        : "No providers are configured/authenticated.")
    )
  }

  function modelNotFound(providerID: string, modelID: string, provider: CatalogProvider, all: CatalogProvider[]): string {
    const own = Object.values(provider.models)
    // Surface the SAME model id on OTHER providers so the caller can pick a valid
    // (and possibly cheaper) provider for the model they asked for.
    const elsewhere: string[] = []
    for (const p of all) {
      if (p.id === providerID) continue
      const hit = p.models[modelID] ?? Object.values(p.models).find((m) => m.id.includes(modelID))
      if (hit) elsewhere.push(modelLine(p.id, hit))
    }
    const lines: string[] = [`Provider "${providerID}" has no model "${modelID}".`]
    if (elsewhere.length) {
      lines.push("", `"${modelID}" IS available on other providers (billed differently):`, ...elsewhere)
    }
    const sample = own.slice(0, 40).map((m) => modelLine(providerID, m))
    if (sample.length) {
      lines.push(
        "",
        `Models on "${providerID}"${own.length > sample.length ? ` (first ${sample.length} of ${own.length})` : ""}:`,
        ...sample,
      )
    }
    lines.push("", "Call list_subagent_models for the full catalog with pricing.")
    return lines.join("\n")
  }

  function agentNotFound(agentName: string, agents: AgentInfo[]): string {
    const usable = agents.filter((a) => a.mode !== "primary").map((a) => a.name)
    return (
      `Unknown agent "${agentName}". ` +
      (usable.length ? `Available subagents: ${usable.join(", ")}.` : "No subagents are available.")
    )
  }

  return {
    tool: {
      task_with_model: tool({
        description:
          "Spawn a subagent to perform a task using a SPECIFIC model on a SPECIFIC provider. " +
          "Unlike the built-in `task` tool (which forces the subagent's configured model or your own), " +
          "this lets you choose the exact provider+model to run the subagent on. " +
          "You MUST pass both providerID and modelID: the same model is often offered by multiple " +
          "providers at different prices, so the model name alone is ambiguous. " +
          "If you are unsure which provider/model pairs exist or how they are priced, call " +
          "list_subagent_models first. Runs synchronously and returns the subagent's final answer.",
        args: {
          description: tool.schema.string().describe("A short (3-5 word) description of the task"),
          prompt: tool.schema.string().describe("The full task/prompt for the subagent to perform"),
          providerID: tool.schema
            .string()
            .describe("The provider ID to run the subagent's model on, e.g. 'anthropic', 'amazon-bedrock', 'opencode'"),
          modelID: tool.schema
            .string()
            .describe("The model ID as listed under that provider, e.g. 'claude-sonnet-4-20250514'"),
          agent: tool.schema
            .string()
            .optional()
            .describe(`Which subagent type to use (its persona/permissions). Defaults to "${DEFAULT_AGENT}".`),
        },
        async execute(args, ctx) {
          const providerID = args.providerID.trim()
          const modelID = args.modelID.trim()
          const agentName = (args.agent ?? DEFAULT_AGENT).trim()

          const providers = await getProviders()
          const provider = providers.find((p) => p.id === providerID)
          if (!provider) return providerNotFound(providerID, providers)
          const model = provider.models[modelID]
          if (!model) return modelNotFound(providerID, modelID, provider, providers)

          const agents = await getAgents()
          if (agents.length && !agents.some((a) => a.name === agentName)) return agentNotFound(agentName, agents)

          const created = await client.session.create({
            body: { parentID: ctx.sessionID, title: `${args.description} (@${agentName} · ${providerID}/${modelID})` },
            query,
          })
          if (created.error || !created.data) return `Failed to create subagent session: ${fmtErr(created.error)}`
          const childID = created.data.id

          // If the parent tool call is aborted, cancel the child session too.
          const onAbort = () => {
            client.session.abort({ path: { id: childID }, query }).catch(() => {})
          }
          ctx.abort.addEventListener("abort", onAbort)

          try {
            const res = await client.session.prompt({
              path: { id: childID },
              query,
              body: {
                agent: agentName,
                model: { providerID, modelID },
                parts: [{ type: "text", text: args.prompt }],
              },
            })
            if (res.error || !res.data) return `Subagent run failed: ${fmtErr(res.error)}`

            const parts = res.data.parts ?? []
            type PartItem = (typeof parts)[number]
            const lastText = [...parts]
              .reverse()
              .find(
                (p): p is Extract<PartItem, { type: "text" }> =>
                  p.type === "text" && !(p as { synthetic?: boolean }).synthetic,
              )
            const text = lastText?.text ?? ""

            const header = `[subagent @${agentName} on ${providerID}/${modelID} — session ${childID}]`
            return {
              title: `@${agentName} · ${providerID}/${modelID}`,
              output: text ? `${header}\n\n${text}` : `${header}\n\n(no text output)`,
              metadata: { childSessionID: childID, providerID, modelID, agent: agentName },
            }
          } finally {
            ctx.abort.removeEventListener("abort", onAbort)
          }
        },
      }),

      list_subagent_models: tool({
        description:
          "List provider/model pairs available to task_with_model, with per-provider pricing (USD per 1M " +
          "tokens) and context window. Use this to discover valid providerID/modelID values and to compare how " +
          "the SAME model is priced across different providers before spawning a subagent. Optionally filter by a " +
          "substring matched against provider id, model id, or model name.",
        args: {
          filter: tool.schema
            .string()
            .optional()
            .describe("Case-insensitive substring to match against provider id / model id / model name (optional)"),
        },
        async execute(args) {
          const providers = await getProviders()
          if (!providers.length) return "No providers are configured/authenticated."

          const needle = args.filter?.trim().toLowerCase()
          type Row = { providerID: string; model: CatalogModel }
          const rows: Row[] = []
          for (const p of providers) {
            for (const m of Object.values(p.models)) {
              if (
                needle &&
                !p.id.toLowerCase().includes(needle) &&
                !m.id.toLowerCase().includes(needle) &&
                !(m.name ?? "").toLowerCase().includes(needle)
              )
                continue
              rows.push({ providerID: p.id, model: m })
            }
          }
          if (!rows.length) return `No models match "${args.filter}".`

          // Sort by model id, then provider id, so the same model across providers
          // is adjacent — making pricing differences easy to compare.
          rows.sort((a, b) => a.model.id.localeCompare(b.model.id) || a.providerID.localeCompare(b.providerID))

          const shown = rows.slice(0, MAX_LIST_ROWS)
          const lines = shown.map((r) => modelLine(r.providerID, r.model))
          if (rows.length > shown.length) {
            lines.push(`… ${rows.length - shown.length} more not shown — narrow with the filter argument.`)
          }
          const heading = needle
            ? `${rows.length} provider/model pair(s) matching "${args.filter}":`
            : `${rows.length} provider/model pair(s) available:`
          return [heading, "", ...lines].join("\n")
        },
      }),
    },
  }
}
