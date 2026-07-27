/**
 * Retrieval: a lexical branch over FTS5/BM25, a semantic branch over an
 * in-memory embedding matrix, and Reciprocal Rank Fusion over the two.
 *
 * Hits are carried as references to their source (an indexed part segment, or
 * an embedded chunk) and only resolved to display text for the handful that are
 * actually shown. Snippets come from opencode's own database, since a
 * contentless FTS table keeps no copy of the text to snip.
 */
import type { Database } from "bun:sqlite"
import type { Config } from "./config.ts"
import type { Embedder } from "./embedder.ts"
import { Source, extractPartText } from "./source.ts"
import { ftsQuery, makeSnippet, queryTokens } from "./text.ts"

export type HitSource =
  | { kind: "part"; part_id: string; seg_start: number; part_kind: string }
  | { kind: "chunk"; chunk_id: number }

export type Hit = {
  session_id: string
  message_id: string
  time: number
  via: string
  src: HitSource
}

export type Filters = {
  since: number
  until: number
  includeTools: boolean
  /** Substring match on the session's working directory. */
  directory?: string
  /** Restrict to a single session. */
  sessionId?: string
  /**
   * The calling session, whose content the model can already see. Hits from it
   * are dropped unless they predate `excludeBefore`.
   */
  excludeSession?: string
  /** Time of the calling session's last compaction; 0 means never compacted. */
  excludeBefore: number
}

export class SearchIndex {
  private matrix: Matrix | null = null
  private lexStmts = new Map<string, ReturnType<Database["prepare"]>>()

  constructor(
    private idx: Database,
    private source: Source,
    private embedder: Embedder,
    private config: Config,
    private log: (...args: unknown[]) => void,
  ) {}

  /**
   * Every filter is applied inside the SQL, not after it.
   *
   * A post-filter over a fixed top-N BM25 cut silently loses hits: for a term
   * that is common across the corpus, the best-ranked rows can all belong to
   * sessions the filters exclude, and the query returns nothing while matches
   * exist.
   */
  private lexicalStatement(f: Filters) {
    const where: string[] = ["fts MATCH ?"]
    if (f.sessionId) where.push("p.session_id = ?")
    if (f.directory) where.push("s.directory LIKE ?")
    if (!f.includeTools) where.push("p.kind <> 'tool'")
    where.push("p.time BETWEEN ? AND ?")
    if (f.excludeSession) where.push("NOT (p.session_id = ? AND p.time >= ?)")
    const sql = `SELECT p.session_id, p.message_id, p.part_id, p.kind, p.seg_start, CAST(p.time AS INTEGER) time
       FROM fts
       JOIN parts p ON p.id = fts.rowid
       JOIN sessions s ON s.id = p.session_id
       WHERE ${where.join(" AND ")}
       ORDER BY rank LIMIT ?`
    let stmt = this.lexStmts.get(sql)
    if (!stmt) {
      stmt = this.idx.prepare(sql)
      this.lexStmts.set(sql, stmt)
    }
    return stmt
  }

  private lexicalArgs(match: string, f: Filters): unknown[] {
    const args: unknown[] = [match]
    if (f.sessionId) args.push(f.sessionId)
    if (f.directory) args.push(`%${f.directory}%`)
    args.push(f.since, f.until)
    if (f.excludeSession) args.push(f.excludeSession, f.excludeBefore)
    args.push(this.config.search.candidates)
    return args
  }

  lexical(query: string, f: Filters): Hit[] {
    const run = (match: string): Hit[] => {
      const rows = this.lexicalStatement(f).all(...(this.lexicalArgs(match, f) as any[])) as {
        session_id: string
        message_id: string
        part_id: string
        kind: string
        seg_start: number
        time: number
      }[]
      return rows.map((r) => ({
        session_id: r.session_id,
        message_id: r.message_id,
        time: r.time,
        via: `lexical/${r.kind}`,
        src: { kind: "part", part_id: r.part_id, seg_start: r.seg_start, part_kind: r.kind } as HitSource,
      }))
    }
    const andQ = ftsQuery(query, "AND")
    if (!andQ) return []
    try {
      const hits = run(andQ)
      if (hits.length || !/\s/.test(query.trim())) return hits
      const orQ = ftsQuery(query, "OR")
      return orQ ? run(orQ) : []
    } catch (e) {
      this.log("lexical search error", e)
      return []
    }
  }

  async semantic(query: string, f: Filters): Promise<Hit[]> {
    const dims = this.config.embed.dims
    const [qvec] = await this.embedder.embed([this.config.embed.queryPrefix + query])
    const m = this.loadMatrix()
    const allow = f.directory ? this.sessionsInDirectory(f.directory) : null
    const scored: { score: number; i: number }[] = []
    for (let i = 0; i < m.n; i++) {
      const t = m.times[i]
      if (t < f.since || t > f.until) continue
      const sid = m.sessions[i]
      if (f.sessionId && sid !== f.sessionId) continue
      if (f.excludeSession === sid && t >= f.excludeBefore) continue
      if (allow && !allow.has(sid)) continue
      scored.push({ score: dot(qvec, m.mat, i * dims, dims), i })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, this.config.search.candidates).map((t) => ({
      session_id: m.sessions[t.i],
      message_id: m.messages[t.i],
      time: m.times[t.i],
      via: `semantic ${t.score.toFixed(2)}`,
      src: { kind: "chunk", chunk_id: m.ids[t.i] } as HitSource,
    }))
  }

  /** Cosine score parsed back out of a semantic hit's `via` label. */
  static semanticScore(hit: Hit): number {
    return hit.via.startsWith("semantic ") ? parseFloat(hit.via.slice(9)) : 0
  }

