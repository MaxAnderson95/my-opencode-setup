/**
 * Everything that knows the shape of opencode's own database.
 *
 * The source DB is opened read-only and is never written to; keeping all
 * knowledge of its schema behind this module means a change upstream has one
 * place to be absorbed.
 *
 * Two generations of storage coexist in the same file:
 *
 *   v2 (primary)  session_v2 + session_message. Messages are single JSON rows
 *                 whose `data` payload carries the whole message: user text
 *                 directly, assistant content as an array of text / reasoning /
 *                 tool items, compaction summaries as their own message type.
 *   v1 (legacy)   session + message + part. Kept only as a fallback for the
 *                 handful of sessions the v1->v2 migration could not carry
 *                 over, and to resolve part ids that older index rows stored.
 *
 * The rest of recall consumes one normalized shape: the v1 part payload
 * (`{type:"text"|"reasoning"|"tool", ...}`). v2 rows are mapped into that
 * shape here, with deterministic synthetic part ids (`<message_id>#<index>`)
 * so a part can be re-read later to regenerate snippets at stored offsets.
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
 * Derive indexable text from a normalized (v1-shaped) part payload.
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

/** v2 message types that carry transcript text; the switch/bookkeeping types do not. */
const V2_TYPES = ["user", "synthetic", "assistant", "compaction", "shell", "skill"] as const
const V2_TYPE_LIST = V2_TYPES.map((t) => `'${t}'`).join(",")

type V2Type = (typeof V2_TYPES)[number]

/**
 * Synthetic messages are injected context (command output, reminders) that in
 * the v1 schema lived inside user messages, where recall indexed them as user
 * text; mapping them to the user role preserves that. Compaction / shell /
 * skill keep their own labels for transcript display and behave as assistant
 * turns during chunking, which only distinguishes user from everything else.
 */
function roleOf(type: string): string {
  if (type === "user" || type === "synthetic") return "user"
  return type
}

const V2_SESSION_COLS = `id, slug, COALESCE(title,'') title, directory, parent_id, time_created, time_updated`
const V1_SESSION_COLS = `id, slug, title, directory, parent_id, time_created, time_updated`

type V2MsgDataRow = { id: string; type: string; time_created: number; data: string }

/** The normalized part payload plus the content index it was derived from. */
type SynthPart = { index: number; payload: Record<string, unknown> }

/** Compact, deterministic one-liner standing in for v1's tool state title. */
function toolTitle(input: unknown, metadata: unknown): string {
  const meta = metadata as Record<string, unknown> | null | undefined
  if (meta && typeof meta.title === "string") return meta.title
  if (!input || typeof input !== "object") return ""
  return Object.values(input as Record<string, unknown>)
    .filter((v): v is string => typeof v === "string")
    .join(" ")
    .slice(0, 200)
}

function toolOutput(state: Record<string, unknown>): string {
  const content = state.content
  if (!Array.isArray(content)) return ""
  return content
    .filter((c): c is { type: string; text: string } => {
      const item = c as Record<string, unknown> | null
      return !!item && item.type === "text" && typeof item.text === "string"
    })
    .map((c) => c.text)
    .join("\n")
}

/**
 * Map one v2 message row into normalized part payloads.
 *
 * The returned `index` is the position in the assistant content array (0 for
 * single-payload message types) and is embedded in the synthetic part id, so
 * skipping unusable items never shifts the ids of the ones that remain.
 */
function synthesizeParts(row: V2MsgDataRow): SynthPart[] {
  const data = parseJson(row.data) as Record<string, unknown> | null
  if (!data) return []
  const startOf = (time: unknown): number => {
    const t = time as { created?: unknown } | null | undefined
    return typeof t?.created === "number" ? t.created : row.time_created
  }
  const msgStart = startOf(data.time)

  if (row.type === "user" || row.type === "synthetic") {
    if (typeof data.text !== "string" || !data.text.trim()) return []
    return [{ index: 0, payload: { type: "text", text: data.text, time: { start: msgStart } } }]
  }

  if (row.type === "compaction") {
    // Only a completed compaction has a summary worth indexing. `recent` is a
    // replay of messages that already exist as their own rows, so it is skipped.
    if (data.status !== "completed" || typeof data.summary !== "string" || !data.summary.trim()) return []
    return [{ index: 0, payload: { type: "text", text: data.summary, time: { start: msgStart } } }]
  }

  if (row.type === "shell") {
    const output = (data.output as { output?: unknown } | null | undefined)?.output
    return [
      {
        index: 0,
        payload: {
          type: "tool",
          tool: "shell",
          state: {
            status: "completed",
            title: typeof data.command === "string" ? data.command : "",
            output: typeof output === "string" ? output : "",
          },
          time: { start: msgStart },
        },
      },
    ]
  }

  if (row.type === "skill") {
    return [
      {
        index: 0,
        payload: {
          type: "tool",
          tool: "skill",
          state: {
            status: "completed",
            title: typeof data.name === "string" ? data.name : "",
            output: typeof data.text === "string" ? data.text : "",
          },
          time: { start: msgStart },
        },
      },
    ]
  }

  if (row.type === "assistant") {
    const content = Array.isArray(data.content) ? data.content : []
    const out: SynthPart[] = []
    content.forEach((raw, index) => {
      const item = raw as Record<string, unknown> | null
      if (!item || typeof item !== "object") return
      if ((item.type === "text" || item.type === "reasoning") && typeof item.text === "string") {
        out.push({
          index,
          payload: {
            type: item.type,
            text: item.text,
            time: { start: item.type === "reasoning" ? startOf(item.time) : msgStart },
          },
        })
        return
      }
      if (item.type === "tool" && typeof item.name === "string") {
        const state = (item.state ?? {}) as Record<string, unknown>
        out.push({
          index,
          payload: {
            type: "tool",
            tool: item.name,
            state: {
              status: typeof state.status === "string" ? state.status : "unknown",
              title: toolTitle(state.input, state.metadata),
              output: state.status === "completed" ? toolOutput(state) : "",
            },
            time: { start: startOf(item.time) },
          },
        })
      }
    })
    return out
  }

  return []
}

