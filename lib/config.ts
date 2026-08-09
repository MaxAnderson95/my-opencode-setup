/**
 * Runtime configuration. Everything that used to be a module constant and had a
 * reason to differ per machine now lives here, resolvable from a JSON file or
 * the environment. Defaults reproduce the original hardcoded behaviour.
 */
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

export type SummaryModel = { providerID: string; modelID: string; variant?: string }

export type Config = {
  dataDir: string
  sourceDb: string
  index: {
    /** Absolute or ~/ paths whose sessions must not be retained by recall. */
    excludeDirectories: string[]
  }
  embed: {
    model: string
    dims: number
    /** bge-family models want this prefix on retrieval queries, not on documents. */
    queryPrefix: string
    batch: number
    idleMs: number
  }
  chunk: {
    /** Target characters per embedded chunk. bge-small truncates near 512 tokens (~2k chars). */
    chars: number
    /** Overlap between consecutive chunks so a fact spanning a boundary is still recoverable. */
    overlap: number
    /** Hard ceiling on embedded characters per turn; beyond this a turn is sampled head+tail. */
    maxPerTurn: number
  }
  fts: {
    /** Tool output is truncated at this many characters before segmentation. */
    toolOutputChars: number
    /** Text and reasoning parts are split into segments of at most this size (never truncated). */
    segmentChars: number
  }
  search: {
    candidates: number
    rrfK: number
    /** Cosine floor for semantic hits inside a single session (see search.ts). */
    inspectSemMin: number
  }
  summary: {
    enabled: boolean
    model: SummaryModel
    agent: string
    charBudget: number
    msgChars: number
    timeoutMs: number
    concurrency: number
    batchMax: number
  }
  backfill: {
    delayMs: number
    /** A backfill lease older than this is considered abandoned and may be stolen. */
    leaseMs: number
  }
  notify: {
    enabled: boolean
    /** Backfill runs smaller than this say nothing at all. */
    announceMin: number
    /** Runs at least this large also report progress at 25/50/75%. */
    progressMin: number
  }
}

function defaults(): Config {
  return {
    dataDir: path.join(os.homedir(), ".local", "share", "opencode-recall"),
    sourceDb: path.join(os.homedir(), ".local", "share", "opencode", "opencode.db"),
    index: { excludeDirectories: [] },
    embed: {
      model: "Xenova/bge-small-en-v1.5",
      dims: 384,
      queryPrefix: "Represent this sentence for searching relevant passages: ",
      batch: 8,
      idleMs: 10 * 60 * 1000,
    },
    chunk: { chars: 1200, overlap: 200, maxPerTurn: 60_000 },
    fts: { toolOutputChars: 16_000, segmentChars: 8_000 },
    search: { candidates: 60, rrfK: 60, inspectSemMin: 0.55 },
    summary: {
      enabled: true,
      model: { providerID: "openai", modelID: "gpt-5.6-luna", variant: "low" },
      agent: "recall-summarizer",
      charBudget: 300_000,
      msgChars: 2_000,
      timeoutMs: 180_000,
      concurrency: 4,
      batchMax: 24,
    },
    backfill: { delayMs: 20_000, leaseMs: 90_000 },
    notify: { enabled: true, announceMin: 25, progressMin: 200 },
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** Deep merge that only accepts keys already present in the defaults. */
function merge<T>(base: T, patch: unknown): T {
  if (!isObject(patch)) return base
  const out: any = Array.isArray(base) ? base : { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in (out as object))) continue
    out[k] = isObject(out[k]) && isObject(v) ? merge(out[k], v) : v
  }
  return out
}

/** "provider/model" or "provider/model/variant"; a model id may itself contain slashes. */
export function parseModelSpec(spec: string): SummaryModel | null {
  const parts = spec.split("/").filter(Boolean)
  if (parts.length < 2) return null
  const [providerID, ...rest] = parts
  const variantish = rest.length > 1 ? rest[rest.length - 1] : ""
  const known = ["minimal", "none", "low", "medium", "high", "xhigh", "max", "thinking", "default"]
  if (rest.length > 1 && known.includes(variantish))
    return { providerID, modelID: rest.slice(0, -1).join("/"), variant: variantish }
  return { providerID, modelID: rest.join("/") }
}

export type ConfigLoad = { config: Config; source: string; file: string; warnings: string[] }

/**
 * Precedence: defaults < recall.json < environment.
 * `env` and `readFile` are injected so this is testable without touching disk.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  readFile: (p: string) => string | null = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null),
  home: string = os.homedir(),
): ConfigLoad {
  let config = defaults()
  const warnings: string[] = []
  let source = "defaults"

  const file = env.RECALL_CONFIG || path.join(home, ".config", "opencode", "recall.json")
  const raw = readFile(file)
  if (raw !== null) {
    try {
      // Tolerate // comments and trailing commas so the file can live next to opencode.jsonc.
      const stripped = raw.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1")
      config = merge(config, JSON.parse(stripped))
      source = file
    } catch (e) {
      warnings.push(`ignoring ${file}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (env.RECALL_DATA_DIR) config.dataDir = env.RECALL_DATA_DIR
  if (env.RECALL_SOURCE_DB) config.sourceDb = env.RECALL_SOURCE_DB
  if (env.RECALL_EMBED_MODEL) config.embed.model = env.RECALL_EMBED_MODEL
  if (env.RECALL_EMBED_DIMS) {
    const n = Number(env.RECALL_EMBED_DIMS)
    if (Number.isInteger(n) && n > 0) config.embed.dims = n
    else warnings.push(`ignoring RECALL_EMBED_DIMS=${env.RECALL_EMBED_DIMS} (not a positive integer)`)
  }
  if (env.RECALL_SUMMARY_MODEL) {
    const m = parseModelSpec(env.RECALL_SUMMARY_MODEL)
    if (m) config.summary.model = m
    else warnings.push(`ignoring RECALL_SUMMARY_MODEL=${env.RECALL_SUMMARY_MODEL} (expected provider/model[/variant])`)
  }
  if (env.RECALL_DISABLE_SUMMARIZE === "1") config.summary.enabled = false
  if (env.RECALL_QUIET === "1") config.notify.enabled = false

  if (!Array.isArray(config.index.excludeDirectories)) {
    warnings.push("ignoring index.excludeDirectories (expected an array of paths)")
    config.index.excludeDirectories = []
  } else {
    const invalid = config.index.excludeDirectories.filter((v) => typeof v !== "string" || !v.trim()).length
    if (invalid) warnings.push(`ignoring ${invalid} invalid index.excludeDirectories entries`)
    config.index.excludeDirectories = config.index.excludeDirectories.filter(
      (v): v is string => typeof v === "string" && !!v.trim(),
    )
  }

  if (config.chunk.overlap >= config.chunk.chars) {
    warnings.push(`chunk.overlap (${config.chunk.overlap}) >= chunk.chars (${config.chunk.chars}); clamping`)
    config.chunk.overlap = Math.floor(config.chunk.chars / 4)
  }
  return { config, source, file, warnings }
}

export function modelTag(c: Config): string {
  return `${c.embed.model}:${c.embed.dims}`
}

export function summaryModelTag(c: { summary: { model: SummaryModel } }): string {
  const m = c.summary.model
  return `${m.providerID}/${m.modelID}${m.variant ? `/${m.variant}` : ""}`
}
