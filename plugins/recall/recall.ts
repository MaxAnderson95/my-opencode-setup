/**
 * recall — hybrid lexical (FTS5/BM25) + semantic (embedding) search over ALL past
 * OpenCode conversations on this machine.
 *
 * Replaces the past-conversations skill (ad-hoc SQL over the opencode DB) with four
 * agent tools: recall_search, recall_expand, recall_summarize, recall_status.
 *
 * Design notes:
 * - Sidecar index at ~/.local/share/opencode-recall/index.db — the opencode DB is
 *   only ever opened read-only.
 * - Embeddings: in-process transformers.js (Xenova/bge-small-en-v1.5, q8, 384-dim),
 *   loaded via dynamic import so a missing/not-yet-installed dependency can never
 *   poison plugin module load (Bun caches failed static import resolution).
 * - Chunking: turn-pairs (user msg + following assistant text) are embedded;
 *   ALL text (incl. tool outputs, reasoning) goes into FTS for exact-term recall.
 * - Indexing: session.idle events + a watermark-based catch-up backfill on startup.
 *   Idempotent per-session rebuild; embeddings reused via content hash.
 * - The embedder (~300MB RSS) is lazy-loaded and disposed after 10 min idle.
 * - recall_summarize offloads whole-session summarization to a cheap fast
 *   large-context model (GLM-5.2 via OpenCode Go — NOT Zen) in an ephemeral,
 *   tool-less worker session that is deleted afterwards; results are cached in
 *   the sidecar keyed by (session, watermark, model, focus).
 */
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { Database } from "bun:sqlite"
import { tool, type Plugin } from "@opencode-ai/plugin"

// ---------------------------------------------------------------- constants

const MODEL = "Xenova/bge-small-en-v1.5"
const DIMS = 384
// bge models want this prefix on retrieval *queries* (not documents)
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: "
const DATA_DIR = path.join(os.homedir(), ".local", "share", "opencode-recall")
const SOURCE_DB = path.join(os.homedir(), ".local", "share", "opencode", "opencode.db")
const LOG_FILE = path.join(DATA_DIR, "recall.log")
const EMBED_BATCH = 8
const EMBEDDER_IDLE_MS = 10 * 60 * 1000
const BACKFILL_DELAY_MS = 20_000
const PAIR_USER_CHARS = 900
const PAIR_ASSISTANT_CHARS = 900
const TOOL_OUTPUT_CHARS = 16_000
const RRF_K = 60
const CANDIDATES = 60
const OWN_TOOLS = new Set(["recall_search", "recall_expand", "recall_status", "recall_summarize"])
// Summarizer worker: cheap + fast + 1M context, billed to the OpenCode Go plan (NOT Zen).
const SUMMARY_MODEL = { providerID: "opencode-go", modelID: "glm-5.2" }
const SUMMARY_CHAR_BUDGET = 300_000
const SUMMARY_MSG_CHARS = 2_000
const SUMMARY_TIMEOUT_MS = 180_000
const WORKER_PREFIX = "recall-summarizer worker: "

// ---------------------------------------------------------------- utilities

