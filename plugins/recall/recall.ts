/**
 * recall — hybrid lexical (FTS5/BM25) + semantic (embedding) search over ALL
 * past OpenCode conversations on this machine.
 *
 * Five agent tools forming an escalation ladder, cheapest rung first:
 *   recall_search    corpus  -> sessions
 *   recall_inspect   session -> locations, or an outline
 *   recall_expand    location -> transcript
 *   recall_summarize session -> digested answer (worker model)
 *   recall_status    index health
 *
 * Architecture lives in lib/: config, text (pure helpers), source (opencode's
 * DB, v2 tables first with a v1 fallback), schema (sidecar DDL + migration),
 * embedder, indexer, search, summarize. This file is wiring and tool surface
 * only, written against the v2 plugin API (Plugin.define + domain transforms).
 */
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { Database } from "bun:sqlite"
import { Agent, Plugin } from "@opencode-ai/plugin"

import { loadConfig, modelTag, type SummaryModel } from "./lib/config.ts"
import { createEmbedder } from "./lib/embedder.ts"
import { DirectoryExclusions } from "./lib/exclusions.ts"
import { Indexer } from "./lib/indexer.ts"
import { logNotifier, noopNotify } from "./lib/notify.ts"
import { BackfillLease, migrate, openIndex } from "./lib/schema.ts"
import { SearchIndex, fuse, type Filters, type Hit } from "./lib/search.ts"
import { Source, type SessionRow } from "./lib/source.ts"
import { Summarizer, WORKER_PREFIX, WORKER_SYSTEM, pool } from "./lib/summarize.ts"
import { clean, fmtDate, fmtDateTime, shortDir } from "./lib/text.ts"

const OWN_TOOLS = new Set([
  "recall_search",
  "recall_expand",
  "recall_inspect",
  "recall_status",
  "recall_summarize",
])

function makeLogger(dataDir: string) {
  const file = path.join(dataDir, "recall.log")
  return (...args: unknown[]) => {
    try {
      const body = args
        .map((a) => (a instanceof Error ? (a.stack ?? String(a)) : typeof a === "string" ? a : JSON.stringify(a)))
        .join(" ")
      if (fs.existsSync(file) && fs.statSync(file).size > 5 * 1024 * 1024) fs.truncateSync(file, 0)
      fs.appendFileSync(file, `${new Date().toISOString()} ${body}\n`)
    } catch {}
  }
}

function parseWhen(s: string | undefined, fallback: number): number {
  if (!s) return fallback
  const ms = Date.parse(s)
  return Number.isNaN(ms) ? fallback : ms
}

function clampInt(v: number | undefined, lo: number, hi: number, dflt: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return dflt
  return Math.max(lo, Math.min(Math.round(v), hi))
}

function fileSize(p: string): number {
  try {
    return fs.statSync(p).size
  } catch {
    return 0
  }
}

// ------------------------------------------------------------------ tool args
//
// Tool inputs are declared as plain JSON Schema (the v2 runtime forwards raw
// JSON Schema to the model without server-side validation), so execute()
// receives `unknown` and reads each argument defensively.

const record = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {}
const optStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)
const optNum = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined)
const optBool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined)
const optStrArray = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined
const searchMode = (v: unknown): "hybrid" | "lexical" | "semantic" =>
  v === "lexical" || v === "semantic" ? v : "hybrid"

/** v1 tools returned a string or {title, output}; map both onto a v2 Result. */
type ToolReturn = string | { title: string; output: string }
const asResult = (r: ToolReturn) =>
  typeof r === "string" ? { content: r } : { content: r.output, metadata: { title: r.title } }

const MODE_SCHEMA = {
  type: "string",
  enum: ["hybrid", "lexical", "semantic"],
  description: "hybrid (default) fuses both; lexical = exact terms only; semantic = meaning only",
} as const

