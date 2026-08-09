/**
 * Builds and maintains the sidecar index.
 *
 * Indexing is idempotent per session: a session is deleted from the index and
 * rewritten in one transaction, with embeddings reused across rebuilds by
 * content hash so re-indexing a growing session costs only its new turns.
 */
import type { Database } from "bun:sqlite"
import type { Config } from "./config.ts"
import type { Embedder } from "./embedder.ts"
import type { DirectoryExclusions } from "./exclusions.ts"
import { BackfillAnnouncer, noopNotify, type Notify } from "./notify.ts"
import { Source, extractPartText, parseJson, type SessionRow } from "./source.ts"
import { chunkText, clean, segmentText } from "./text.ts"

/**
 * Backfills at least this large finish with an FTS merge. Measured on a 287k-row
 * index: 1.5s of work for a 17% cut in lexical p95 and 4x in snippet p95.
 */
const OPTIMIZE_MIN_SESSIONS = 200

export type IndexerDeps = {
  idx: Database
  source: Source
  embedder: Embedder
  config: Config
  exclusions: DirectoryExclusions
  log: (...args: unknown[]) => void
  /** Tool names whose output must never be indexed (recall's own, to avoid meta-noise). */
  skipTools: ReadonlySet<string>
  /** Session titles with this prefix are recall's ephemeral summarizer workers. */
  workerPrefix: string
  notify?: Notify
  /** Set when this process reset the index at startup, so the rebuild can say so. */
  afterReset?: boolean
}

export type BackfillState = {
  running: boolean
  total: number
  done: number
  lastError: string
  lastRun: number
  skippedLocked: boolean
}

type PendingPart = {
  message_id: string
  part_id: string
  kind: string
  role: string
  time: number
  seg_start: number
  text: string
}

type PendingChunk = { message_id: string; time: number; text: string; hash: string }

export class Indexer {
  readonly state: BackfillState = {
    running: false,
    total: 0,
    done: 0,
    lastError: "",
    lastRun: 0,
    skippedLocked: false,
  }
  private inFlight = new Set<string>()
  private stmts: ReturnType<typeof this.prepare> | null = null

  constructor(private d: IndexerDeps) {}

  /**
   * Statements are prepared once and reused. The previous implementation called
   * `db.run(sql, args)` inside the per-row write loops, which re-compiled every
   * statement for each of the ~265k indexed rows during a full backfill.
   */
  private prepare() {
    const db = this.d.idx
    return {
      delFts: db.prepare(`DELETE FROM fts WHERE rowid IN (SELECT id FROM parts WHERE session_id=?)`),
      delParts: db.prepare(`DELETE FROM parts WHERE session_id=?`),
      delChunks: db.prepare(`DELETE FROM chunks WHERE session_id=?`),
      delIndexed: db.prepare(`DELETE FROM indexed_sessions WHERE session_id=?`),
      delSession: db.prepare(`DELETE FROM sessions WHERE id=?`),
      insPart: db.prepare(
        `INSERT INTO parts(session_id,message_id,part_id,kind,role,time,seg_start) VALUES (?,?,?,?,?,?,?)`,
      ),
      insFts: db.prepare(`INSERT INTO fts(rowid,text) VALUES (?,?)`),
      insChunk: db.prepare(
        `INSERT INTO chunks(session_id,message_id,time,hash,text,emb) VALUES (?,?,?,?,?,?)`,
      ),
      upsertSession: db.prepare(
        `INSERT INTO sessions(id,slug,title,directory,parent_id,time_created,time_updated)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET slug=excluded.slug, title=excluded.title,
           directory=excluded.directory, parent_id=excluded.parent_id, time_updated=excluded.time_updated`,
      ),
      upsertIndexed: db.prepare(
        `INSERT INTO indexed_sessions(session_id,time_updated,chunks,fts_rows) VALUES (?,?,?,?)
         ON CONFLICT(session_id) DO UPDATE SET time_updated=excluded.time_updated,
           chunks=excluded.chunks, fts_rows=excluded.fts_rows`,
      ),
      priorEmb: db.prepare(`SELECT hash, emb FROM chunks WHERE session_id=?`),
      watermark: db.prepare(`SELECT time_updated t FROM indexed_sessions WHERE session_id=?`),
    }
  }

  private get s() {
    return (this.stmts ??= this.prepare())
  }

  purge(sessionId: string, includeSummary = false): void {
    const run = this.d.idx.transaction(() => {
      this.s.delFts.run(sessionId)
      this.s.delParts.run(sessionId)
      this.s.delChunks.run(sessionId)
      this.s.delIndexed.run(sessionId)
      this.s.delSession.run(sessionId)
      if (includeSummary) this.d.idx.run(`DELETE FROM summaries WHERE session_id=?`, [sessionId])
    })
    run()
  }

