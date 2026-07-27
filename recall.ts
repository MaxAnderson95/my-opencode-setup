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
 * DB), schema (sidecar DDL + migration), embedder, indexer, search, summarize.
 * This file is wiring and tool surface only.
 */
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { Database } from "bun:sqlite"
import { tool, type Plugin } from "@opencode-ai/plugin"

import { loadConfig, modelTag } from "./lib/config.ts"
import { createEmbedder } from "./lib/embedder.ts"
import { Indexer } from "./lib/indexer.ts"
import { createNotifier, noopNotify } from "./lib/notify.ts"
import { BackfillLease, migrate, openIndex } from "./lib/schema.ts"
import { SearchIndex, fuse, type Filters, type Hit } from "./lib/search.ts"
import { Source, type SessionRow } from "./lib/source.ts"
import { Summarizer, WORKER_PREFIX, pool } from "./lib/summarize.ts"
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

/**
 * When init fails the plugin must not take opencode down with it, but going
 * completely silent leaves no way to find out why from inside the session.
 * A lone status tool that reports the failure is the compromise.
 */
function disabledPlugin(reason: string, logPath: string) {
  return {
    tool: {
      recall_status: tool({
        description:
          "Show the recall conversation-index status. recall is currently DISABLED because it failed to initialise; this reports why.",
        args: {},
        async execute() {
          return {
            title: "recall status: disabled",
            output: `recall is disabled: ${reason}\n\nThe other recall_* tools are unavailable this session. Diagnostics: ${logPath}`,
          }
        },
      }),
    },
  }
}

