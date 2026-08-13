/**
 * In-memory stand-ins for opencode's database, used by the tests.
 *
 * Mirrors only the columns recall actually reads, but keeps the real column
 * names and JSON payload shapes so a schema drift upstream surfaces as a test
 * failure rather than as silently empty search results.
 *
 * `createSourceDb` builds the v2 generation (session_v2 + session_message),
 * which is the primary source after the opencode v2 cutover. `createSourceDbV1`
 * builds the legacy tables for fallback-path tests, and `addV1Session` layers a
 * legacy-only session into a v2 database to exercise the union.
 */
import { Database } from "bun:sqlite"

export type FixturePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; tool: string; title?: string; output: string }

export type FixtureMessage = { role: "user" | "assistant"; parts: FixturePart[]; summary?: boolean }

export type FixtureSession = {
  id: string
  slug?: string
  title?: string
  directory?: string
  created?: number
  updated?: number
  messages: FixtureMessage[]
}

const DEFAULT_DIRECTORY = "/Users/test/Projects/demo"

function sessionDefaults(s: FixtureSession, clock: number) {
  const created = s.created ?? clock
  return {
    created,
    updated: s.updated ?? created + s.messages.length * 1000,
    slug: s.slug ?? s.id.replace(/^ses_/, ""),
    directory: s.directory ?? DEFAULT_DIRECTORY,
    title: s.title ?? `session ${s.id}`,
  }
}

// ------------------------------------------------------------------ v2

export function createV2Schema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS session_v2(
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL DEFAULT 'prj', parent_id TEXT,
    slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT,
    version TEXT NOT NULL DEFAULT '1', time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)`)
  db.run(`CREATE TABLE IF NOT EXISTS session_message(
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`)
}

/** Insert one raw v2 message row; the escape hatch for message types the fixture spec does not model. */
export function insertV2Message(
  db: Database,
  sessionId: string,
  seq: number,
  type: string,
  data: Record<string, unknown>,
  time: number,
): string {
  const id = `msg_${sessionId}_${seq}`
  db.run(`INSERT INTO session_message(id,session_id,type,seq,time_created,time_updated,data) VALUES (?,?,?,?,?,?,?)`, [
    id,
    sessionId,
    type,
    seq,
    time,
    time,
    JSON.stringify(data),
  ])
  return id
}

function v2AssistantContent(parts: FixturePart[], time: number): Record<string, unknown>[] {
  return parts.map((p, i) => {
    if (p.type === "text") return { type: "text", text: p.text }
    if (p.type === "reasoning") return { type: "reasoning", text: p.text, time: { created: time } }
    return {
      type: "tool",
      id: `call_${i}`,
      name: p.tool,
      state: {
        status: "completed",
        input: {},
        content: [{ type: "text", text: p.output }],
        ...(p.title !== undefined ? { metadata: { title: p.title } } : {}),
      },
      time: { created: time, completed: time },
    }
  })
}

export function createSourceDb(sessions: FixtureSession[]): Database {
  const db = new Database(":memory:")
  createV2Schema(db)
  let clock = 1_700_000_000_000
  for (const s of sessions) {
    const d = sessionDefaults(s, clock)
    let t = d.created
    db.run(`INSERT INTO session_v2(id,slug,directory,title,time_created,time_updated) VALUES (?,?,?,?,?,?)`, [
      s.id,
      d.slug,
      d.directory,
      d.title,
      d.created,
      d.updated,
    ])
    s.messages.forEach((m, mi) => {
      t += 1000
      if (m.role === "user") {
        insertV2Message(db, s.id, mi, "user", { time: { created: t }, text: m.parts.filter((p) => p.type === "text").map((p) => p.text).join("\n\n"), files: [], agents: [] }, t)
        return
      }
      if (m.summary) {
        // v1's assistant summary messages became completed compaction rows.
        insertV2Message(
          db,
          s.id,
          mi,
          "compaction",
          {
            status: "completed",
            reason: "auto",
            summary: m.parts.filter((p) => p.type === "text").map((p) => p.text).join("\n\n"),
            recent: "",
            time: { created: t },
          },
          t,
        )
        return
      }
      insertV2Message(
        db,
        s.id,
        mi,
        "assistant",
        {
          time: { created: t, completed: t },
          agent: "build",
          model: { id: "test-model", providerID: "test", variant: "default" },
          content: v2AssistantContent(m.parts, t),
        },
        t,
      )
    })
    clock += 10_000_000
  }
  return db
}

// ------------------------------------------------------------------ v1 (legacy)

export function createV1Schema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS session(
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL DEFAULT 'prj', parent_id TEXT,
    slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL,
    version TEXT NOT NULL DEFAULT '1', time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)`)
  db.run(`CREATE TABLE IF NOT EXISTS message(
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`)
  db.run(`CREATE TABLE IF NOT EXISTS part(
    id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`)
}

/** Insert a legacy-generation session (v1 tables) into an existing database. */
export function addV1Session(db: Database, s: FixtureSession, clock = 1_700_000_000_000): void {
  createV1Schema(db)
  const d = sessionDefaults(s, clock)
  let t = d.created
  db.run(`INSERT INTO session(id,slug,directory,title,time_created,time_updated) VALUES (?,?,?,?,?,?)`, [
    s.id,
    d.slug,
    d.directory,
    d.title,
    d.created,
    d.updated,
  ])
  s.messages.forEach((m, mi) => {
    const mid = `msg_${s.id}_${mi}`
    t += 1000
    db.run(`INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?)`, [
      mid,
      s.id,
      t,
      t,
      JSON.stringify({ role: m.role, ...(m.summary ? { summary: 1 } : {}) }),
    ])
    m.parts.forEach((p, pi) => {
      const data =
        p.type === "tool"
          ? {
              type: "tool",
              tool: p.tool,
              state: { status: "completed", title: p.title ?? "", output: p.output },
              time: { start: t },
            }
          : { type: p.type, text: p.text, time: { start: t } }
      db.run(`INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?)`, [
        `prt_${s.id}_${mi}_${pi}`,
        mid,
        s.id,
        t,
        t,
        JSON.stringify(data),
      ])
    })
  })
}

export function createSourceDbV1(sessions: FixtureSession[]): Database {
  const db = new Database(":memory:")
  createV1Schema(db)
  let clock = 1_700_000_000_000
  for (const s of sessions) {
    addV1Session(db, s, clock)
    clock += 10_000_000
  }
  return db
}