  /** Collect the FTS rows and embeddable chunks for a session, without writing. */
  private plan(s: SessionRow): { parts: PendingPart[]; chunks: PendingChunk[] } {
    const cfg = this.d.config
    const messages = this.d.source.messages(s.id)
    const roleOf = new Map(messages.map((m) => [m.id, m.role ?? "assistant"]))
    const parts: PendingPart[] = []
    const textByMessage = new Map<string, string[]>()

    for (const p of this.d.source.parts(s.id)) {
      const data = parseJson(p.data)
      if (!data) continue
      const extracted = extractPartText(data, {
        toolOutputChars: cfg.fts.toolOutputChars,
        skipTools: this.d.skipTools,
      })
      if (!extracted) continue
      const role = roleOf.get(p.message_id) ?? "assistant"
      const d = data as any
      const time = d.time?.start ?? d.time?.created ?? s.time_created

      // Long parts are segmented rather than truncated so nothing becomes
      // unsearchable and BM25 length normalisation stays meaningful.
      for (const seg of segmentText(extracted.text, cfg.fts.segmentChars)) {
        parts.push({
          message_id: p.message_id,
          part_id: p.id,
          kind: extracted.kind,
          role,
          time,
          seg_start: seg.start,
          text: seg.text,
        })
      }
      if (extracted.kind === "text") {
        const arr = textByMessage.get(p.message_id) ?? []
        arr.push(extracted.text)
        textByMessage.set(p.message_id, arr)
      }
    }

    // Turn-pairs: a user message plus every assistant message that follows it.
    type Turn = { message_id: string; time: number; user: string[]; assistant: string[] }
    const turns: Turn[] = []
    let cur: Turn | null = null
    for (const m of messages) {
      const texts = textByMessage.get(m.id)
      if (m.role === "user") {
        cur = { message_id: m.id, time: m.time_created, user: texts ?? [], assistant: [] }
        turns.push(cur)
      } else if (texts) {
        if (!cur) {
          cur = { message_id: m.id, time: m.time_created, user: [], assistant: [] }
          turns.push(cur)
        }
        cur.assistant.push(...texts)
      }
    }

    const chunks: PendingChunk[] = []
    for (const t of turns) {
      const user = t.user.join("\n").trim()
      const assistant = t.assistant.join("\n").trim()
      if (!user && !assistant) continue
      const body = (user ? `USER: ${user}\n` : "") + (assistant ? `ASSISTANT: ${assistant}` : "")
      const windows = chunkText(body, cfg.chunk.chars, cfg.chunk.overlap, cfg.chunk.maxPerTurn)
      // Windows past the first lose the turn's subject, so re-anchor them to the
      // user's intent; a bare slice of mid-turn prose retrieves poorly on its own.
      const anchor = user ? `(re: ${clean(user, 160)})\n` : ""
      windows.forEach((w, i) => {
        const text = i === 0 ? w : anchor + w
        chunks.push({ message_id: t.message_id, time: t.time, text, hash: String(Bun.hash(text)) })
      })
    }
    return { parts, chunks }
  }

  async indexSession(sessionId: string): Promise<void> {
    if (this.inFlight.has(sessionId)) return
    this.inFlight.add(sessionId)
    try {
      const s = this.d.source.session(sessionId)
      if (!s) {
        this.purge(sessionId)
        return
      }
      if (this.d.exclusions.matches(s.directory)) {
        this.purge(sessionId, true)
        return
      }
      if (s.title?.startsWith(this.d.workerPrefix)) return
      const wm = this.s.watermark.get(sessionId) as { t: number } | null
      if (wm && wm.t >= s.time_updated) return

      const { parts, chunks } = this.plan(s)

      const prior = new Map(
        (this.s.priorEmb.all(sessionId) as { hash: string; emb: Uint8Array }[]).map((r) => [r.hash, r.emb]),
      )
      const need: PendingChunk[] = []
      const queued = new Set<string>()
      for (const c of chunks) {
        if (prior.has(c.hash) || queued.has(c.hash)) continue
        queued.add(c.hash)
        need.push(c)
      }
      const fresh = new Map<string, Uint8Array>()
      if (need.length) {
        const vecs = await this.d.embedder.embed(need.map((c) => c.text))
        need.forEach((c, i) => {
          const v = vecs[i]
          fresh.set(c.hash, new Uint8Array(v.buffer, v.byteOffset, this.d.config.embed.dims * 4))
        })
      }

      // The config can change while embeddings are being generated.
      if (this.d.exclusions.matches(s.directory)) {
        this.purge(sessionId, true)
        return
      }

      const write = this.d.idx.transaction(() => {
        this.s.delFts.run(sessionId)
        this.s.delParts.run(sessionId)
        this.s.delChunks.run(sessionId)
        for (const c of chunks) {
          const emb = fresh.get(c.hash) ?? prior.get(c.hash)
          if (!emb) continue
          this.s.insChunk.run(sessionId, c.message_id, c.time, c.hash, c.text, emb)
        }
        for (const p of parts) {
          const res = this.s.insPart.run(
            sessionId,
            p.message_id,
            p.part_id,
            p.kind,
            p.role,
            p.time,
            p.seg_start,
          )
          this.s.insFts.run(Number(res.lastInsertRowid), p.text)
        }
        this.s.upsertSession.run(
          s.id,
          s.slug,
          s.title,
          s.directory,
          s.parent_id ?? null,
          s.time_created,
          s.time_updated,
        )
        this.s.upsertIndexed.run(sessionId, s.time_updated, chunks.length, parts.length)
      })
      write()
    } finally {
      this.inFlight.delete(sessionId)
    }
  }

