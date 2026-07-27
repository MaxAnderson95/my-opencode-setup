/**
 * Everything that knows the shape of opencode's own database.
 *
 * The source DB is opened read-only and is never written to; keeping all
 * knowledge of its schema behind this module means a change upstream has one
 * place to be absorbed.
 */
import type { Database } from "bun:sqlite"
import { clean, fmtDateTime, stripAnsi } from "./text.ts"

export type SessionRow = {
  id: string
  slug: string
  title: string
  directory: string
  parent_id?: string | null
  time_created: number
  time_updated: number
}

export type MsgRow = { id: string; role: string | null; time_created: number }
export type PartRow = { id: string; message_id: string; data: string }

/** A part reduced to the text recall indexes, or null if it carries none. */
export type PartText = { kind: "text" | "reasoning" | "tool"; text: string }

export type ExtractOpts = { toolOutputChars: number; skipTools?: ReadonlySet<string> }

/**
 * Derive indexable text from a part's JSON payload.
 *
 * Used both when writing the index and when regenerating a snippet from the
 * source, so the offsets stored at index time stay meaningful.
 */
export function extractPartText(data: unknown, opts: ExtractOpts): PartText | null {
  const d = data as any
  if (!d || typeof d !== "object") return null
  if (d.type === "text" && typeof d.text === "string" && d.text.trim()) return { kind: "text", text: d.text }
  if (d.type === "reasoning" && typeof d.text === "string" && d.text.trim())
    return { kind: "reasoning", text: d.text }
  if (d.type === "tool" && d.state?.status === "completed") {
    if (opts.skipTools?.has(d.tool)) return null
    const out = typeof d.state.output === "string" ? stripAnsi(d.state.output) : ""
    const title = typeof d.state.title === "string" ? d.state.title : ""
    const text = `${d.tool ?? "tool"} ${title}\n${out}`.slice(0, opts.toolOutputChars)
    if (text.trim()) return { kind: "tool", text }
  }
  return null
}

export function parseJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

export class Source {
  constructor(private db: Database) {}

  session(id: string): SessionRow | null {
    return this.db
      .query(
        `SELECT id, slug, title, directory, parent_id, time_created, time_updated FROM session WHERE id=?`,
      )
      .get(id) as SessionRow | null
  }

  /** Resolve a ses_ id or a slug. Slugs are not unique; an exact id wins, else newest. */
  findSession(idOrSlug: string): SessionRow[] {
    return this.db
      .query(
        `SELECT id, slug, title, directory, time_created, time_updated FROM session
         WHERE id=? OR slug=? ORDER BY (id=?) DESC, time_updated DESC LIMIT 5`,
      )
      .all(idOrSlug, idOrSlug, idOrSlug) as SessionRow[]
  }

  allSessions(): { id: string; t: number }[] {
    return this.db.query(`SELECT id, time_updated t FROM session ORDER BY time_updated DESC`).all() as {
      id: string
      t: number
    }[]
  }

  sessionCount(): number {
    return (this.db.query(`SELECT count(*) c FROM session`).get() as { c: number }).c
  }

  messages(sessionId: string): MsgRow[] {
    return this.db
      .query(
        `SELECT id, json_extract(data,'$.role') role, time_created
         FROM message WHERE session_id=? ORDER BY time_created, id`,
      )
      .all(sessionId) as MsgRow[]
  }

  messageCount(sessionId: string): number {
    return (this.db.query(`SELECT count(*) c FROM message WHERE session_id=?`).get(sessionId) as { c: number }).c
  }

  parts(sessionId: string): PartRow[] {
    return this.db
      .query(`SELECT id, message_id, data FROM part WHERE session_id=? ORDER BY time_created, id`)
      .all(sessionId) as PartRow[]
  }

  partData(partId: string): unknown {
    const row = this.db.query(`SELECT data FROM part WHERE id=?`).get(partId) as { data: string } | null
    return row ? parseJson(row.data) : null
  }

  /** Time of the latest compaction summary message, or 0 if the session was never compacted. */
  compactionBoundary(sessionId: string): number {
    try {
      const row = this.db
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

  /** Chronological user turns: a session's intent skeleton. */
  userTurns(sessionId: string): { id: string; t: number; txt: string }[] {
    const rows = this.db
      .query(
        `SELECT m.id, m.time_created t,
                (SELECT json_extract(p.data,'$.text') FROM part p
                 WHERE p.message_id=m.id AND json_extract(p.data,'$.type')='text'
                 ORDER BY p.time_created, p.id LIMIT 1) txt
         FROM message m
         WHERE m.session_id=? AND json_extract(m.data,'$.role')='user'
         ORDER BY m.time_created, m.id`,
      )
      .all(sessionId) as { id: string; t: number; txt: string | null }[]
    return rows.filter((r): r is { id: string; t: number; txt: string } => !!r.txt?.trim())
  }

  /** One transcript block per message: collapsed tool one-liners plus trimmed text. */
  renderMessage(m: MsgRow, maxChars: number): string | null {
    const parts = this.db
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
      const d = parseJson(p.data) as any
      if (!d) continue
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
    }
    flushTool()
    const body = [...tools, texts.length ? clean(texts.join("\n"), maxChars) : ""].filter(Boolean).join("\n")
    if (!body) return null
    return `── ${m.role ?? "assistant"} @ ${fmtDateTime(m.time_created)} (${m.id})\n${body}`
  }
}
