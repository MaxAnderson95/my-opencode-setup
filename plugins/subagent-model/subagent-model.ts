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
 * Reasoning effort is exposed through the optional `variant` argument. opencode
 * models a provider's reasoning levels as named "variants" — a catalog-declared
 * bag of option overrides per level (e.g. anthropic/claude-opus-5 →
 * low|medium|high|xhigh|max, each mapping to `{ thinking, effort }`; the OpenAI
 * family → minimal|low|medium|high|xhigh mapping to reasoningEffort). The prompt
 * endpoint accepts a per-call `variant`, applied as
 * `mergeOptions(base, model.options, agent.options, model.variants[variant])`.
 *
 * An UNKNOWN variant is silently ignored by the server (the lookup misses and the
 * run proceeds at the model's default effort, verified empirically), which would
 * quietly hand back a cheaper/weaker run than asked for. So the variant is
 * validated against the model's own `variants` map here and rejected loudly.
 * That validation also makes this arg self-guarding on older servers whose
 * catalog has no variants at all: nothing is ever sent that they'd reject.
 *
 * Implementation (strictly a v1 plugin, SDK-driven — no core changes):
 *   1. Validate providerID/modelID (and the variant, if given) against
 *      client.config.providers(), and the agent name against client.app.agents().
 *   2. Create a child session (parentID = current session).
 *   3. Bridge child permission requests through the parent tool context.
 *   4. client.session.prompt(childID, { agent, model: { providerID, modelID },
 *      variant, parts }) — the prompt endpoint honors both per-call overrides.
 *   5. Return the subagent's final assistant text.
 *
 * Verified against the opencode SDK: session.create body { parentID, title };
 * session.prompt body { agent, model: { providerID, modelID }, variant, parts };
 * session.abort; /config/providers; /agent. Model cost is USD per 1,000,000
 * tokens (see Session.getUsage: tokens * cost / 1_000_000).
 */

import { tool, type Plugin, type ToolContext } from "@opencode-ai/plugin"

type CatalogModel = {
  id: string
  name?: string
  cost?: { input?: number; output?: number; cache?: { read?: number; write?: number } }
  limit?: { context?: number; output?: number }
  status?: string
  capabilities?: { reasoning?: boolean }
  /** Named reasoning-effort levels; each value is a bag of option overrides. */
  variants?: Record<string, Record<string, unknown>>
}
type CatalogProvider = { id: string; name?: string; models: Record<string, CatalogModel> }
type AgentInfo = { name: string; mode: "subagent" | "primary" | "all"; description?: string }

const DEFAULT_AGENT = "general"
const MAX_LIST_ROWS = 200
/** Sentinel the core itself uses for "no variant override" (see SessionPrompt.currentModel). */
const DEFAULT_VARIANT = "default"

interface PermissionAskedEvent {
  type: "permission.asked"
  properties: {
    id: string
    sessionID: string
    permission: string
    patterns: string[]
    metadata: Record<string, unknown>
    always: string[]
  }
}

type PluginClient = Parameters<Plugin>[0]["client"]

function isPermissionAskedEvent(event: unknown): event is PermissionAskedEvent {
  if (!event || typeof event !== "object") return false
  const candidate = event as Partial<PermissionAskedEvent>
  return candidate.type === "permission.asked" && typeof candidate.properties?.id === "string"
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError")
}

export async function runWithPermissionBridge<T>(input: {
  client: PluginClient
  context: ToolContext
  childSessionID: string
  subscribe: (listener: (event: unknown) => void) => () => void
  run: () => Promise<T>
}): Promise<T> {
  const { client, context, childSessionID, run, subscribe } = input
  let pendingRequestID: string | undefined
  let cancelled = false
  let cancellation: Promise<void> | undefined
  let rejectAbort!: (reason: unknown) => void
  const abortFailure = new Promise<never>((_, reject) => {
    rejectAbort = reject
  })

  const reply = async (requestID: string, response: "once" | "reject") => {
    await client.postSessionIdPermissionsPermissionId({
      path: { id: childSessionID, permissionID: requestID },
      query: { directory: context.directory },
      body: { response },
    })
  }

  const cancel = () => {
    cancelled = true
    cancellation ??= (async () => {
      const requestID = pendingRequestID
      pendingRequestID = undefined
      try {
        if (requestID) await reply(requestID, "reject")
      } finally {
        await client.session.abort({
          path: { id: childSessionID },
          query: { directory: context.directory },
        })
      }
    })()
    return cancellation
  }

  const onAbort = () => {
    rejectAbort(abortReason(context.abort))
    void cancel().catch(() => {})
  }
  context.abort.addEventListener("abort", onAbort, { once: true })

  try {
    if (context.abort.aborted) {
      await cancel()
      throw abortReason(context.abort)
    }

    let rejectListener!: (reason: unknown) => void
    const listenerFailure = new Promise<never>((_, reject) => {
      rejectListener = reject
    })
    let eventChain = Promise.resolve()
    const unsubscribe = subscribe((event) => {
      eventChain = eventChain
        .then(async () => {
          if (!isPermissionAskedEvent(event)) return
          const permission = event.properties
          if (permission.sessionID !== childSessionID) return

          if (cancelled) {
            await reply(permission.id, "reject")
            return
          }

          pendingRequestID = permission.id
          await Promise.race([
            context.ask({
              permission: permission.permission,
              patterns: permission.patterns,
              always: permission.always,
              metadata: permission.metadata,
            }),
            abortFailure,
          ])

          if (cancelled) return
          await reply(permission.id, "once")
          pendingRequestID = undefined
        })
        .catch(async (error) => {
          try {
            await cancel()
            rejectListener(error)
          } catch (cancelError) {
            rejectListener(cancelError)
          }
        })
    })

    try {
      return await Promise.race([run(), listenerFailure, abortFailure])
    } finally {
      unsubscribe()
      await eventChain
      if (cancellation) await cancellation
    }
  } finally {
    context.abort.removeEventListener("abort", onAbort)
  }
}

function fmtErr(error: unknown): string {
  if (!error) return "unknown error"
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  try {
    const data = (error as { data?: unknown }).data ?? error
    if (typeof data === "string") return data
    const message = (data as { message?: unknown }).message
    if (typeof message === "string" && message) return message
    return JSON.stringify(data)
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

/**
 * Catalog insertion order is preserved on purpose: providers declare variants in
 * ascending effort (low → max), which is more useful than alphabetising them.
 */
function variantNames(m: CatalogModel): string[] {
  return Object.keys(m.variants ?? {})
}

function fmtVariants(m: CatalogModel): string {
  const names = variantNames(m)
  return names.length ? ` — variants: ${names.join(", ")}` : ""
}

function modelLine(providerID: string, m: CatalogModel): string {
  const name = m.name && m.name !== m.id ? ` (${m.name})` : ""
  const status = m.status && m.status !== "active" ? ` [${m.status}]` : ""
  return `${providerID}/${m.id}${name} — ${fmtCost(m)} — ctx ${fmtContext(m.limit?.context)}${fmtVariants(m)}${status}`
}

export const SubagentModelPlugin: Plugin = async ({ client, directory }) => {
  const query = { directory }
  const permissionListeners = new Map<string, Set<(event: unknown) => void>>()

  function subscribeToChildPermissions(childSessionID: string, listener: (event: unknown) => void) {
    const listeners = permissionListeners.get(childSessionID) ?? new Set()
    listeners.add(listener)
    permissionListeners.set(childSessionID, listeners)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) permissionListeners.delete(childSessionID)
    }
  }

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

  function variantNotFound(providerID: string, model: CatalogModel, variant: string): string {
    const names = variantNames(model)
    const pair = `${providerID}/${model.id}`
    if (!names.length) {
      return (
        `Model "${pair}" exposes no reasoning variants, so its reasoning effort cannot be set` +
        `${model.capabilities?.reasoning === false ? " (it is not a reasoning model)" : ""}. ` +
        `Omit the variant argument, or pick a model whose list_subagent_models entry shows "variants:".`
      )
    }
    return (
      `Model "${pair}" has no variant "${variant}". ` +
      `Available variants (provider-specific reasoning efforts, usually ascending): ${names.join(", ")}. ` +
      `Omit variant (or pass "${DEFAULT_VARIANT}") to run at the model's default reasoning effort.`
    )
  }

  function agentNotFound(agentName: string, agents: AgentInfo[]): string {
    const usable = agents.filter((a) => a.mode !== "primary").map((a) => a.name)
    return (
      `Unknown agent "${agentName}". ` +
      (usable.length ? `Available subagents: ${usable.join(", ")}.` : "No subagents are available.")
    )
  }

  return {
    async event({ event }) {
      const candidate: unknown = event
      if (!isPermissionAskedEvent(candidate)) return
      for (const listener of permissionListeners.get(candidate.properties.sessionID) ?? []) listener(candidate)
    },
    tool: {
      task_with_model: tool({
        description:
          "Spawn a subagent to perform a task using a SPECIFIC model on a SPECIFIC provider. " +
          "Unlike the built-in `task` tool (which forces the subagent's configured model or your own), " +
          "this lets you choose the exact provider+model to run the subagent on. " +
          "You MUST pass both providerID and modelID: the same model is often offered by multiple " +
          "providers at different prices, so the model name alone is ambiguous. " +
          "Optionally set `variant` to control the subagent's reasoning effort (e.g. 'low', 'high', 'max'). " +
          "If you are unsure which provider/model pairs exist, how they are priced, or which variants they " +
          "support, call list_subagent_models first. Runs synchronously and returns the subagent's final answer.",
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
          variant: tool.schema
            .string()
            .optional()
            .describe(
              "Reasoning effort for the subagent, as a model variant name. Provider-specific, commonly " +
                "'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'none', or 'thinking'. Must be one of the " +
                "variants listed for that provider/model by list_subagent_models; an unsupported value is " +
                `rejected. Omit (or pass "${DEFAULT_VARIANT}") to use the model's default reasoning effort.`,
            ),
        },
        async execute(args, ctx) {
          const providerID = args.providerID.trim()
          const modelID = args.modelID.trim()
          const agentName = (args.agent ?? DEFAULT_AGENT).trim()
          const requestedVariant = args.variant?.trim()

          const providers = await getProviders()
          const provider = providers.find((p) => p.id === providerID)
          if (!provider) return providerNotFound(providerID, providers)
          const model = provider.models[modelID]
          if (!model) return modelNotFound(providerID, modelID, provider, providers)

          // Resolve to the catalog's own casing so a "HIGH" still hits variants["high"].
          let variant: string | undefined
          if (requestedVariant && requestedVariant.toLowerCase() !== DEFAULT_VARIANT) {
            variant = variantNames(model).find((v) => v.toLowerCase() === requestedVariant.toLowerCase())
            if (!variant) return variantNotFound(providerID, model, requestedVariant)
          }

          const agents = await getAgents()
          if (agents.length && !agents.some((a) => a.name === agentName)) return agentNotFound(agentName, agents)

          const label = `${providerID}/${modelID}${variant ? `:${variant}` : ""}`
          const created = await client.session.create({
            body: { parentID: ctx.sessionID, title: `${args.description} (@${agentName} · ${label})` },
            query,
          })
          if (created.error || !created.data) return `Failed to create subagent session: ${fmtErr(created.error)}`
          const childID = created.data.id
          ctx.metadata({ metadata: { childSessionID: childID } })

          type PromptBody = NonNullable<Parameters<typeof client.session.prompt>[0]["body"]>
          // The generated SDK types (through 1.18.5) omit `variant` from the prompt
          // body even though the server's own schema accepts it (see the server's
          // GET /doc, POST /session/{sessionID}/message), hence the cast.
          const body: PromptBody & { variant?: string } = {
            agent: agentName,
            model: { providerID, modelID },
            ...(variant ? { variant } : {}),
            parts: [{ type: "text", text: args.prompt }],
          }
          const res = await runWithPermissionBridge({
            client,
            context: ctx,
            childSessionID: childID,
            subscribe: (listener) => subscribeToChildPermissions(childID, listener),
            run: () =>
              client.session.prompt({
                path: { id: childID },
                query,
                body: body as PromptBody,
                signal: ctx.abort,
              }),
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

          const header = `[subagent @${agentName} on ${label} — session ${childID}]`
          // A failed run (bad credentials, provider rejection, aborted) comes back
          // 200 with no text and the reason parked on the message, so surface it
          // instead of an unhelpful "(no text output)".
          const runError = res.data.info?.error
          const fallback = runError ? `run failed: ${fmtErr(runError)}` : "(no text output)"
          return {
            title: `@${agentName} · ${label}`,
            output: `${header}\n\n${text || fallback}`,
            metadata: { childSessionID: childID, providerID, modelID, variant, agent: agentName },
          }
        },
      }),

      list_subagent_models: tool({
        description:
          "List provider/model pairs available to task_with_model, with per-provider pricing (USD per 1M " +
          "tokens), context window, and the reasoning-effort variants each pair accepts for task_with_model's " +
          "`variant` argument. Use this to discover valid providerID/modelID values and to compare how " +
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