  /**
   * Catch up on every session whose source watermark is newer than the index.
   * `lease` gates the pass so concurrent opencode processes do not each redo it.
   */
  async backfill(lease?: { tryAcquire(): boolean; heartbeat(): void; release(): void }): Promise<void> {
    if (this.state.running) return
    if (lease && !lease.tryAcquire()) {
      this.state.skippedLocked = true
      this.d.log("backfill skipped: another process holds the lease")
      return
    }
    this.state.skippedLocked = false
    this.state.running = true
    this.state.lastRun = Date.now()
    try {
      const allSource = this.d.source.allSessions()
      const source = allSource.filter((s) => !this.d.exclusions.matches(s.directory))
      const wms = new Map(
        (
          this.d.idx.query(`SELECT session_id s, time_updated t FROM indexed_sessions`).all() as {
            s: string
            t: number
          }[]
        ).map((r) => [r.s, r.t]),
      )
      const stale = source.filter((s) => (wms.get(s.id) ?? 0) < s.t)
      this.state.total = stale.length
      this.state.done = 0
      const announcer = new BackfillAnnouncer(this.d.notify ?? noopNotify, this.d.config.notify)
      if (stale.length) {
        this.d.log(`backfill: ${stale.length} stale sessions`)
        announcer.start(stale.length, { afterReset: this.d.afterReset })
      }
      let lastBeat = Date.now()
      for (const s of stale) {
        try {
          await this.indexSession(s.id)
        } catch (e) {
          this.state.lastError = `${s.id}: ${e}`
          this.d.log("backfill index error", s.id, e)
        }
        this.state.done++
        announcer.progress(this.state.done)
        if (lease && Date.now() - lastBeat > 20_000) {
          lease.heartbeat()
          lastBeat = Date.now()
        }
        // A full rebuild parses every part of every session; without periodic
        // collection the JSON garbage accumulates for the whole pass.
        if (this.state.done % 250 === 0) Bun.gc(false)
        await Bun.sleep(15)
      }
      const alive = new Set(source.map((s) => s.id))
      for (const [sid] of wms) if (!alive.has(sid)) this.purge(sid)
      for (const s of allSource) if (this.d.exclusions.matches(s.directory)) this.purge(s.id, true)
      if (stale.length) {
        // A bulk load leaves the FTS index in many small segments. Merging them
        // is seconds of work and measurably improves tail latency; not worth it
        // after a routine few-session catch-up.
        if (stale.length >= OPTIMIZE_MIN_SESSIONS) {
          try {
            const t0 = performance.now()
            this.d.idx.run(`INSERT INTO fts(fts) VALUES('optimize')`)
            this.d.idx.run(`PRAGMA wal_checkpoint(TRUNCATE)`)
            this.d.log(`fts optimize took ${Math.round(performance.now() - t0)}ms`)
          } catch (e) {
            this.d.log("fts optimize failed (harmless)", e)
          }
        }
        this.d.log(`backfill complete: ${this.state.done}/${this.state.total}`)
        Bun.gc(true) // release JSON-parse garbage from the one-time bulk pass
        const chunks = (this.d.idx.query(`SELECT count(*) c FROM chunks`).get() as { c: number }).c
        announcer.finish(this.state.done, chunks, this.state.lastError)
      }
    } catch (e) {
      this.state.lastError = String(e)
      this.d.log("backfill failed", e)
    } finally {
      this.state.running = false
      lease?.release()
    }
  }

  /** Remove excluded sessions immediately, including summaries that survive ordinary index purges. */
  reconcileExclusions(): number {
    const excluded = this.d.source.allSessions().filter((s) => this.d.exclusions.matches(s.directory))
    for (const s of excluded) this.purge(s.id, true)
    return excluded.length
  }
}
