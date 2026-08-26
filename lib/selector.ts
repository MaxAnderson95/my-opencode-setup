export interface CatalogModel {
  readonly id: string
  readonly providerID: string
  readonly variants: readonly { readonly id: string }[]
}

export interface ModelRef {
  readonly id: string
  readonly providerID: string
  readonly variant?: string
}

export type ModelSelection =
  | { readonly ok: true; readonly ref: ModelRef; readonly label: string }
  | { readonly ok: false; readonly error: string }

export function resolveModel(input: string, models: readonly CatalogModel[]): ModelSelection {
  const value = input.trim()
  const ref = parseModelRef(value)
  if (!ref) {
    return { ok: false, error: `Invalid model reference "${value}". Use provider/model or provider/model#variant.` }
  }

  const model = models.find((candidate) => candidate.providerID === ref.providerID && candidate.id === ref.id)
  if (!model) {
    const providers = [...new Set(models.map((candidate) => candidate.providerID))].sort()
    const providerExists = providers.includes(ref.providerID)
    return {
      ok: false,
      error: providerExists
        ? `Provider "${ref.providerID}" has no available model "${ref.id}".`
        : `Unknown provider "${ref.providerID}". Available providers: ${providers.join(", ") || "none"}.`,
    }
  }

  if (ref.variant && !model.variants.some((variant) => variant.id === ref.variant)) {
    const variants = model.variants.map((variant) => variant.id)
    return {
      ok: false,
      error: variants.length
        ? `Model "${ref.providerID}/${ref.id}" has no variant "${ref.variant}". Available variants: ${variants.join(", ")}.`
        : `Model "${ref.providerID}/${ref.id}" exposes no variants. Omit "#${ref.variant}".`,
    }
  }

  return {
    ok: true,
    ref,
    label: `${ref.providerID}/${ref.id}${ref.variant ? `#${ref.variant}` : ""}`,
  }
}

function parseModelRef(input: string): ModelRef | undefined {
  const providerEnd = input.indexOf("/")
  if (providerEnd <= 0) return
  const providerID = input.slice(0, providerEnd)
  const variantStart = input.indexOf("#", providerEnd + 1)
  const id = input.slice(providerEnd + 1, variantStart === -1 ? undefined : variantStart)
  const variant = variantStart === -1 ? undefined : input.slice(variantStart + 1)
  if (!id || providerID.includes("#") || (variant !== undefined && (!variant || variant.includes("#")))) return
  return { providerID, id, ...(variant ? { variant } : {}) }
}

export async function derivedAgentID(baseAgent: string, model: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${baseAgent}\0${model}`)
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
  const suffix = Array.from(digest.slice(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("")
  return `${baseAgent}--model-${suffix}`
}

export async function singleFlight(
  readiness: Map<string, Promise<void>>,
  key: string,
  initialize: () => Promise<void>,
): Promise<void> {
  let pending = readiness.get(key)
  if (!pending) {
    pending = initialize()
    readiness.set(key, pending)
  }
  try {
    await pending
  } catch (error) {
    if (readiness.get(key) === pending) readiness.delete(key)
    throw error
  }
}

interface ToolDefinition {
  description: string
  input: unknown
}

const MODEL_DESCRIPTION =
  "Override the subagent model for this invocation using provider/model or provider/model#variant. " +
  "Omit this field to use the subagent's configured model or inherit the parent model. " +
  "Pass it again when continuing a sessionID to retain the override."

export function advertiseModelParameter(tool: ToolDefinition): boolean {
  if (!isRecord(tool.input) || tool.input.type !== "object" || !isRecord(tool.input.properties)) return false
  tool.input.properties.model = { type: "string", description: MODEL_DESCRIPTION }
  if (!tool.description.includes(MODEL_DESCRIPTION)) tool.description += `\n${MODEL_DESCRIPTION}`
  return true
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
