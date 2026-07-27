/**
 * Sidecar index schema and migration.
 *
 * Schema 2 changed the FTS table to contentless (`content=''`). The stored copy
 * of every indexed message was 64% of the index on disk and duplicated text
 * that already exists in opencode's own database; snippets are now rendered
 * from the source instead. The `parts` table carries the per-row metadata that
 * used to live in UNINDEXED FTS columns, which also makes deletes indexed
 * rather than a scan over a side table.
 */
import type { Database } from "bun:sqlite"

export const SCHEMA_VERSION = "2"

export type MigrationResult = { reset: boolean; reason: string; reclaimedBytes: number }

function tableExists(db: Database, name: string): boolean {
  return !!db.query(`SELECT 1 FROM sqlite_master WHERE name=?`).get(name)
}

export function openIndex(db: Database): void {
  db.run("PRAGMA journal_mode=WAL")
  db.run("PRAGMA busy_timeout=5000")
  db.run("PRAGMA synchronous=NORMAL")
}

export function createSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)`)

  db.run(`CREATE TABLE IF NOT EXISTS chunks(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    time INTEGER NOT NULL,
    hash TEXT NOT NULL,
    text TEXT NOT NULL,
    emb BLOB NOT NULL)`)
  db.run(`CREATE INDEX IF NOT EXISTS chunks_session ON chunks(session_id)`)

  // Row metadata for the contentless FTS table; parts.id IS the fts rowid.
  db.run(`CREATE TABLE IF NOT EXISTS parts(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    part_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    role TEXT NOT NULL,
    time INTEGER NOT NULL,
    seg_start INTEGER NOT NULL DEFAULT 0)`)
  db.run(`CREATE INDEX IF NOT EXISTS parts_session ON parts(session_id)`)
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(text, content='', contentless_delete=1)`)

  db.run(`CREATE TABLE IF NOT EXISTS indexed_sessions(
    session_id TEXT PRIMARY KEY,
    time_updated INTEGER NOT NULL,
    chunks INTEGER NOT NULL DEFAULT 0,
    fts_rows INTEGER NOT NULL DEFAULT 0)`)

  db.run(`CREATE TABLE IF NOT EXISTS sessions(
    id TEXT PRIMARY KEY, slug TEXT, title TEXT, directory TEXT,
    parent_id TEXT, time_created INTEGER, time_updated INTEGER)`)
  db.run(`CREATE INDEX IF NOT EXISTS sessions_directory ON sessions(directory)`)

  // Summaries survive index resets: they are expensive and model-independent
  // of the embedder, and are invalidated by the session's own time_updated.
  db.run(`CREATE TABLE IF NOT EXISTS summaries(
    session_id TEXT NOT NULL,
    model TEXT NOT NULL,
    focus TEXT NOT NULL DEFAULT '',
    time_updated INTEGER NOT NULL,
    summary TEXT NOT NULL,
    created INTEGER NOT NULL,
    PRIMARY KEY (session_id, model, focus))`)
}

function getMeta(db: Database, key: string): string | null {
  const row = db.query(`SELECT value FROM meta WHERE key=?`).get(key) as { value: string } | null
  return row?.value ?? null
}

export function setMeta(db: Database, key: string, value: string): void {
  db.run(`INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [key, value])
}

/**
 * Bring an existing index up to the current schema and embedding model.
 *
 * Either mismatch invalidates every indexed row, so the cheapest correct move
 * is to drop and rebuild from the source, which is always authoritative.
 * Summaries are preserved.
 */
export function migrate(db: Database, modelTag: string, dbSize: () => number): MigrationResult {
  db.run(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)`)
  const priorSchema = getMeta(db, "schema")
  const priorModel = getMeta(db, "model")
  const legacy = !priorSchema && tableExists(db, "fts")

  const reason = legacy
    ? "pre-versioned index"
    : priorSchema && priorSchema !== SCHEMA_VERSION
      ? `schema ${priorSchema} -> ${SCHEMA_VERSION}`
      : priorModel && priorModel !== modelTag
        ? `model ${priorModel} -> ${modelTag}`
        : ""

  if (!reason) {
    createSchema(db)
    setMeta(db, "schema", SCHEMA_VERSION)
    setMeta(db, "model", modelTag)
    return { reset: false, reason: "", reclaimedBytes: 0 }
  }

  const before = dbSize()
  for (const t of ["fts", "parts", "parts_indexed", "chunks", "indexed_sessions", "sessions"]) {
    db.run(`DROP TABLE IF EXISTS ${t}`)
  }
  createSchema(db)
  setMeta(db, "schema", SCHEMA_VERSION)
  setMeta(db, "model", modelTag)
  // Without VACUUM the freed pages stay in the file, which defeats the point of
  // dropping the stored-content table in the first place. In WAL mode the main
  // database is not truncated until a checkpoint, so without this the file (and
  // any size we reported) would still show the pre-reset bytes.
  db.run("VACUUM")
  db.run("PRAGMA wal_checkpoint(TRUNCATE)")
  return { reset: true, reason, reclaimedBytes: Math.max(0, before - dbSize()) }
}

/**
 * Cooperative single-writer lease for the startup backfill.
 *
 * Every opencode process loads its own copy of this plugin, so without a lease
 * N processes each walk the same stale sessions and embed the same text. The
 * conditional UPDATE is atomic in SQLite, so the winner is whoever commits
 * first; a lease whose heartbeat has gone stale can be stolen.
 */
export class BackfillLease {
  // Must be unique per instance, not merely per process: two leases created in
  // the same millisecond would otherwise be indistinguishable, and each would
  // consider the other's lease its own.
  private readonly holder = `${process.pid}@${Date.now()}#${Math.random().toString(36).slice(2, 10)}`
  constructor(
    private db: Database,
    private ttlMs: number,
    private now: () => number = Date.now,
  ) {}

  tryAcquire(): boolean {
    const cutoff = this.now() - this.ttlMs
    const value = JSON.stringify({ holder: this.holder, at: this.now() })
    this.db.run(
      `INSERT INTO meta(key,value) VALUES ('backfill_lease',?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value
       WHERE COALESCE(json_extract(meta.value,'$.at'), 0) < ?
          OR json_extract(meta.value,'$.holder') = ?`,
      [value, cutoff, this.holder],
    )
    return getMeta(this.db, "backfill_lease")?.includes(this.holder) ?? false
  }

  heartbeat(): void {
    this.db.run(
      `UPDATE meta SET value=? WHERE key='backfill_lease' AND json_extract(value,'$.holder')=?`,
      [JSON.stringify({ holder: this.holder, at: this.now() }), this.holder],
    )
  }

  release(): void {
    this.db.run(`DELETE FROM meta WHERE key='backfill_lease' AND json_extract(value,'$.holder')=?`, [this.holder])
  }
}