export const RecallPlugin: Plugin = async (input) => {
  const client = (input as { client?: any } | undefined)?.client
  const home = os.homedir()
  const { config, source: configSource, warnings } = loadConfig()
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
    return disabledPlugin(reason, logPath)
  }

  const notify = config.notify.enabled ? createNotifier(client, log) : noopNotify
  if (migration.reset)
    notify({
      message: `Conversation index reset (${migration.reason}); reclaimed ${(migration.reclaimedBytes / 1024 / 1024).toFixed(0)} MB.`,
      variant: "info",
    })

  const source = new Source(srcDb)
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
    log,
    skipTools: OWN_TOOLS,
    workerPrefix: WORKER_PREFIX,
    notify,
    afterReset: migration.reset,
  })
  const searcher = new SearchIndex(idxDb, source, embedder, config, log)
  const summarizer = new Summarizer({ idx: idxDb, source, config, client, home, log })

  // Fire-and-forget work is tracked so shutdown can drain rather than yank the
  // ONNX session out from under an in-flight embed.
  const pending = new Set<Promise<unknown>>()
  const track = (p: Promise<unknown>) => {
    pending.add(p)
    p.catch(() => {}).finally(() => pending.delete(p))
  }

  const runBackfill = () =>
    indexer.backfill(new BackfillLease(idxDb, config.backfill.leaseMs))

  const startTimer = setTimeout(
    () => track(runBackfill()),
    config.backfill.delayMs + Math.floor(Math.random() * 10_000),
  )
  startTimer.unref?.()

  const counts = () => ({
    chunks: (idxDb.query(`SELECT count(*) c FROM chunks`).get() as { c: number }).c,
    ftsRows: (idxDb.query(`SELECT count(*) c FROM parts`).get() as { c: number }).c,
    indexed: (idxDb.query(`SELECT count(*) c FROM indexed_sessions`).get() as { c: number }).c,
    total: source.sessionCount(),
  })

  const sh = (dir: string) => shortDir(dir, home)

  /** Resolve a session id or slug, with a note when a slug was ambiguous. */
  function resolve(idOrSlug: string, verb: string): { s: SessionRow; note: string } | null {
    const candidates = source.findSession(idOrSlug)
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

  return {
    config: async (cfg) => {
      // Only register the worker agent if summarisation is actually usable;
      // otherwise a machine without this provider gets a hidden agent pointing
      // at a model it cannot reach.
      if (!config.summary.enabled) return
      cfg.agent ??= {}
      cfg.agent[config.summary.agent] = {
        model: `${config.summary.model.providerID}/${config.summary.model.modelID}`,
        variant: config.summary.model.variant,
        mode: "subagent",
        hidden: true,
      }
    },

    dispose: async () => {
      try {
        clearTimeout(startTimer)
        if (pending.size) await Promise.race([Promise.allSettled([...pending]), Bun.sleep(8_000)])
        embedder.shutdown()
        idxDb.close()
        srcDb.close()
      } catch {}
    },

    event: async ({ event }) => {
      try {
        if (event.type === "session.idle") {
          const sid = (event as any).properties?.sessionID
          if (sid) track(indexer.indexSession(sid).catch((e) => log("idle index error", sid, e)))
        } else if (event.type === "session.deleted") {
          const sid = (event as any).properties?.info?.id
          if (sid) indexer.purge(sid)
        }
      } catch (e) {
        log("event hook error", e)
      }
    },

    tool: {
      recall_search: tool({
        description:
          "Search ALL past OpenCode conversations on this machine (every project, full history) with hybrid lexical (FTS5/BM25 over messages, reasoning, and tool outputs) + semantic (embedding) search. Use when the user references a previous discussion ('do you remember', 'we discussed', 'in another session'), or when past decisions, fixes, commands, or error messages would help. Also searches THIS session's history from before its last compaction — useful for recovering details lost to context compaction. Returns ranked sessions with snippets; follow up with recall_expand for transcript context around a hit.",
        args: {
          query: tool.schema.string().describe("Search query — natural language or exact keywords/identifiers"),
          mode: tool.schema
            .enum(["hybrid", "lexical", "semantic"])
            .optional()
            .describe("hybrid (default) fuses both; lexical = exact terms only; semantic = meaning only"),
          directory: tool.schema
            .string()
            .optional()
            .describe("Substring filter on the session working directory, e.g. 'infrastructure' or 'Projects_personal'"),
          since: tool.schema.string().optional().describe("Only sessions after this ISO date, e.g. 2026-05-01"),
          until: tool.schema.string().optional().describe("Only sessions before this ISO date"),
          include_tools: tool.schema
            .boolean()
            .optional()
            .describe("Include tool outputs (bash/file contents) in lexical matching (default true)"),
          limit: tool.schema.number().optional().describe("Max sessions returned (default 8, max 25)"),
        },
        async execute(args, ctx) {
          const c = counts()
          if (!c.indexed) {
            track(runBackfill())
            return `Index is empty — backfill just started (${c.total} sessions to index, ETA a few minutes). Retry shortly; recall_status shows progress.`
          }
          const f: Filters = {
            since: parseWhen(args.since, 0),
            until: parseWhen(args.until, Number.MAX_SAFE_INTEGER),
            includeTools: args.include_tools !== false,
            directory: args.directory,
            excludeSession: ctx.sessionID,
            excludeBefore: source.compactionBoundary(ctx.sessionID),
          }
          const mode = args.mode ?? "hybrid"
          const { lex, sem } = await branches(args.query, mode, f)

          const groups = fuse(
            [
              { hits: lex, which: "lex" as const },
              { hits: sem, which: "sem" as const },
            ],
            (h) => h.session_id,
            { rrfK: config.search.rrfK, perBranchCap: 3, hitsPerKey: 2 },
          )
          if (!groups.length)
            return `No matches for "${args.query}" (${mode}). Try mode=semantic for fuzzy recall, fewer/different keywords, or drop filters. Index: ${c.indexed}/${c.total} sessions.`

          const ranked = groups.slice(0, clampInt(args.limit, 1, 25, 8))
          const shown = ranked.flatMap((g) => g.hits)
          const snippets = searcher.snippets(shown, args.query)

          const lines: string[] = [
            `index: ${c.indexed}/${c.total} sessions, ${c.chunks} chunks${indexer.state.running ? ` · backfill ${indexer.state.done}/${indexer.state.total} running` : ""}`,
          ]
          ranked.forEach((g, i) => {
            const s = source.session(g.key)
            const best = g.hits[0]
            const self = g.key === ctx.sessionID ? " ← THIS session, before its last compaction" : ""
            lines.push(
              `${i + 1}. ${s?.title ?? "(untitled)"} — ${fmtDate(s?.time_updated ?? best.time)} · ${sh(s?.directory ?? "?")}${self}`,
              `   session_id=${g.key} message_id=${best.message_id} matches(lex=${g.nLex},sem=${g.nSem})`,
              ...g.hits.map((h) => `   [${h.via}] ${snippets.get(h) ?? ""}`),
            )
          })
          lines.push(
            `\nNext rung: recall_inspect(session_id, query?) searches within a session (or outlines it); recall_expand reads around a message_id; recall_summarize (slow, worker model) only if those don't answer it.`,
          )
          return { title: `recall: ${args.query}`, output: lines.join("\n") }
        },
      }),

      recall_expand: tool({
        description:
          "Read a transcript excerpt from a past OpenCode conversation found via recall_search. Given a session_id (or slug) and optionally a message_id to center on, returns the surrounding user/assistant turns with timestamps and one-line tool-call summaries.",
        args: {
          session_id: tool.schema.string().describe("Session id (ses_...) or slug from recall_search"),
          message_id: tool.schema
            .string()
            .optional()
            .describe("Center the window on this message (msg_...); defaults to the end of the session"),
          window: tool.schema.number().optional().describe("Number of messages to include (default 12, max 60)"),
          max_chars: tool.schema.number().optional().describe("Max characters per message (default 800, max 4000)"),
        },
        async execute(args) {
          const found = resolve(args.session_id, "showing")
          if (!found) return `No session found for '${args.session_id}'.`
          const { s, note } = found
          const messages = source.messages(s.id)
          if (!messages.length) return `Session ${s.id} has no messages.`

          const window = clampInt(args.window, 2, 60, 12)
          const maxChars = clampInt(args.max_chars, 100, 4000, 800)
          let center = messages.length - 1
          if (args.message_id) {
            const i = messages.findIndex((m) => m.id === args.message_id)
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
          return { title: `recall: ${s.title}`, output: lines.join("\n") }
        },
      }),

      recall_inspect: tool({
        description:
          "Look inside ONE past session — the cheap, instant first stop after recall_search finds it, before reaching for recall_summarize. With a query: hybrid-search within that session, returning message-level hits in chronological order with message_ids ready for recall_expand. Without a query: an outline of the session's user turns (its intent skeleton). Purely local — no worker model, no wait.",
        args: {
          session_id: tool.schema.string().describe("Session id (ses_...) or slug from recall_search"),
          query: tool.schema.string().optional().describe("Search within the session (omit for a user-turn outline)"),
          mode: tool.schema
            .enum(["hybrid", "lexical", "semantic"])
            .optional()
            .describe("hybrid (default) fuses both; lexical = exact terms only; semantic = meaning only"),
          include_tools: tool.schema
            .boolean()
            .optional()
            .describe("Include tool outputs (bash/file contents) in lexical matching (default true)"),
          limit: tool.schema.number().optional().describe("Max hits in query mode (default 12, max 30)"),
        },
        async execute(args, ctx) {
          const found = resolve(args.session_id, "inspecting")
          if (!found) return `No session found for '${args.session_id}'.`
          const { s, note } = found
          const head = header(s, note)

          if (!args.query?.trim()) {
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
            return {
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
            }
          }

          const f: Filters = {
            since: 0,
            until: Number.MAX_SAFE_INTEGER,
            includeTools: args.include_tools !== false,
            sessionId: s.id,
            excludeSession: ctx.sessionID,
            excludeBefore: source.compactionBoundary(ctx.sessionID),
          }
          const mode = args.mode ?? "hybrid"
          let { lex, sem } = await branches(args.query, mode, f)
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
            return `${head}\n\nNo matches for "${args.query}" (${mode}) in this session. ${hint}`
          }

          const top = fused.slice(0, clampInt(args.limit, 1, 30, 12))
          top.sort((a, b) => a.hits[0].time - b.hits[0].time)
          const snippets = searcher.snippets(
            top.map((g) => g.hits[0]),
            args.query,
          )
          const lines = [
            head,
            `${top.length} of ${fused.length} matches for "${args.query}" (${mode}) — chronological:`,
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
          return { title: `recall inspect: ${s.title}`, output: lines.join("\n") }
        },
      }),

      recall_summarize: tool({
        description: `ESCALATION rung — summarize entire past OpenCode sessions (or answer a focused question about them) by offloading to a cheap worker model. Each fresh summary takes 10-30s, so try the instant local tools first: recall_inspect to search within the session, recall_expand to read around a hit. Reach for this when inspection can't answer cleanly, the session is too large to page, or you genuinely need the whole-session story (results are cached, so repeats are instant). Batch multiple sessions in one call via session_ids — they run concurrently.`,
        args: {
          session_id: tool.schema.string().optional().describe("Session id (ses_...) or slug from recall_search"),
          session_ids: tool.schema
            .string()
            .array()
            .optional()
            .describe(`Batch: several session ids/slugs summarized concurrently in one call (max ${config.summary.batchMax})`),
          focus: tool.schema
            .string()
            .optional()
            .describe(
              "Optional question to answer from each session instead of a general summary, e.g. 'what did we decide about auth?'",
            ),
          refresh: tool.schema.boolean().optional().describe("Bypass the cache and re-summarize (default false)"),
        },
        async execute(args, ctx) {
          if (!summarizer.available)
            return config.summary.enabled
              ? "recall_summarize is unavailable: no opencode server client in this context."
              : "recall_summarize is disabled in your recall config (summary.enabled = false)."
          const ids = [...new Set([...(args.session_id ? [args.session_id] : []), ...(args.session_ids ?? [])])]
          if (!ids.length) return "Provide session_id or session_ids."
          if (ids.length > config.summary.batchMax)
            return `Too many sessions (${ids.length}); max ${config.summary.batchMax} per call. Split into batches.`
          const focus = (args.focus ?? "").trim()
          let done = 0

          const renderBlock = async (idOrSlug: string): Promise<string> => {
            try {
              const found = resolve(idOrSlug, "summarizing")
              if (!found) return `# ${idOrSlug}\nNo session found.`
              const { s, note } = found
              const r = await summarizer.summarize(s, focus, args.refresh === true, ctx?.abort)
              const suffix = focus ? ` · focus: ${focus}` : ""
              const status = r.cachedAt
                ? `(cached ${fmtDateTime(r.cachedAt)} · ${summarizer.modelTag}${suffix})`
                : `(fresh · ${summarizer.modelTag}${r.messages ? ` · ${r.messages} messages` : ""}${r.secs ? ` · ${r.secs.toFixed(1)}s` : ""}${suffix})`
              return `${header(s, note)}\n${status}\n\n${r.summary}`
            } catch (e) {
              log("summarize failed", idOrSlug, e)
              return `# ${idOrSlug}\nSummarization failed: ${e instanceof Error ? e.message : String(e)}`
            }
          }

          const blocks = await pool(ids, config.summary.concurrency, async (idOrSlug) => {
            const block = await renderBlock(idOrSlug)
            done++
            if (ids.length > 1) ctx?.metadata?.({ title: `recall summarize: ${done}/${ids.length}` })
            return block
          })

          if (blocks.length === 1) {
            const title = source.findSession(ids[0])[0]?.title ?? ids[0]
            return { title: `recall summary: ${title}`, output: blocks[0] }
          }
          return { title: `recall summaries: ${blocks.length} sessions`, output: blocks.join("\n\n---\n\n") }
        },
      }),

      recall_status: tool({
        description:
          "Show the recall conversation-index status: sessions/chunks indexed, backfill progress, embedding model state, and storage size. Use to check indexing health or explain missing recall_search results.",
        args: {},
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
            `sessions indexed: ${c.indexed}/${c.total}`,
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
          return { title: "recall status", output: lines.join("\n") }
        },
      }),
    },
  }
}

export default RecallPlugin