export default Plugin.define({
  id: "recall",

  setup: async (ctx) => {
    const home = os.homedir()
    const { config, source: configSource, file: configFile, warnings } = loadConfig()
    const indexPath = path.join(config.dataDir, "index.db")
    const logPath = path.join(config.dataDir, "recall.log")

    let log: (...args: unknown[]) => void = () => {}
    let srcDb: Database
    let idxDb: Database
    let migration: { reset: boolean; reason: string; reclaimedBytes: number }
    try {
      fs.mkdirSync(config.dataDir, { recursive: true })
      log = makeLogger(config.dataDir)
      for (const w of warnings) log("config warning:", w)
      if (configSource !== "defaults") log(`config loaded from ${configSource}`)
      if (!fs.existsSync(config.sourceDb)) throw new Error(`source db not found: ${config.sourceDb}`)
      srcDb = new Database(config.sourceDb, { readonly: true })
      idxDb = new Database(indexPath, { create: true })
      openIndex(idxDb)
      migration = migrate(idxDb, modelTag(config), () => fileSize(indexPath))
      if (migration.reset)
        log(
          `index reset (${migration.reason}); reclaimed ${(migration.reclaimedBytes / 1024 / 1024).toFixed(1)} MB, full reindex will follow`,
        )
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      log("recall init failed; plugin disabled", e)
      // The plugin must not take opencode down with it, but going completely
      // silent leaves no way to find out why from inside the session. A lone
      // status tool that reports the failure is the compromise.
      await ctx.tool.transform((tools) => {
        tools.add({
          name: "recall_status",
          description:
            "Show the recall conversation-index status. recall is currently DISABLED because it failed to initialise; this reports why.",
          input: { type: "object", properties: {}, additionalProperties: false },
          options: { codemode: false },
          execute: async () => ({
            content: `recall is disabled: ${reason}\n\nThe other recall_* tools are unavailable this session. Diagnostics: ${logPath}`,
            metadata: { title: "recall status: disabled" },
          }),
        })
      })
      return
    }

    const notify = config.notify.enabled ? logNotifier(log) : noopNotify

    if (migration.reset)
      notify({
        message: `Conversation index reset (${migration.reason}); reclaimed ${(migration.reclaimedBytes / 1024 / 1024).toFixed(0)} MB.`,
        variant: "info",
      })

    const source = new Source(srcDb)
    const exclusions = new DirectoryExclusions(config.index.excludeDirectories, home)
    const embedder = createEmbedder({
      model: config.embed.model,
      dims: config.embed.dims,
      batch: config.embed.batch,
      idleMs: config.embed.idleMs,
      cacheDir: config.dataDir,
      log,
      notify,
    })
    const indexer = new Indexer({
      idx: idxDb,
      source,
      embedder,
      config,
      exclusions,
      log,
      skipTools: OWN_TOOLS,
      workerPrefix: WORKER_PREFIX,
      notify,
      afterReset: migration.reset,
    })
    const searcher = new SearchIndex(idxDb, source, embedder, config, log)
    const summarizer = new Summarizer({
      idx: idxDb,
      source,
      config,
      exclusions,
      sessions: ctx.session,
      home,
      log,
    })
    const initiallyExcluded = indexer.reconcileExclusions()
    if (initiallyExcluded) log(`excluded-directory reconciliation removed ${initiallyExcluded} sessions`)

    // The worker agent gives summarize runs a tool-less, minimal-system
    // context; without it, session.generate would carry the default agent's
    // full coding prompt and tool catalog into every summary request.
    if (config.summary.enabled)
      await ctx.agent.transform((draft) => {
        draft.update(config.summary.agent, (agent) => {
          agent.name = Agent.Name.make("Recall Summarizer")
          agent.description = "Internal worker agent used by the recall plugin to summarize past sessions."
          agent.mode = "primary"
          agent.hidden = true
          agent.system = WORKER_SYSTEM
          agent.permissions.push({ action: "*", resource: "*", effect: "deny" })
        })
      })

    async function resolveSummaryModel(args: {
      providerID?: string
      modelID?: string
      variant?: string
    }): Promise<SummaryModel | string> {
      const providerID = args.providerID?.trim() || config.summary.model.providerID
      const modelID = args.modelID?.trim() || config.summary.model.modelID
      const requestedVariant =
        args.variant?.trim() ||
        (providerID === config.summary.model.providerID && modelID === config.summary.model.modelID
          ? config.summary.model.variant
          : undefined)
      let models: { providerID: string; modelID: string; variants: { id: string }[] }[]
      try {
        models = (await ctx.catalog.model.list()).data
      } catch {
        return "Could not load the configured provider/model catalog."
      }
      const providerModels = models.filter((m) => m.providerID === providerID)
      if (!providerModels.length) {
        const providers = [...new Set(models.map((m) => m.providerID))].join(", ")
        return `Unknown provider "${providerID}". Configured providers: ${providers || "none"}.`
      }
      const model = providerModels.find((m) => m.modelID === modelID)
      if (!model)
        return `Provider "${providerID}" has no model "${modelID}". Call list_subagent_models to find valid pairs.`
      let variant: string | undefined
      if (requestedVariant && requestedVariant.toLowerCase() !== "default") {
        variant = model.variants.map((v) => v.id).find((v) => v.toLowerCase() === requestedVariant.toLowerCase())
        if (!variant) {
          const available = model.variants.map((v) => v.id).join(", ")
          return `Model "${providerID}/${modelID}" has no variant "${requestedVariant}". Available variants: ${available || "none"}.`
        }
      }
      return { providerID, modelID, ...(variant ? { variant } : {}) }
    }

    // Fire-and-forget work is tracked so shutdown can drain rather than kill
    // the isolated embedding process under an in-flight request.
    const pending = new Set<Promise<unknown>>()
    const track = (p: Promise<unknown>) => {
      pending.add(p)
      p.catch(() => {}).finally(() => pending.delete(p))
    }

    const runBackfill = () => indexer.backfill(new BackfillLease(idxDb, config.backfill.leaseMs))

    const startTimer = setTimeout(
      () => track(runBackfill()),
      config.backfill.delayMs + Math.floor(Math.random() * 10_000),
    )
    startTimer.unref?.()

    const configSignature = () => {
      try {
        const stat = fs.statSync(configFile)
        return `${stat.mtimeMs}:${stat.size}`
      } catch {
        return "missing"
      }
    }
    let lastConfigSignature = configSignature()
    let lastExclusionConfig = JSON.stringify(config.index.excludeDirectories)
    const configTimer = setInterval(() => {
      const signature = configSignature()
      if (signature === lastConfigSignature) return
      lastConfigSignature = signature
      const loaded = loadConfig()
      const parseFailed = loaded.warnings.some((warning) => warning.startsWith(`ignoring ${configFile}:`))
      const exclusionsInvalid = loaded.warnings.some((warning) =>
        warning.startsWith("ignoring index.excludeDirectories ("),
      )
      if (parseFailed || exclusionsInvalid) {
        for (const warning of loaded.warnings) log("config reload warning:", warning)
        return
      }
      const next = JSON.stringify(loaded.config.index.excludeDirectories)
      if (next === lastExclusionConfig) return
      lastExclusionConfig = next
      config.index.excludeDirectories = loaded.config.index.excludeDirectories
      exclusions.update(config.index.excludeDirectories)
      const purged = indexer.reconcileExclusions()
      log(`exclusion config reloaded: ${exclusions.entries().length} roots, ${purged} sessions excluded`)
      track(
        (async () => {
          while (indexer.state.running) await Bun.sleep(1_000)
          await runBackfill()
        })(),
      )
    }, 5_000)
    configTimer.unref?.()

    // v2 delivers events as one subscribed stream rather than per-plugin hook
    // calls; the loop below is the equivalent of v1's `event` handler.
    const eventIterator = ctx.event.subscribe()[Symbol.asyncIterator]()
    let eventsStopped = false
    void (async () => {
      try {
        while (!eventsStopped) {
          const result = await eventIterator.next()
          if (result.done) break
          const event = result.value
          try {
            if (event.type === "session.idle") {
              const sid = event.data.sessionID
              track(indexer.indexSession(sid).catch((e) => log("idle index error", sid, e)))
            } else if (event.type === "session.deleted") {
              indexer.purge(event.data.sessionID)
            }
          } catch (e) {
            log("event hook error", e)
          }
        }
      } catch (e) {
        if (!eventsStopped) log("event stream error", e)
      }
    })()

    const counts = () => {
      const sourceSessions = source.allSessions()
      return {
        chunks: (idxDb.query(`SELECT count(*) c FROM chunks`).get() as { c: number }).c,
        ftsRows: (idxDb.query(`SELECT count(*) c FROM parts`).get() as { c: number }).c,
        indexed: (idxDb.query(`SELECT count(*) c FROM indexed_sessions`).get() as { c: number }).c,
        total: sourceSessions.filter((s) => !exclusions.matches(s.directory)).length,
        excluded: sourceSessions.filter((s) => exclusions.matches(s.directory)).length,
      }
    }

    const sh = (dir: string) => shortDir(dir, home)

    /** Resolve a session id or slug, with a note when a slug was ambiguous. */
    function resolve(idOrSlug: string, verb: string): { s: SessionRow; note: string } | null {
      const candidates = source.findSession(idOrSlug).filter((s) => !exclusions.matches(s.directory))
      const s = candidates[0]
      if (!s) return null
      const note =
        s.id !== idOrSlug && candidates.length > 1
          ? `NOTE: ${candidates.length}+ sessions share slug '${idOrSlug}'; ${verb} the most recent. Others: ${candidates
              .slice(1)
              .map((c) => `${c.id} (${c.title.slice(0, 40)}, ${fmtDate(c.time_updated)})`)
              .join("; ")}\n`
          : ""
      return { s, note }
    }

    function header(s: SessionRow, note: string): string {
      return `${note}# ${s.title}\nsession_id=${s.id} slug=${s.slug} · ${sh(s.directory)} · ${fmtDate(s.time_created)} → ${fmtDate(s.time_updated)}`
    }

    async function branches(query: string, mode: string, f: Filters): Promise<{ lex: Hit[]; sem: Hit[] }> {
      const lex = mode === "semantic" ? [] : searcher.lexical(query, f)
      let sem: Hit[] = []
      if (mode !== "lexical") {
        try {
          sem = await searcher.semantic(query, f)
        } catch (e) {
          log("semantic search failed, falling back to lexical", e)
        }
      }
      return { lex, sem }
    }

    await ctx.tool.transform((tools) => {
      tools.add({
        name: "recall_search",
        description:
          "Search ALL past OpenCode conversations on this machine (every project, full history) with hybrid lexical (FTS5/BM25 over messages, reasoning, and tool outputs) + semantic (embedding) search. Use when the user references a previous discussion ('do you remember', 'we discussed', 'in another session'), or when past decisions, fixes, commands, or error messages would help. Also searches THIS session's history from before its last compaction — useful for recovering details lost to context compaction. Returns ranked sessions with snippets; follow up with recall_expand for transcript context around a hit.",
        input: {
          type: "object",
          additionalProperties: false,
          required: ["query"],
          properties: {
            query: { type: "string", description: "Search query — natural language or exact keywords/identifiers" },
            mode: MODE_SCHEMA,
            directory: {
              type: "string",
              description:
                "Substring filter on the session working directory, e.g. 'infrastructure' or 'Projects_personal'",
            },
            since: { type: "string", description: "Only sessions after this ISO date, e.g. 2026-05-01" },
            until: { type: "string", description: "Only sessions before this ISO date" },
            include_tools: {
              type: "boolean",
              description: "Include tool outputs (bash/file contents) in lexical matching (default true)",
            },
            limit: { type: "number", description: "Max sessions returned (default 8, max 25)" },
          },
        },
        options: { codemode: false },
        async execute(input, tctx) {
          const args = record(input)
          const query = optStr(args.query) ?? ""
          const c = counts()
          if (!c.indexed) {
            track(runBackfill())
            return asResult(
              `Index is empty — backfill just started (${c.total} eligible sessions to index, ETA a few minutes). Retry shortly; recall_status shows progress.`,
            )
          }
          const f: Filters = {
            since: parseWhen(optStr(args.since), 0),
            until: parseWhen(optStr(args.until), Number.MAX_SAFE_INTEGER),
            includeTools: optBool(args.include_tools) !== false,
            directory: optStr(args.directory),
            excludeSession: tctx.sessionID,
            excludeBefore: source.compactionBoundary(tctx.sessionID),
          }
          const mode = searchMode(args.mode)
          const { lex, sem } = await branches(query, mode, f)

          const groups = fuse(
            [
              { hits: lex, which: "lex" as const },
              { hits: sem, which: "sem" as const },
            ],
            (h) => h.session_id,
            { rrfK: config.search.rrfK, perBranchCap: 3, hitsPerKey: 2 },
          )
          if (!groups.length)
            return asResult(
              `No matches for "${query}" (${mode}). Try mode=semantic for fuzzy recall, fewer/different keywords, or drop filters. Index: ${c.indexed}/${c.total} sessions.`,
            )

          const ranked = groups.slice(0, clampInt(optNum(args.limit), 1, 25, 8))
          const shown = ranked.flatMap((g) => g.hits)
          const snippets = searcher.snippets(shown, query)

          const lines: string[] = [
            `index: ${c.indexed}/${c.total} sessions, ${c.chunks} chunks${indexer.state.running ? ` · backfill ${indexer.state.done}/${indexer.state.total} running` : ""}`,
          ]
          ranked.forEach((g, i) => {
            const s = source.session(g.key)
            const best = g.hits[0]
            const self = g.key === tctx.sessionID ? " ← THIS session, before its last compaction" : ""
            lines.push(
              `${i + 1}. ${s?.title ?? "(untitled)"} — ${fmtDate(s?.time_updated ?? best.time)} · ${sh(s?.directory ?? "?")}${self}`,
              `   session_id=${g.key} message_id=${best.message_id} matches(lex=${g.nLex},sem=${g.nSem})`,
              ...g.hits.map((h) => `   [${h.via}] ${snippets.get(h) ?? ""}`),
            )
          })
          lines.push(
            `\nNext rung: recall_inspect(session_id, query?) searches within a session (or outlines it); recall_expand reads around a message_id; recall_summarize (slow, worker model) only if those don't answer it.`,
          )
          return asResult({ title: `recall: ${query}`, output: lines.join("\n") })
        },
      })

      tools.add({
        name: "recall_expand",
        description:
          "Read a transcript excerpt from a past OpenCode conversation found via recall_search. Given a session_id (or slug) and optionally a message_id to center on, returns the surrounding user/assistant turns with timestamps and one-line tool-call summaries.",
        input: {
          type: "object",
          additionalProperties: false,
          required: ["session_id"],
          properties: {
            session_id: { type: "string", description: "Session id (ses_...) or slug from recall_search" },
            message_id: {
              type: "string",
              description: "Center the window on this message (msg_...); defaults to the end of the session",
            },
            window: { type: "number", description: "Number of messages to include (default 12, max 60)" },
            max_chars: { type: "number", description: "Max characters per message (default 800, max 4000)" },
          },
        },
        options: { codemode: false },
        async execute(input) {
          const args = record(input)
          const sessionArg = optStr(args.session_id) ?? ""
          const found = resolve(sessionArg, "showing")
          if (!found) return asResult(`No session found for '${sessionArg}'.`)
          const { s, note } = found
          const messages = source.messages(s.id)
          if (!messages.length) return asResult(`Session ${s.id} has no messages.`)

          const window = clampInt(optNum(args.window), 2, 60, 12)
          const maxChars = clampInt(optNum(args.max_chars), 100, 4000, 800)
          let center = messages.length - 1
          const messageId = optStr(args.message_id)
          if (messageId) {
            const i = messages.findIndex((m) => m.id === messageId)
            if (i >= 0) center = i
          }
          const start = Math.max(0, Math.min(center - Math.floor(window / 2), messages.length - window))
          const slice = messages.slice(start, start + window)

          const lines: string[] = [
            header(s, note),
            `messages ${start + 1}-${start + slice.length} of ${messages.length}`,
            "",
          ]
          let budget = 20_000
          for (const m of slice) {
            const rendered = source.renderMessage(m, maxChars)
            if (!rendered) continue
            const block = `${rendered}\n`
            if (block.length > budget) break
            budget -= block.length
            lines.push(block)
          }
          lines.push(`(widen with window=${Math.min(window * 2, 60)} or center on another message_id)`)
          return asResult({ title: `recall: ${s.title}`, output: lines.join("\n") })
        },
      })

      tools.add({
        name: "recall_inspect",
        description:
          "Look inside ONE past session — the cheap, instant first stop after recall_search finds it, before reaching for recall_summarize. With a query: hybrid-search within that session, returning message-level hits in chronological order with message_ids ready for recall_expand. Without a query: an outline of the session's user turns (its intent skeleton). Purely local — no worker model, no wait.",
        input: {
          type: "object",
          additionalProperties: false,
          required: ["session_id"],
          properties: {
            session_id: { type: "string", description: "Session id (ses_...) or slug from recall_search" },
            query: { type: "string", description: "Search within the session (omit for a user-turn outline)" },
            mode: MODE_SCHEMA,
            include_tools: {
              type: "boolean",
              description: "Include tool outputs (bash/file contents) in lexical matching (default true)",
            },
            limit: { type: "number", description: "Max hits in query mode (default 12, max 30)" },
          },
        },
        options: { codemode: false },
        async execute(input, tctx) {
          const args = record(input)
          const sessionArg = optStr(args.session_id) ?? ""
          const found = resolve(sessionArg, "inspecting")
          if (!found) return asResult(`No session found for '${sessionArg}'.`)
          const { s, note } = found
          const head = header(s, note)
          const query = optStr(args.query)

          if (!query?.trim()) {
            const total = source.messageCount(s.id)
            const turns = source.userTurns(s.id)
            const line = (r: { id: string; t: number; txt: string }, i: number) =>
              `${i + 1}. ${fmtDateTime(r.t)} (${r.id}) ${clean(r.txt, 120)}`
            const toc =
              turns.length > 60
                ? [
                    ...turns.slice(0, 30).map(line),
                    `[... ${turns.length - 60} turns omitted — search them with query=... ]`,
                    ...turns.slice(-30).map((r, i) => line(r, turns.length - 30 + i)),
                  ]
                : turns.map(line)
            return asResult({
              title: `recall inspect: ${s.title}`,
              output: [
                head,
                `${total} messages · ${turns.length} user turns`,
                "",
                "USER TURNS:",
                ...toc,
                "",
                `Search within: query=...; read around a turn: recall_expand(session_id, message_id); whole-session story: recall_summarize.`,
              ].join("\n"),
            })
          }

          const f: Filters = {
            since: 0,
            until: Number.MAX_SAFE_INTEGER,
            includeTools: optBool(args.include_tools) !== false,
            sessionId: s.id,
            excludeSession: tctx.sessionID,
            excludeBefore: source.compactionBoundary(tctx.sessionID),
          }
          const mode = searchMode(args.mode)
          let { lex, sem } = await branches(query, mode, f)
          // Within one session, semantic search must filter rather than only
          // rank: cosine always returns top-k even for an irrelevant query, and
          // unlike corpus search there is no cross-session competition to bury
          // weak hits. Explicit mode=semantic keeps the raw ranking.
          if (mode === "hybrid")
            sem = sem.filter((h) => SearchIndex.semanticScore(h) >= config.search.inspectSemMin)

          const fused = fuse(
            [
              { hits: lex, which: "lex" as const },
              { hits: sem, which: "sem" as const },
            ],
            (h) => h.message_id,
            { rrfK: config.search.rrfK },
          )
          if (!fused.length) {
            const indexed = idxDb.query(`SELECT 1 FROM indexed_sessions WHERE session_id=?`).get(s.id)
            const hint = indexed
              ? "Likely not discussed in this session. Try different keywords, mode=semantic (unfiltered ranking), or omit query for a user-turn outline."
              : "This session is not indexed yet (the index lags a few minutes behind live sessions) — recall_expand reads it directly."
            return asResult(`${head}\n\nNo matches for "${query}" (${mode}) in this session. ${hint}`)
          }

          const top = fused.slice(0, clampInt(optNum(args.limit), 1, 30, 12))
          top.sort((a, b) => a.hits[0].time - b.hits[0].time)
          const snippets = searcher.snippets(
            top.map((g) => g.hits[0]),
            query,
          )
          const lines = [
            head,
            `${top.length} of ${fused.length} matches for "${query}" (${mode}) — chronological:`,
            "",
          ]
          top.forEach((g, i) => {
            const h = g.hits[0]
            lines.push(`${i + 1}. ${fmtDateTime(h.time)} (${h.message_id})`, `   [${h.via}] ${snippets.get(h) ?? ""}`)
          })
          lines.push(
            "",
            `Read around a hit: recall_expand(session_id, message_id). Escalate to recall_summarize only if this doesn't answer it.`,
          )
          return asResult({ title: `recall inspect: ${s.title}`, output: lines.join("\n") })
        },
      })

      tools.add({
        name: "recall_summarize",
        description: `ESCALATION rung — summarize entire past OpenCode sessions (or answer a focused question about them) by offloading to a cheap worker model. Defaults to ${config.summary.model.providerID}/${config.summary.model.modelID} at ${config.summary.model.variant ?? "the provider default"} reasoning; providerID, modelID, and variant may override that per call. Each fresh summary takes 10-30s, so try the instant local tools first: recall_inspect to search within the session, recall_expand to read around a hit. Reach for this when inspection can't answer cleanly, the session is too large to page, or you genuinely need the whole-session story (results are cached, so repeats are instant). Batch multiple sessions in one call via session_ids — they run concurrently.`,
        input: {
          type: "object",
          additionalProperties: false,
          properties: {
            session_id: { type: "string", description: "Session id (ses_...) or slug from recall_search" },
            session_ids: {
              type: "array",
              items: { type: "string" },
              description: `Batch: several session ids/slugs summarized concurrently in one call (max ${config.summary.batchMax})`,
            },
            focus: {
              type: "string",
              description:
                "Optional question to answer from each session instead of a general summary, e.g. 'what did we decide about auth?'",
            },
            refresh: { type: "boolean", description: "Bypass the cache and re-summarize (default false)" },
            providerID: {
              type: "string",
              description: `Provider override (default ${config.summary.model.providerID})`,
            },
            modelID: { type: "string", description: `Model override (default ${config.summary.model.modelID})` },
            variant: {
              type: "string",
              description: `Reasoning-effort variant override (default ${config.summary.model.variant ?? "provider default"})`,
            },
          },
        },
        options: { codemode: false },
        async execute(input, tctx) {
          const args = record(input)
          if (!summarizer.available)
            return asResult(
              config.summary.enabled
                ? "recall_summarize is unavailable: no opencode session client in this context."
                : "recall_summarize is disabled in your recall config (summary.enabled = false).",
            )
          const single = optStr(args.session_id)
          const ids = [...new Set([...(single ? [single] : []), ...(optStrArray(args.session_ids) ?? [])])]
          if (!ids.length) return asResult("Provide session_id or session_ids.")
          if (ids.length > config.summary.batchMax)
            return asResult(`Too many sessions (${ids.length}); max ${config.summary.batchMax} per call. Split into batches.`)
          const selectedModel = await resolveSummaryModel({
            providerID: optStr(args.providerID),
            modelID: optStr(args.modelID),
            variant: optStr(args.variant),
          })
          if (typeof selectedModel === "string") return asResult(selectedModel)
          const selectedModelTag = `${selectedModel.providerID}/${selectedModel.modelID}${selectedModel.variant ? `/${selectedModel.variant}` : ""}`
          const focus = (optStr(args.focus) ?? "").trim()
          let done = 0

          const renderBlock = async (idOrSlug: string): Promise<string> => {
            try {
              const found = resolve(idOrSlug, "summarizing")
              if (!found) return `# ${idOrSlug}\nNo session found.`
              const { s, note } = found
              const r = await summarizer.summarize(s, focus, optBool(args.refresh) === true, undefined, selectedModel)
              const suffix = focus ? ` · focus: ${focus}` : ""
              const status = r.cachedAt
                ? `(cached ${fmtDateTime(r.cachedAt)} · ${selectedModelTag}${suffix})`
                : `(fresh · ${selectedModelTag}${r.messages ? ` · ${r.messages} messages` : ""}${r.secs ? ` · ${r.secs.toFixed(1)}s` : ""}${suffix})`
              return `${header(s, note)}\n${status}\n\n${r.summary}`
            } catch (e) {
              log("summarize failed", idOrSlug, e)
              return `# ${idOrSlug}\nSummarization failed: ${e instanceof Error ? e.message : String(e)}`
            }
          }

          const blocks = await pool(ids, config.summary.concurrency, async (idOrSlug) => {
            const block = await renderBlock(idOrSlug)
            done++
            if (ids.length > 1) void tctx.progress({ title: `recall summarize: ${done}/${ids.length}` })
            return block
          })

          if (blocks.length === 1) {
            const title = resolve(ids[0], "summarizing")?.s.title ?? ids[0]
            return asResult({ title: `recall summary: ${title}`, output: blocks[0] })
          }
          return asResult({ title: `recall summaries: ${blocks.length} sessions`, output: blocks.join("\n\n---\n\n") })
        },
      })

      tools.add({
        name: "recall_status",
        description:
          "Show the recall conversation-index status: sessions/chunks indexed, backfill progress, embedding model state, and storage size. Use to check indexing health or explain missing recall_search results.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: false },
        async execute() {
          const c = counts()
          const st = indexer.state
          const backfill = st.running
            ? `running ${st.done}/${st.total}`
            : st.skippedLocked
              ? "held by another opencode process"
              : st.lastRun
                ? `idle (last run ${fmtDateTime(st.lastRun)})`
                : "not yet run"
          const lines = [
            `sessions indexed: ${c.indexed}/${c.total} eligible`,
            `sessions excluded: ${c.excluded} (${exclusions.entries().length} configured directories)`,
            `embedded chunks: ${c.chunks}`,
            `fts rows: ${c.ftsRows}`,
            `backfill: ${backfill}`,
            st.lastError ? `last error: ${clean(st.lastError, 200)}` : "",
            `model: ${config.embed.model} (${config.embed.dims}d, q8) — ${embedder.loaded() ? "loaded" : "not loaded"}`,
            config.summary.enabled
              ? `summaries cached: ${summarizer.cachedCount()} (${summarizer.modelTag})`
              : "summarizer: disabled",
            `index size: ${(fileSize(indexPath) / 1024 / 1024).toFixed(1)} MB at ${sh(config.dataDir)}`,
            `config: ${configSource === "defaults" ? "defaults" : sh(configSource)}`,
            migration.reset ? `index was reset this session: ${migration.reason}` : "",
            `process RSS: ${Math.round(process.memoryUsage.rss() / 1024 / 1024)} MB`,
          ].filter(Boolean)
          return asResult({ title: "recall status", output: lines.join("\n") })
        },
      })
    })

    return async () => {
      try {
        eventsStopped = true
        void eventIterator.return?.().catch(() => {})
        clearTimeout(startTimer)
        clearInterval(configTimer)
        if (pending.size) await Promise.race([Promise.allSettled([...pending]), Bun.sleep(8_000)])
        embedder.shutdown()
        idxDb.close()
        srcDb.close()
      } catch {}
    }
  },
})