  private sessionsInDirectory(directory: string): Set<string> {
    const rows = this.idx.query(`SELECT id FROM sessions WHERE directory LIKE ?`).all(`%${directory}%`) as {
      id: string
    }[]
    return new Set(rows.map((r) => r.id))
  }

  /**
   * Resolve display snippets for the hits that will actually be shown.
   *
   * Part-backed hits are re-read from the source database, so the excerpt comes
   * from the untruncated original rather than from a stored copy.
   */
  snippets(hits: Hit[], query: string, width = 220): Map<Hit, string> {
    const tokens = queryTokens(query)
    const out = new Map<Hit, string>()
    const chunkIds = hits.flatMap((h) => (h.src.kind === "chunk" ? [h.src.chunk_id] : []))
    const chunkText = new Map<number, string>()
    if (chunkIds.length) {
      const rows = this.idx
        .query(`SELECT id, text FROM chunks WHERE id IN (${chunkIds.map(() => "?").join(",")})`)
        .all(...chunkIds) as { id: number; text: string }[]
      for (const r of rows) chunkText.set(r.id, r.text)
    }
    for (const h of hits) {
      if (h.src.kind === "chunk") {
        out.set(h, makeSnippet(chunkText.get(h.src.chunk_id) ?? "", tokens, width))
        continue
      }
      const data = this.source.partData(h.src.part_id)
      const extracted = data
        ? extractPartText(data, { toolOutputChars: this.config.fts.toolOutputChars })
        : null
      if (!extracted) {
        out.set(h, "(source part no longer available)")
        continue
      }
      const seg = extracted.text.slice(h.src.seg_start, h.src.seg_start + this.config.fts.segmentChars)
      out.set(h, makeSnippet(seg, tokens, width))
    }
    return out
  }

  /**
   * In-memory embedding matrix, rebuilt only when the chunks table changes.
   * Chunk ids come from an AUTOINCREMENT column and are never reused, so
   * (row count, max id) cannot repeat for different contents: any content
   * change requires an insert, which raises max id, and any pure delete lowers
   * the count. `matrixSignature` exists so a test can pin that property.
   */
  private loadMatrix(): Matrix {
    const dims = this.config.embed.dims
    const sig = this.matrixSignature()
    if (this.matrix?.sig === sig) return this.matrix
    const count = Number(sig.split(":")[0])
    const next: Matrix = {
      sig,
      n: count,
      mat: new Float32Array(count * dims),
      ids: new Float64Array(count),
      times: new Float64Array(count),
      sessions: new Array(count),
      messages: new Array(count),
    }
    const page = this.idx.prepare(
      `SELECT id, session_id, message_id, time, emb FROM chunks WHERE id > ? ORDER BY id LIMIT 4000`,
    )
    let i = 0
    let lastId = 0
    while (i < count) {
      const rows = page.all(lastId) as {
        id: number
        session_id: string
        message_id: string
        time: number
        emb: Uint8Array
      }[]
      if (!rows.length) break
      for (const r of rows) {
        lastId = r.id
        next.mat.set(toVec(r.emb, dims), i * dims)
        next.ids[i] = r.id
        next.times[i] = r.time
        next.sessions[i] = r.session_id
        next.messages[i] = r.message_id
        i++
      }
    }
    next.n = i
    this.matrix = next
    return next
  }

  matrixSignature(): string {
    const s = this.idx.query(`SELECT count(*) c, COALESCE(max(id),0) m FROM chunks`).get() as {
      c: number
      m: number
    }
    return `${s.c}:${s.m}`
  }
}

type Matrix = {
  sig: string
  n: number
  mat: Float32Array
  ids: Float64Array
  times: Float64Array
  sessions: string[]
  messages: string[]
}

function toVec(blob: Uint8Array, dims: number): Float32Array {
  if (blob.byteOffset % 4 === 0 && blob.byteLength === dims * 4)
    return new Float32Array(blob.buffer, blob.byteOffset, dims)
  return new Float32Array(blob.slice().buffer, 0, dims)
}

/** Vectors are stored L2-normalised, so the dot product is the cosine. */
function dot(q: Float32Array, mat: Float32Array, offset: number, dims: number): number {
  let s = 0
  for (let i = 0; i < dims; i++) s += q[i] * mat[offset + i]
  return s
}

export type FusedGroup<K> = { key: K; score: number; hits: Hit[]; nLex: number; nSem: number }

/**
 * Reciprocal Rank Fusion.
 *
 * `keyOf` decides the unit being ranked (a session for corpus search, a message
 * for within-session search). `perBranchCap` limits how many hits from one
 * branch may contribute to a key's score, so a flood of weak matches cannot
 * outrank a single strong one.
 */
export function fuse<K>(
  branches: { hits: Hit[]; which: "lex" | "sem" }[],
  keyOf: (h: Hit) => K,
  opts: { rrfK: number; perBranchCap?: number; hitsPerKey?: number },
): FusedGroup<K>[] {
  const groups = new Map<K, FusedGroup<K>>()
  const cap = opts.perBranchCap ?? Infinity
  const hitsPerKey = opts.hitsPerKey ?? 1
  for (const { hits, which } of branches) {
    hits.forEach((h, rank) => {
      const key = keyOf(h)
      let g = groups.get(key)
      if (!g) {
        g = { key, score: 0, hits: [], nLex: 0, nSem: 0 }
        groups.set(key, g)
      }
      const seenInBranch = which === "lex" ? g.nLex : g.nSem
      if (seenInBranch < cap) g.score += 1 / (opts.rrfK + rank)
      if (g.hits.length < hitsPerKey && !g.hits.some((x) => x.message_id === h.message_id)) g.hits.push(h)
      if (which === "lex") g.nLex++
      else g.nSem++
    })
  }
  return [...groups.values()].sort((a, b) => b.score - a.score)
}