function log(...args: unknown[]) {
  try {
    const line = `${new Date().toISOString()} ${args.map((a) => (a instanceof Error ? (a.stack ?? String(a)) : typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) fs.truncateSync(LOG_FILE, 0)
    fs.appendFileSync(LOG_FILE, line)
  } catch {}
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\u001b\u009b](?:\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\[[0-9;?]*[0-9A-ORZcf-nqry=><]|[()#][0-9A-Za-z])/g

function clean(text: string, max: number): string {
  const out = text.replace(ANSI_RE, "").replace(/\s+/g, " ").trim()
  return out.length > max ? out.slice(0, max) + "…" : out
}

function shortDir(dir: string): string {
  const home = os.homedir()
  return dir.startsWith(home) ? "~" + dir.slice(home.length) : dir
}

function fmtDate(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function fmtDateTime(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${fmtDate(ms)} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function toVec(blob: Uint8Array): Float32Array {
  if (blob.byteOffset % 4 === 0 && blob.byteLength === DIMS * 4)
    return new Float32Array(blob.buffer, blob.byteOffset, DIMS)
  return new Float32Array(blob.slice().buffer, 0, DIMS)
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < DIMS; i++) s += a[i] * b[i]
  return s
}

/** FTS5 MATCH syntax treats many chars as operators; quote every token. */
function ftsQuery(query: string, op: "AND" | "OR"): string | undefined {
  const tokens = query.match(/[\p{L}\p{N}_./@-]+/gu)
  if (!tokens?.length) return undefined
  return tokens.map((t) => `"${t.replaceAll('"', "")}"`).join(` ${op} `)
}

function parseWhen(s: string | undefined, fallback: number): number {
  if (!s) return fallback
  const ms = Date.parse(s)
  return Number.isNaN(ms) ? fallback : ms
}

// ---------------------------------------------------------------- embedder

type Embedder = {
  embed(texts: string[]): Promise<Float32Array[]>
  dispose(): Promise<void>
}

let embedderP: Promise<Embedder> | null = null
let embedderLastUse = 0

function getEmbedder(): Promise<Embedder> {
  embedderLastUse = Date.now()
  if (embedderP) return embedderP
  const p = (async (): Promise<Embedder> => {
    // Dynamic import: keeps plugin module load independent of the heavy dep.
    const { pipeline, env } = await import("@huggingface/transformers")
    env.cacheDir = path.join(DATA_DIR, "models")
    const t0 = performance.now()
    const pipe = await pipeline("feature-extraction", MODEL, { dtype: "q8" })
    log(`embedder loaded in ${Math.round(performance.now() - t0)}ms`)
    return {
      async embed(texts: string[]): Promise<Float32Array[]> {
        embedderLastUse = Date.now()
        const out: Float32Array[] = []
        for (let i = 0; i < texts.length; i += EMBED_BATCH) {
          const batch = texts.slice(i, i + EMBED_BATCH)
          const tensor = await pipe(batch, { pooling: "mean", normalize: true })
          const data = tensor.data as Float32Array
          for (let j = 0; j < batch.length; j++) out.push(data.slice(j * DIMS, (j + 1) * DIMS))
          tensor.dispose?.()
          embedderLastUse = Date.now()
        }
        return out
      },
      async dispose() {
        await pipe.dispose?.()
      },
    }
  })()
  embedderP = p
  p.catch((e) => {
    log("embedder load failed", e)
    if (embedderP === p) embedderP = null // allow retry on next use
  })
  return p
}

const embedderReaper = setInterval(() => {
  if (!embedderP || Date.now() - embedderLastUse < EMBEDDER_IDLE_MS) return
  const p = embedderP
  embedderP = null
  p.then((e) => e.dispose()).catch(() => {})
  log("embedder disposed after idle")
}, 60_000)
embedderReaper.unref?.()

// ---------------------------------------------------------------- plugin

export const RecallPlugin: Plugin = async (input) => {
  // Server API client — used only by recall_summarize's ephemeral worker.
  const client = (input as { client?: any } | undefined)?.client
  // Never let init failures break opencode; disable ourselves instead.
  let srcDb: Database
  let idxDb: Database
  try {
    if (!fs.existsSync(SOURCE_DB)) throw new Error(`source db not found: ${SOURCE_DB}`)
    fs.mkdirSync(DATA_DIR, { recursive: true })
    srcDb = new Database(SOURCE_DB, { readonly: true })
    idxDb = new Database(path.join(DATA_DIR, "index.db"), { create: true })
    idxDb.run("PRAGMA journal_mode=WAL")
    idxDb.run("PRAGMA busy_timeout=5000")
    idxDb.run("PRAGMA synchronous=NORMAL")
    idxDb.run(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)`)
    idxDb.run(`CREATE TABLE IF NOT EXISTS chunks(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      time INTEGER NOT NULL,
      hash TEXT NOT NULL,
      text TEXT NOT NULL,
      emb BLOB NOT NULL)`)
    idxDb.run(`CREATE INDEX IF NOT EXISTS chunks_session ON chunks(session_id)`)
    idxDb.run(`CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
      text, session_id UNINDEXED, message_id UNINDEXED, role UNINDEXED, kind UNINDEXED, time UNINDEXED)`)
    idxDb.run(`CREATE TABLE IF NOT EXISTS parts_indexed(
      fts_rowid INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL)`)
    idxDb.run(`CREATE INDEX IF NOT EXISTS parts_indexed_session ON parts_indexed(session_id)`)
    idxDb.run(`CREATE TABLE IF NOT EXISTS indexed_sessions(
      session_id TEXT PRIMARY KEY,
      time_updated INTEGER NOT NULL,
      chunks INTEGER NOT NULL DEFAULT 0,
      fts_rows INTEGER NOT NULL DEFAULT 0)`)
    idxDb.run(`CREATE TABLE IF NOT EXISTS sessions(
      id TEXT PRIMARY KEY, slug TEXT, title TEXT, directory TEXT,
      parent_id TEXT, time_created INTEGER, time_updated INTEGER)`)
    // Summary cache — deliberately NOT cleared on embedding-model change.
    idxDb.run(`CREATE TABLE IF NOT EXISTS summaries(
      session_id TEXT NOT NULL,
      model TEXT NOT NULL,
      focus TEXT NOT NULL DEFAULT '',
      time_updated INTEGER NOT NULL,
      summary TEXT NOT NULL,
      created INTEGER NOT NULL,
      PRIMARY KEY (session_id, model, focus))`)

    // model change -> full semantic + lexical reindex
    const meta = idxDb.query(`SELECT value FROM meta WHERE key='model'`).get() as { value: string } | null
    const modelTag = `${MODEL}:${DIMS}`
    if (meta && meta.value !== modelTag) {
      log(`model changed ${meta.value} -> ${modelTag}; resetting index`)
      idxDb.run(`DELETE FROM chunks`)
      idxDb.run(`DELETE FROM fts`)
      idxDb.run(`DELETE FROM parts_indexed`)
      idxDb.run(`DELETE FROM indexed_sessions`)
    }
    idxDb.run(`INSERT INTO meta(key,value) VALUES ('model',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [
      modelTag,
    ])
  } catch (e) {
    log("recall init failed; plugin disabled", e)
    return {}
  }

  // -------------------------------------------------------------- indexing

  type PartRow = { id: string; message_id: string; data: string }
  type MsgRow = { id: string; role: string | null; time_created: number }

  const inFlight = new Set<string>()
  const backfillState = { running: false, total: 0, done: 0, lastError: "", lastRun: 0 }

  // Fire-and-forget work is tracked so dispose() can drain instead of yanking
  // the ONNX session out from under an in-flight embed.
  const pending = new Set<Promise<unknown>>()
  function track(p: Promise<unknown>) {
    pending.add(p)
    p.catch(() => {}).finally(() => pending.delete(p))
  }

  function purgeSession(sessionId: string) {
    const rowids = idxDb
      .query(`SELECT fts_rowid r FROM parts_indexed WHERE session_id=?`)
      .all(sessionId) as { r: number }[]
    const purge = idxDb.transaction(() => {
      for (const { r } of rowids) idxDb.run(`DELETE FROM fts WHERE rowid=?`, [r])
      idxDb.run(`DELETE FROM parts_indexed WHERE session_id=?`, [sessionId])
      idxDb.run(`DELETE FROM chunks WHERE session_id=?`, [sessionId])
      idxDb.run(`DELETE FROM indexed_sessions WHERE session_id=?`, [sessionId])
      idxDb.run(`DELETE FROM sessions WHERE id=?`, [sessionId])
    })
    purge()
  }

  async function indexSession(sessionId: string): Promise<void> {
    if (inFlight.has(sessionId)) return
    inFlight.add(sessionId)
    try {
      const s = srcDb
        .query(
          `SELECT id, slug, title, directory, parent_id, time_created, time_updated FROM session WHERE id=?`,
        )
        .get(sessionId) as
        | {
            id: string
            slug: string
            title: string
            directory: string
            parent_id: string | null
            time_created: number
            time_updated: number
          }
        | null
      if (!s) {
        purgeSession(sessionId)
        return
      }
      // Never index our own ephemeral summarizer workers (deleted after use anyway).
      if (s.title?.startsWith(WORKER_PREFIX)) return
      const wm = idxDb.query(`SELECT time_updated t FROM indexed_sessions WHERE session_id=?`).get(sessionId) as {
        t: number
      } | null
      if (wm && wm.t >= s.time_updated) return

      const messages = srcDb
        .query(
          `SELECT id, json_extract(data,'$.role') role, time_created
           FROM message WHERE session_id=? ORDER BY time_created, id`,
        )
        .all(sessionId) as MsgRow[]
      const roleOf = new Map(messages.map((m) => [m.id, m.role ?? "assistant"]))
      const parts = srcDb
        .query(`SELECT id, message_id, data FROM part WHERE session_id=? ORDER BY time_created, id`)
        .all(sessionId) as PartRow[]

      // ---- build FTS rows (all searchable text) and turn-pairs (embedded)
      type FtsRow = { message_id: string; role: string; kind: string; time: number; text: string }
      const ftsRows: FtsRow[] = []
      const textByMessage = new Map<string, string[]>()
      for (const p of parts) {
        let d: any
        try {
          d = JSON.parse(p.data)
        } catch {
          continue
        }
        const role = roleOf.get(p.message_id) ?? "assistant"
        const time = d.time?.start ?? d.time?.created ?? s.time_created
        if (d.type === "text" && typeof d.text === "string" && d.text.trim()) {
          ftsRows.push({ message_id: p.message_id, role, kind: "text", time, text: d.text })
          const arr = textByMessage.get(p.message_id) ?? []
          arr.push(d.text)
          textByMessage.set(p.message_id, arr)
        } else if (d.type === "reasoning" && typeof d.text === "string" && d.text.trim()) {
          ftsRows.push({ message_id: p.message_id, role, kind: "reasoning", time, text: d.text })
        } else if (d.type === "tool" && d.state?.status === "completed" && !OWN_TOOLS.has(d.tool)) {
          const out = typeof d.state.output === "string" ? d.state.output.replace(ANSI_RE, "") : ""
          const title = typeof d.state.title === "string" ? d.state.title : ""
          const text = `${d.tool ?? "tool"} ${title}\n${out}`.slice(0, TOOL_OUTPUT_CHARS)
          if (text.trim()) ftsRows.push({ message_id: p.message_id, role, kind: "tool", time, text })
        }
      }

      type Pair = { message_id: string; time: number; user: string[]; assistant: string[] }
      const pairs: Pair[] = []
      let cur: Pair | null = null
      for (const m of messages) {
        const texts = textByMessage.get(m.id)
        if (m.role === "user") {
          cur = { message_id: m.id, time: m.time_created, user: texts ?? [], assistant: [] }
          pairs.push(cur)
        } else if (texts) {
          if (!cur) {
            cur = { message_id: m.id, time: m.time_created, user: [], assistant: [] }
            pairs.push(cur)
          }
          cur.assistant.push(...texts)
        }
      }
      const chunkTexts: { message_id: string; time: number; text: string; hash: string }[] = []
      for (const pr of pairs) {
        const u = clean(pr.user.join("\n"), PAIR_USER_CHARS)
        const a = clean(pr.assistant.join("\n"), PAIR_ASSISTANT_CHARS)
        if (!u && !a) continue
        const text = (u ? `USER: ${u}\n` : "") + (a ? `ASSISTANT: ${a}` : "")
        chunkTexts.push({ message_id: pr.message_id, time: pr.time, text, hash: String(Bun.hash(text)) })
      }

      // ---- embed only what this session doesn't already have (hash reuse)
      const prior = new Map(
        (idxDb.query(`SELECT hash, emb FROM chunks WHERE session_id=?`).all(sessionId) as {
          hash: string
          emb: Uint8Array
        }[]).map((r) => [r.hash, r.emb]),
      )
      const need = chunkTexts.filter((c) => !prior.has(c.hash))
      const fresh = new Map<string, Uint8Array>()
      if (need.length) {
        const embedder = await getEmbedder()
        const vecs = await embedder.embed(need.map((c) => c.text))
        need.forEach((c, i) => {
          const v = vecs[i]
          fresh.set(c.hash, new Uint8Array(v.buffer, v.byteOffset, DIMS * 4))
        })
      }

      // ---- atomically replace this session in the index
      const oldRowids = idxDb
        .query(`SELECT fts_rowid r FROM parts_indexed WHERE session_id=?`)
        .all(sessionId) as { r: number }[]
      const write = idxDb.transaction(() => {
        for (const { r } of oldRowids) idxDb.run(`DELETE FROM fts WHERE rowid=?`, [r])
        idxDb.run(`DELETE FROM parts_indexed WHERE session_id=?`, [sessionId])
        idxDb.run(`DELETE FROM chunks WHERE session_id=?`, [sessionId])
        for (const c of chunkTexts) {
          const emb = fresh.get(c.hash) ?? prior.get(c.hash)!
          idxDb.run(`INSERT INTO chunks(session_id,message_id,time,hash,text,emb) VALUES (?,?,?,?,?,?)`, [
            sessionId,
            c.message_id,
            c.time,
            c.hash,
            c.text,
            emb,
          ])
        }
        for (const f of ftsRows) {
          const res = idxDb.run(`INSERT INTO fts(text,session_id,message_id,role,kind,time) VALUES (?,?,?,?,?,?)`, [
            f.text,
            sessionId,
            f.message_id,
            f.role,
            f.kind,
            f.time,
          ])
          idxDb.run(`INSERT INTO parts_indexed(fts_rowid,session_id) VALUES (?,?)`, [
            Number(res.lastInsertRowid),
            sessionId,
          ])
        }
        idxDb.run(
          `INSERT INTO sessions(id,slug,title,directory,parent_id,time_created,time_updated)
           VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET slug=excluded.slug, title=excluded.title, directory=excluded.directory,
             parent_id=excluded.parent_id, time_updated=excluded.time_updated`,
          [s.id, s.slug, s.title, s.directory, s.parent_id, s.time_created, s.time_updated],
        )
        idxDb.run(
          `INSERT INTO indexed_sessions(session_id,time_updated,chunks,fts_rows) VALUES (?,?,?,?)
           ON CONFLICT(session_id) DO UPDATE SET time_updated=excluded.time_updated,
             chunks=excluded.chunks, fts_rows=excluded.fts_rows`,
          [sessionId, s.time_updated, chunkTexts.length, ftsRows.length],
        )
      })
      write()
    } finally {
      inFlight.delete(sessionId)
    }
  }

  async function backfill(): Promise<void> {
    if (backfillState.running) return
    backfillState.running = true
    backfillState.lastRun = Date.now()
    try {
      const source = srcDb.query(`SELECT id, time_updated t FROM session ORDER BY time_updated DESC`).all() as {
        id: string
        t: number
      }[]
      const wms = new Map(
        (idxDb.query(`SELECT session_id s, time_updated t FROM indexed_sessions`).all() as {
          s: string
          t: number
        }[]).map((r) => [r.s, r.t]),
      )
      const stale = source.filter((s) => (wms.get(s.id) ?? 0) < s.t)
      backfillState.total = stale.length
      backfillState.done = 0
      if (stale.length) log(`backfill: ${stale.length} stale sessions`)
      for (const s of stale) {
        try {
          await indexSession(s.id)
        } catch (e) {
          backfillState.lastError = `${s.id}: ${e}`
          log("backfill index error", s.id, e)
        }
        backfillState.done++
        await Bun.sleep(15)
      }
      // purge sessions that no longer exist in the source
      const alive = new Set(source.map((s) => s.id))
      for (const [sid] of wms) if (!alive.has(sid)) purgeSession(sid)
      if (stale.length) {
        log(`backfill complete: ${backfillState.done}/${backfillState.total}`)
        Bun.gc(true) // release JSON-parse garbage from the one-time bulk pass
      }
    } catch (e) {
      backfillState.lastError = String(e)
      log("backfill failed", e)
    } finally {
      backfillState.running = false
    }
  }

  const startTimer = setTimeout(
    () => track(backfill()),
    BACKFILL_DELAY_MS + Math.floor(Math.random() * 10_000),
  )
  startTimer.unref?.()

  // -------------------------------------------------------------- search

  type Hit = { session_id: string; message_id: string; time: number; snippet: string; via: string }

  type SearchOpts = {
    since: number
    until: number
    includeTools: boolean
    whitelist: Set<string> | null
    exclude: string
    /** Current-session hits BEFORE this time are pre-compaction (out of the
     *  model's context) and therefore allowed; 0 = never compacted = exclude all. */
    excludeBefore: number
  }

  /** Current-session content is excluded only if the model can still see it. */
  function isExcluded(opts: SearchOpts, sessionId: string, time: number): boolean {
    return sessionId === opts.exclude && time >= opts.excludeBefore
  }

  /** Time of the latest compaction summary message, or 0 if never compacted. */
  function compactionBoundary(sessionId: string): number {
    try {
      const row = srcDb
        .query(
          `SELECT max(time_created) t FROM message
           WHERE session_id=? AND json_extract(data,'$.role')='assistant' AND json_extract(data,'$.summary')=1`,
        )
        .get(sessionId) as { t: number | null } | null
      return row?.t ?? 0
    } catch {
      return 0
    }
  }

  type SessionRow = {
    id: string
    slug: string
    title: string
    directory: string
    time_created: number
    time_updated: number
  }

  /** Resolve a ses_ id or slug. Slugs are NOT unique; exact id wins, else newest. */
  function findSession(idOrSlug: string): SessionRow[] {
    return srcDb
      .query(
        `SELECT id, slug, title, directory, time_created, time_updated FROM session
         WHERE id=? OR slug=? ORDER BY (id=?) DESC, time_updated DESC LIMIT 5`,
      )
      .all(idOrSlug, idOrSlug, idOrSlug) as SessionRow[]
  }

  /** One transcript block per message: collapsed tool one-liners + trimmed text. */
  function renderMessage(m: MsgRow, maxChars: number): string | null {
    const parts = srcDb
      .query(`SELECT data FROM part WHERE message_id=? ORDER BY time_created, id`)
      .all(m.id) as { data: string }[]
    const texts: string[] = []
    const tools: string[] = []
    let lastTool = ""
    let lastToolCount = 0
    const flushTool = () => {
      if (!lastToolCount) return
      tools.push(lastToolCount > 1 ? `${lastTool} (×${lastToolCount})` : lastTool)
      lastToolCount = 0
    }
    for (const p of parts) {
      try {
        const d = JSON.parse(p.data)
        if (d.type === "text" && typeof d.text === "string" && d.text.trim()) texts.push(d.text)
        else if (d.type === "tool" && d.tool) {
          const line = `[tool ${d.tool}] ${clean(String(d.state?.title ?? ""), 80)}`.trimEnd()
          if (line === lastTool) lastToolCount++
          else {
            flushTool()
            lastTool = line
            lastToolCount = 1
          }
        }
      } catch {}
    }
    flushTool()
    const body = [...tools, texts.length ? clean(texts.join("\n"), maxChars) : ""].filter(Boolean).join("\n")
    if (!body) return null
    return `── ${m.role ?? "assistant"} @ ${fmtDateTime(m.time_created)} (${m.id})\n${body}`
  }

  /** Compact whole-session transcript for the summarizer, middle-out truncated
   *  (goals live at the start of a session, outcomes at the end). */
  function fullTranscript(sessionId: string, budget: number): { text: string; messages: number } {
    const messages = srcDb
      .query(
        `SELECT id, json_extract(data,'$.role') role, time_created
         FROM message WHERE session_id=? ORDER BY time_created, id`,
      )
      .all(sessionId) as MsgRow[]
    const blocks: string[] = []
    for (const m of messages) {
      const b = renderMessage(m, SUMMARY_MSG_CHARS)
      if (b) blocks.push(b)
    }
    const total = blocks.reduce((n, b) => n + b.length + 1, 0)
    if (total > budget) {
      const head: string[] = []
      const tail: string[] = []
      let used = 0
      let lo = 0
      let hi = blocks.length - 1
      while (lo <= hi) {
        const takeHead = head.length <= tail.length
        const b = takeHead ? blocks[lo] : blocks[hi]
        if (used + b.length + 1 > budget) break
        used += b.length + 1
        if (takeHead) {
          head.push(blocks[lo])
          lo++
        } else {
          tail.unshift(blocks[hi])
          hi--
        }
      }
      const omitted = hi - lo + 1
      return {
        text: [...head, `[... ${omitted} of ${blocks.length} messages omitted ...]`, ...tail].join("\n"),
        messages: messages.length,
      }
    }
    return { text: blocks.join("\n"), messages: messages.length }
  }

  function sessionWhitelist(directory?: string): Set<string> | null {
    if (!directory) return null
    const rows = idxDb.query(`SELECT id FROM sessions WHERE directory LIKE ?`).all(`%${directory}%`) as {
      id: string
    }[]
    return new Set(rows.map((r) => r.id))
  }

  function lexicalSearch(query: string, opts: SearchOpts): Hit[] {
    const run = (match: string): Hit[] => {
      const rows = idxDb
        .query(
          `SELECT session_id, message_id, kind, CAST(time AS INTEGER) time,
                  snippet(fts, 0, '«', '»', '…', 14) snip
           FROM fts WHERE fts MATCH ? ORDER BY bm25(fts) LIMIT 500`,
        )
        .all(match) as { session_id: string; message_id: string; kind: string; time: number; snip: string }[]
      const out: Hit[] = []
      for (const r of rows) {
        if (isExcluded(opts, r.session_id, r.time)) continue
        if (r.time < opts.since || r.time > opts.until) continue
        if (!opts.includeTools && r.kind === "tool") continue
        if (opts.whitelist && !opts.whitelist.has(r.session_id)) continue
        out.push({
          session_id: r.session_id,
          message_id: r.message_id,
          time: r.time,
          snippet: clean(r.snip, 220),
          via: `lexical/${r.kind}`,
        })
        if (out.length >= CANDIDATES) break
      }
      return out
    }
    const andQ = ftsQuery(query, "AND")
    if (!andQ) return []
    try {
      let hits = run(andQ)
      if (!hits.length && /\s/.test(query.trim())) {
        const orQ = ftsQuery(query, "OR")
        if (orQ) hits = run(orQ)
      }
      return hits
    } catch (e) {
      log("lexical search error", e)
      return []
    }
  }

  // In-memory embedding matrix, rebuilt only when the chunks table changes.
  // Avoids re-reading ~45MB of blobs from SQLite on every semantic search.
  // AUTOINCREMENT ids never get reused, so (count, max id) is a reliable signature.
  type Matrix = {
    sig: string
    n: number
    mat: Float32Array
    ids: Float64Array
    times: Float64Array
    sessions: string[]
    messages: string[]
  }
  let matrix: Matrix | null = null

  function loadMatrix(): Matrix {
    const s = idxDb.query(`SELECT count(*) c, COALESCE(max(id),0) m FROM chunks`).get() as { c: number; m: number }
    const sig = `${s.c}:${s.m}`
    if (matrix?.sig === sig) return matrix
    const next: Matrix = {
      sig,
      n: s.c,
      mat: new Float32Array(s.c * DIMS),
      ids: new Float64Array(s.c),
      times: new Float64Array(s.c),
      sessions: new Array(s.c),
      messages: new Array(s.c),
    }
    let i = 0
    let lastId = 0
    while (i < s.c) {
      const rows = idxDb
        .query(`SELECT id, session_id, message_id, time, emb FROM chunks WHERE id > ? ORDER BY id LIMIT 4000`)
        .all(lastId) as { id: number; session_id: string; message_id: string; time: number; emb: Uint8Array }[]
      if (!rows.length) break
      for (const r of rows) {
        lastId = r.id
        next.mat.set(toVec(r.emb), i * DIMS)
        next.ids[i] = r.id
        next.times[i] = r.time
        next.sessions[i] = r.session_id
        next.messages[i] = r.message_id
        i++
      }
    }
    next.n = i
    matrix = next
    return next
  }

  async function semanticSearch(query: string, opts: SearchOpts): Promise<Hit[]> {
    const embedder = await getEmbedder()
    const [qvec] = await embedder.embed([QUERY_PREFIX + query])
    const m = loadMatrix()
    const scored: { score: number; i: number }[] = []
    for (let i = 0; i < m.n; i++) {
      if (m.times[i] < opts.since || m.times[i] > opts.until) continue
      if (isExcluded(opts, m.sessions[i], m.times[i])) continue
      if (opts.whitelist && !opts.whitelist.has(m.sessions[i])) continue
      scored.push({ score: dot(qvec, m.mat.subarray(i * DIMS, (i + 1) * DIMS) as Float32Array), i })
    }
    scored.sort((a, b) => b.score - a.score)
    const hits: Hit[] = []
    for (const t of scored.slice(0, CANDIDATES)) {
      const row = idxDb.query(`SELECT text FROM chunks WHERE id=?`).get(m.ids[t.i]) as { text: string } | null
      hits.push({
        session_id: m.sessions[t.i],
        message_id: m.messages[t.i],
        time: m.times[t.i],
        snippet: clean(row?.text ?? "", 220),
        via: `semantic ${t.score.toFixed(2)}`,
      })
    }
    return hits
  }

  function indexCounts() {
    const chunks = (idxDb.query(`SELECT count(*) c FROM chunks`).get() as { c: number }).c
    const indexed = (idxDb.query(`SELECT count(*) c FROM indexed_sessions`).get() as { c: number }).c
    const total = (srcDb.query(`SELECT count(*) c FROM session`).get() as { c: number }).c
    return { chunks, indexed, total }
  }

  // -------------------------------------------------------------- hooks

  return {
    dispose: async () => {
      try {
        clearTimeout(startTimer)
        // Drain in-flight indexing (capped) before touching the embedder.
        if (pending.size) await Promise.race([Promise.allSettled([...pending]), Bun.sleep(8_000)])
        const p = embedderP
        embedderP = null
        // Only dispose the ONNX session if nothing is still using it; on process
        // exit the OS reclaims it anyway, and disposing mid-embed is noisy.
        if (p && !pending.size) await p.then((e) => e.dispose()).catch(() => {})
        idxDb.close()
        srcDb.close()
      } catch {}
    },

    event: async ({ event }) => {
      try {
        if (event.type === "session.idle") {
          const sid = (event as any).properties?.sessionID
          if (sid) track(indexSession(sid).catch((e) => log("idle index error", sid, e)))
        } else if (event.type === "session.deleted") {
          const sid = (event as any).properties?.info?.id
          if (sid) purgeSession(sid)
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
          limit: tool.schema.number().optional().describe("Max sessions returned (default 8)"),
        },
        async execute(args, ctx) {
          const counts = indexCounts()
          if (!counts.indexed) {
            void backfill()
            return `Index is empty — backfill just started (${counts.total} sessions to index, ETA a few minutes). Retry shortly; recall_status shows progress.`
          }
          const opts: SearchOpts = {
            since: parseWhen(args.since, 0),
            until: parseWhen(args.until, Number.MAX_SAFE_INTEGER),
            includeTools: args.include_tools !== false,
            whitelist: sessionWhitelist(args.directory),
            exclude: ctx.sessionID,
            excludeBefore: compactionBoundary(ctx.sessionID),
          }
          const mode = args.mode ?? "hybrid"
          const lex = mode === "semantic" ? [] : lexicalSearch(args.query, opts)
          let sem: Hit[] = []
          if (mode !== "lexical") {
            try {
              sem = await semanticSearch(args.query, opts)
            } catch (e) {
              log("semantic search failed, falling back to lexical", e)
            }
          }

          // Reciprocal Rank Fusion, grouped by session
          type Group = { score: number; hits: Hit[]; nLex: number; nSem: number }
          const groups = new Map<string, Group>()
          const fuse = (hits: Hit[], which: "lex" | "sem") => {
            hits.forEach((h, rank) => {
              const g = groups.get(h.session_id) ?? { score: 0, hits: [], nLex: 0, nSem: 0 }
              const n = which === "lex" ? g.nLex : g.nSem
              // Only the best 3 hits per branch count toward the session score,
              // so many weak matches can't drown out a single strong one.
              if (n < 3) g.score += 1 / (RRF_K + rank)
              if (g.hits.length < 2 && !g.hits.some((x) => x.message_id === h.message_id || x.snippet === h.snippet))
                g.hits.push(h)
              which === "lex" ? g.nLex++ : g.nSem++
              groups.set(h.session_id, g)
            })
          }
          fuse(lex, "lex")
          fuse(sem, "sem")
          if (!groups.size)
            return `No matches for "${args.query}" (${mode}). Try mode=semantic for fuzzy recall, fewer/different keywords, or drop filters. Index: ${counts.indexed}/${counts.total} sessions.`

          const ranked = [...groups.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, args.limit ?? 8)
          const lines: string[] = [
            `index: ${counts.indexed}/${counts.total} sessions, ${counts.chunks} chunks${backfillState.running ? ` · backfill ${backfillState.done}/${backfillState.total} running` : ""}`,
          ]
          ranked.forEach(([sid, g], i) => {
            const s = idxDb
              .query(`SELECT slug, title, directory, time_updated FROM sessions WHERE id=?`)
              .get(sid) as { slug: string; title: string; directory: string; time_updated: number } | null
            const best = g.hits[0]
            const self = sid === ctx.sessionID ? " ← THIS session, before its last compaction" : ""
            lines.push(
              `${i + 1}. ${s?.title ?? "(untitled)"} — ${fmtDate(s?.time_updated ?? best.time)} · ${shortDir(s?.directory ?? "?")}${self}`,
              `   session_id=${sid} message_id=${best.message_id} matches(lex=${g.nLex},sem=${g.nSem})`,
              ...g.hits.map((h) => `   [${h.via}] ${h.snippet}`),
            )
          })
          lines.push(
            `\nUse recall_expand with a session_id (+ optional message_id) to read the surrounding transcript, or recall_summarize for the whole-session story.`,
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
          window: tool.schema.number().optional().describe("Number of messages to include (default 12)"),
          max_chars: tool.schema.number().optional().describe("Max characters per message (default 800)"),
        },
        async execute(args) {
          const candidates = findSession(args.session_id)
          const s = candidates[0]
          if (!s) return `No session found for '${args.session_id}'.`
          const ambiguous =
            s.id !== args.session_id && candidates.length > 1
              ? `NOTE: ${candidates.length}+ sessions share slug '${args.session_id}'; showing the most recent. Others: ${candidates
                  .slice(1)
                  .map((c) => `${c.id} (${c.title.slice(0, 40)}, ${fmtDate(c.time_updated)})`)
                  .join("; ")}\n`
              : ""
          const messages = srcDb
            .query(
              `SELECT id, json_extract(data,'$.role') role, time_created
               FROM message WHERE session_id=? ORDER BY time_created, id`,
            )
            .all(s.id) as MsgRow[]
          if (!messages.length) return `Session ${s.id} has no messages.`

          const window = Math.max(2, Math.min(args.window ?? 12, 60))
          const maxChars = Math.max(100, Math.min(args.max_chars ?? 800, 4000))
          let center = messages.length - 1
          if (args.message_id) {
            const i = messages.findIndex((m) => m.id === args.message_id)
            if (i >= 0) center = i
          }
          const start = Math.max(0, Math.min(center - Math.floor(window / 2), messages.length - window))
          const slice = messages.slice(start, start + window)

          const lines: string[] = [
            ambiguous + `# ${s.title}`,
            `session_id=${s.id} slug=${s.slug} · ${shortDir(s.directory)} · ${fmtDate(s.time_created)} → ${fmtDate(s.time_updated)}`,
            `messages ${start + 1}-${start + slice.length} of ${messages.length}`,
            "",
          ]
          let budget = 20_000
          for (const m of slice) {
            const rendered = renderMessage(m, maxChars)
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

      recall_summarize: tool({
        description:
          "Summarize an entire past OpenCode session — or answer a focused question about it — without reading the transcript yourself. Offloads to a cheap, fast, large-context model (GLM-5.2 via OpenCode Go) in an ephemeral tool-less worker session; results are cached so repeat calls are instant. Prefer this over paging recall_expand when you need the story of a whole session ('what did we do/decide there?'); use recall_expand for verbatim excerpts.",
        args: {
          session_id: tool.schema.string().describe("Session id (ses_...) or slug from recall_search"),
          focus: tool.schema
            .string()
            .optional()
            .describe(
              "Optional question to answer from the session instead of a general summary, e.g. 'what did we decide about auth?'",
            ),
          refresh: tool.schema.boolean().optional().describe("Bypass the cache and re-summarize (default false)"),
        },
        async execute(args) {
          if (!client?.session)
            return "recall_summarize is unavailable: no opencode server client in this context."
          const candidates = findSession(args.session_id)
          const s = candidates[0]
          if (!s) return `No session found for '${args.session_id}'.`
          const ambiguous =
            s.id !== args.session_id && candidates.length > 1
              ? `NOTE: ${candidates.length}+ sessions share slug '${args.session_id}'; summarizing the most recent (${s.id}).\n`
              : ""
          const focus = (args.focus ?? "").trim()
          const modelTag = `${SUMMARY_MODEL.providerID}/${SUMMARY_MODEL.modelID}`
          const header =
            ambiguous +
            `# ${s.title}\nsession_id=${s.id} slug=${s.slug} · ${shortDir(s.directory)} · ${fmtDate(s.time_created)} → ${fmtDate(s.time_updated)}`

          const cached = idxDb
            .query(`SELECT time_updated, summary, created FROM summaries WHERE session_id=? AND model=? AND focus=?`)
            .get(s.id, modelTag, focus) as { time_updated: number; summary: string; created: number } | null
          if (cached && cached.time_updated === s.time_updated && !args.refresh)
            return {
              title: `recall summary: ${s.title}`,
              output: `${header}\n(cached ${fmtDateTime(cached.created)} · ${modelTag}${focus ? ` · focus: ${focus}` : ""})\n\n${cached.summary}`,
            }

          const { text: transcript, messages } = fullTranscript(s.id, SUMMARY_CHAR_BUDGET)
          if (!transcript) return `Session ${s.id} has no transcript content.`
          const system = focus
            ? "You answer questions about a recorded OpenCode agent session transcript. Answer ONLY from the transcript. Be specific: name files, commands, ids, and decisions. If the transcript does not contain the answer, say so plainly. No preamble."
            : "You summarize recorded OpenCode agent session transcripts. Produce a tight summary structured as: Goal; What was done (bullets); Key decisions & why; Gotchas/discoveries; Final state; Loose ends. Be specific — name files, commands, and ids. At most 350 words. No preamble."
          const task = `${focus ? `QUESTION: ${focus}` : "Summarize this session."}\n\nSESSION: ${s.title} (${shortDir(s.directory)}, ${fmtDate(s.time_created)})\nTRANSCRIPT:\n${transcript}`

          const t0 = performance.now()
          const created = await client.session.create({ body: { title: `${WORKER_PREFIX}${s.id}` } })
          const worker: string | undefined = created?.data?.id
          if (!worker)
            return `Failed to create summarizer worker session: ${clean(JSON.stringify(created?.error ?? created ?? null), 300)}`
          let summary = ""
          try {
            const res: any = await Promise.race([
              client.session.prompt({
                path: { id: worker },
                body: {
                  model: SUMMARY_MODEL,
                  system,
                  tools: { "*": false },
                  parts: [{ type: "text", text: task }],
                },
              }),
              Bun.sleep(SUMMARY_TIMEOUT_MS).then(() => {
                throw new Error(`summarizer timed out after ${SUMMARY_TIMEOUT_MS / 1000}s`)
              }),
            ])
            if (res?.error) throw new Error(clean(JSON.stringify(res.error), 300))
            const parts: any[] = res?.data?.parts ?? []
            summary = parts
              .filter((p) => p.type === "text" && typeof p.text === "string")
              .map((p) => p.text)
              .join("\n")
              .trim()
            if (!summary) {
              const err = res?.data?.info?.error
              throw new Error(err ? clean(JSON.stringify(err), 300) : "summarizer returned no text")
            }
          } catch (e) {
            log("summarize failed", s.id, e)
            return `Summarization failed: ${e instanceof Error ? e.message : String(e)}`
          } finally {
            void client.session
              .delete({ path: { id: worker } })
              .catch((e: unknown) => log("summarizer worker delete failed", worker, e))
          }
          idxDb.run(
            `INSERT INTO summaries(session_id,model,focus,time_updated,summary,created) VALUES (?,?,?,?,?,?)
             ON CONFLICT(session_id,model,focus) DO UPDATE SET time_updated=excluded.time_updated,
               summary=excluded.summary, created=excluded.created`,
            [s.id, modelTag, focus, s.time_updated, summary, Date.now()],
          )
          const secs = ((performance.now() - t0) / 1000).toFixed(1)
          return {
            title: `recall summary: ${s.title}`,
            output: `${header}\n(fresh · ${modelTag} · ${messages} messages · ${secs}s${focus ? ` · focus: ${focus}` : ""})\n\n${summary}`,
          }
        },
      }),

      recall_status: tool({
        description:
          "Show the recall conversation-index status: sessions/chunks indexed, backfill progress, embedding model state, and storage size. Use to check indexing health or explain missing recall_search results.",
        args: {},
        async execute() {
          const counts = indexCounts()
          let size = 0
          try {
            size = fs.statSync(path.join(DATA_DIR, "index.db")).size
          } catch {}
          const lines = [
            `sessions indexed: ${counts.indexed}/${counts.total}`,
            `embedded chunks: ${counts.chunks}`,
            `fts rows: ${(idxDb.query(`SELECT count(*) c FROM parts_indexed`).get() as { c: number }).c}`,
            `backfill: ${backfillState.running ? `running ${backfillState.done}/${backfillState.total}` : backfillState.lastRun ? `idle (last run ${fmtDateTime(backfillState.lastRun)})` : "not yet run"}`,
            backfillState.lastError ? `last error: ${clean(backfillState.lastError, 200)}` : "",
            `model: ${MODEL} (${DIMS}d, q8) — ${embedderP ? "loaded" : "not loaded"}`,
            `summaries cached: ${(idxDb.query(`SELECT count(*) c FROM summaries`).get() as { c: number }).c} (${SUMMARY_MODEL.providerID}/${SUMMARY_MODEL.modelID})`,
            `index size: ${(size / 1024 / 1024).toFixed(1)} MB at ${shortDir(DATA_DIR)}`,
            `process RSS: ${Math.round(process.memoryUsage.rss() / 1024 / 1024)} MB`,
          ].filter(Boolean)
          return { title: "recall status", output: lines.join("\n") }
        },
      }),
    },
  }
}

export default RecallPlugin