export class Source {
  private readonly hasV2: boolean
  private readonly hasV1: boolean

  constructor(private db: Database) {
    const tables = new Set(
      (this.db.query(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map(
        (r) => r.name,
      ),
    )
    this.hasV2 = tables.has("session_v2") && tables.has("session_message")
    this.hasV1 = tables.has("session") && tables.has("message") && tables.has("part")
    if (!this.hasV2 && !this.hasV1)
      throw new Error("source db has neither v2 (session_v2/session_message) nor v1 (session/message/part) tables")
  }

  /**
   * True when the session's messages live in the v2 tables. Migrated sessions
   * exist in both generations with the same id; v2 wins because migration
   * rewrites session_message completely and preserves time_updated.
   */
  private isV2Session(id: string): boolean {
    if (!this.hasV2) return false
    return !!this.db.query(`SELECT 1 FROM session_v2 WHERE id=?`).get(id)
  }

  session(id: string): SessionRow | null {
    if (this.hasV2) {
      const row = this.db
        .query(`SELECT ${V2_SESSION_COLS} FROM session_v2 WHERE id=?`)
        .get(id) as SessionRow | null
      if (row) return row
    }
    if (this.hasV1)
      return this.db.query(`SELECT ${V1_SESSION_COLS} FROM session WHERE id=?`).get(id) as SessionRow | null
    return null
  }

  /** Resolve a ses_ id or a slug. Slugs are not unique; an exact id wins, else newest. */
  findSession(idOrSlug: string): SessionRow[] {
    const rows: SessionRow[] = []
    if (this.hasV2)
      rows.push(
        ...(this.db
          .query(
            `SELECT ${V2_SESSION_COLS} FROM session_v2 WHERE id=? OR slug=?
             ORDER BY time_updated DESC LIMIT 5`,
          )
          .all(idOrSlug, idOrSlug) as SessionRow[]),
      )
    if (this.hasV1) {
      const exclude = this.hasV2 ? `AND id NOT IN (SELECT id FROM session_v2)` : ""
      rows.push(
        ...(this.db
          .query(
            `SELECT ${V1_SESSION_COLS} FROM session WHERE (id=? OR slug=?) ${exclude}
             ORDER BY time_updated DESC LIMIT 5`,
          )
          .all(idOrSlug, idOrSlug) as SessionRow[]),
      )
    }
    rows.sort((a, b) => Number(b.id === idOrSlug) - Number(a.id === idOrSlug) || b.time_updated - a.time_updated)
    return rows.slice(0, 5)
  }

  allSessions(): { id: string; t: number; directory: string }[] {
    type Row = { id: string; t: number; directory: string }
    const rows: Row[] = []
    if (this.hasV2)
      rows.push(...(this.db.query(`SELECT id, time_updated t, directory FROM session_v2`).all() as Row[]))
    if (this.hasV1) {
      const exclude = this.hasV2 ? `WHERE id NOT IN (SELECT id FROM session_v2)` : ""
      rows.push(
        ...(this.db.query(`SELECT id, time_updated t, directory FROM session ${exclude}`).all() as Row[]),
      )
    }
    rows.sort((a, b) => b.t - a.t)
    return rows
  }

  sessionCount(): number {
    let count = 0
    if (this.hasV2) count += (this.db.query(`SELECT count(*) c FROM session_v2`).get() as { c: number }).c
    if (this.hasV1) {
      const exclude = this.hasV2 ? `WHERE id NOT IN (SELECT id FROM session_v2)` : ""
      count += (this.db.query(`SELECT count(*) c FROM session ${exclude}`).get() as { c: number }).c
    }
    return count
  }

  messages(sessionId: string): MsgRow[] {
    if (this.isV2Session(sessionId)) {
      const rows = this.db
        .query(
          `SELECT id, type, time_created FROM session_message
           WHERE session_id=? AND type IN (${V2_TYPE_LIST}) ORDER BY seq`,
        )
        .all(sessionId) as { id: string; type: V2Type; time_created: number }[]
      return rows.map((r) => ({ id: r.id, role: roleOf(r.type), time_created: r.time_created }))
    }
    if (!this.hasV1) return []
    return this.db
      .query(
        `SELECT id, json_extract(data,'$.role') role, time_created
         FROM message WHERE session_id=? ORDER BY time_created, id`,
      )
      .all(sessionId) as MsgRow[]
  }

  messageCount(sessionId: string): number {
    if (this.isV2Session(sessionId))
      return (
        this.db
          .query(`SELECT count(*) c FROM session_message WHERE session_id=? AND type IN (${V2_TYPE_LIST})`)
          .get(sessionId) as { c: number }
      ).c
    if (!this.hasV1) return 0
    return (this.db.query(`SELECT count(*) c FROM message WHERE session_id=?`).get(sessionId) as { c: number }).c
  }

  parts(sessionId: string): PartRow[] {
    if (this.isV2Session(sessionId)) {
      const rows = this.db
        .query(
          `SELECT id, type, time_created, data FROM session_message
           WHERE session_id=? AND type IN (${V2_TYPE_LIST}) ORDER BY seq`,
        )
        .all(sessionId) as V2MsgDataRow[]
      return rows.flatMap((row) =>
        synthesizeParts(row).map((p) => ({
          id: `${row.id}#${p.index}`,
          message_id: row.id,
          data: JSON.stringify(p.payload),
        })),
      )
    }
    if (!this.hasV1) return []
    return this.db
      .query(`SELECT id, message_id, data FROM part WHERE session_id=? ORDER BY time_created, id`)
      .all(sessionId) as PartRow[]
  }

  /**
   * Re-read one part by the id stored in the index. Synthetic v2 ids
   * (`msg_x#n`) are re-derived from the message row; bare `prt_` ids belong to
   * rows indexed before the v2 cutover and resolve against the legacy table.
   */
  partData(partId: string): unknown {
    const hash = partId.indexOf("#")
    if (hash >= 0) {
      const messageId = partId.slice(0, hash)
      const index = Number(partId.slice(hash + 1))
      if (!this.hasV2 || !Number.isInteger(index)) return null
      const row = this.db
        .query(`SELECT id, type, time_created, data FROM session_message WHERE id=?`)
        .get(messageId) as V2MsgDataRow | null
      if (!row) return null
      return synthesizeParts(row).find((p) => p.index === index)?.payload ?? null
    }
    if (!this.hasV1) return null
    const row = this.db.query(`SELECT data FROM part WHERE id=?`).get(partId) as { data: string } | null
    return row ? parseJson(row.data) : null
  }

  /** Time of the latest completed compaction, or 0 if the session was never compacted. */
  compactionBoundary(sessionId: string): number {
    try {
      if (this.isV2Session(sessionId)) {
        const row = this.db
          .query(
            `SELECT max(time_created) t FROM session_message
             WHERE session_id=? AND type='compaction' AND json_extract(data,'$.status')='completed'`,
          )
          .get(sessionId) as { t: number | null } | null
        return row?.t ?? 0
      }
      if (!this.hasV1) return 0
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

  /**
   * Chronological user turns: a session's intent skeleton. Synthetic messages
   * are deliberately excluded here (unlike indexing) so the outline shows what
   * the human actually asked rather than injected command output.
   */
  userTurns(sessionId: string): { id: string; t: number; txt: string }[] {
    if (this.isV2Session(sessionId)) {
      const rows = this.db
        .query(
          `SELECT id, time_created t, json_extract(data,'$.text') txt
           FROM session_message WHERE session_id=? AND type='user' ORDER BY seq`,
        )
        .all(sessionId) as { id: string; t: number; txt: string | null }[]
      return rows.filter((r): r is { id: string; t: number; txt: string } => !!r.txt?.trim())
    }
    if (!this.hasV1) return []
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

  /** All normalized part payloads for one message, in content order. */
  private messagePartPayloads(messageId: string): unknown[] {
    if (this.hasV2) {
      const row = this.db
        .query(`SELECT id, type, time_created, data FROM session_message WHERE id=?`)
        .get(messageId) as V2MsgDataRow | null
      if (row) return synthesizeParts(row).map((p) => p.payload)
    }
    if (!this.hasV1) return []
    const rows = this.db
      .query(`SELECT data FROM part WHERE message_id=? ORDER BY time_created, id`)
      .all(messageId) as { data: string }[]
    return rows.map((r) => parseJson(r.data)).filter((d) => d !== null)
  }

  /** One transcript block per message: collapsed tool one-liners plus trimmed text. */
  renderMessage(m: MsgRow, maxChars: number): string | null {
    const texts: string[] = []
    const tools: string[] = []
    let lastTool = ""
    let lastToolCount = 0
    const flushTool = () => {
      if (!lastToolCount) return
      tools.push(lastToolCount > 1 ? `${lastTool} (×${lastToolCount})` : lastTool)
      lastToolCount = 0
    }
    for (const payload of this.messagePartPayloads(m.id)) {
      const d = payload as any
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
