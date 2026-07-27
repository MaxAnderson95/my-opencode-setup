/**
 * In-memory stand-in for opencode's database, used by the tests.
 *
 * Mirrors only the columns recall actually reads, but keeps the real column
 * names and JSON payload shapes so a schema drift upstream surfaces as a test
 * failure rather than as silently empty search results.
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

export function createSourceDb(sessions: FixtureSession[]): Database {
  const db = new Database(":memory:")
  db.run(`CREATE TABLE session(
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL DEFAULT 'prj', parent_id TEXT,
    slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL,
    version TEXT NOT NULL DEFAULT '1', time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)`)
  db.run(`CREATE TABLE message(
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`)
  db.run(`CREATE TABLE part(
    id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`)

  let clock = 1_700_000_000_000
  for (const s of sessions) {
    const created = s.created ?? clock
    let t = created
    db.run(`INSERT INTO session(id,slug,directory,title,time_created,time_updated) VALUES (?,?,?,?,?,?)`, [
      s.id,
      s.slug ?? s.id.replace(/^ses_/, ""),
      s.directory ?? "/Users/test/Projects/demo",
      s.title ?? `session ${s.id}`,
      created,
      s.updated ?? created + s.messages.length * 1000,
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
            ? { type: "tool", tool: p.tool, state: { status: "completed", title: p.title ?? "", output: p.output }, time: { start: t } }
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
    clock += 10_000_000
  }
  return db
}
