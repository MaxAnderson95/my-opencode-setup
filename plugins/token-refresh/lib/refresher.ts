// Core only refreshes an OAuth credential when something calls
// Integration.connection.resolve() on it, which happens for the *active*
// connection of a provider at request time. Inactive accounts never get
// resolved, so their tokens rot. This module supplies the missing "when":
// resolve every stored credential on a schedule and let core decide whether
// a refresh is due (it refreshes when under five minutes remain) and persist
// the result.

export type Connection = { type: "credential"; id: string; label: string } | { type: "env"; name: string }
export type Credential = { type: "oauth"; expires: number } | { type: "key" }

// The slice of a plugin context a tick needs. Passed per tick because the
// loop may borrow a different live context each time.
export type Api = {
  list: () => Promise<ReadonlyArray<{ id: string; connections: ReadonlyArray<Connection> }>>
  resolve: (connection: Connection) => Promise<Credential | undefined>
}

export type Deps = {
  now: () => number
  log: (line: string) => void
}

export const BACKOFF_BASE_MS = 15 * 60_000
export const BACKOFF_MAX_MS = 6 * 60 * 60_000
// Core's threshold: resolve() refreshes when less than this remains.
export const DUE_WITHIN_MS = 5 * 60_000
// A refresh is a network round trip; reading an already-fresh credential
// from the database takes a millisecond or two.
export const REFRESH_MIN_MS = 50

type Failure = { count: number; retryAt: number }

// Core wraps refresh failures in a tagged error whose own message is empty;
// the useful text lives down the cause chain.
export function describe(err: unknown): string {
  const parts: string[] = []
  for (let cur = err, depth = 0; cur !== undefined && depth < 5; depth++) {
    if (cur instanceof Error) {
      if (cur.message) parts.push(cur.message)
      cur = cur.cause
    } else {
      parts.push(String(cur))
      break
    }
  }
  if (parts.length === 0) return err instanceof Error ? err.name : String(err)
  return parts.join(": ")
}

export class Refresher {
  // Last expiry seen per credential.
  private readonly expires = new Map<string, number>()
  // API keys never expire, so skip them after the first look.
  private readonly keys = new Set<string>()
  private readonly failures = new Map<string, Failure>()
  private started = false

  constructor(private readonly deps: Deps) {}

  async tick(api: Api): Promise<void> {
    const integrations = await api.list()
    for (const integration of integrations) {
      for (const connection of integration.connections) {
        if (connection.type !== "credential") continue
        if (this.keys.has(connection.id)) continue
        const failure = this.failures.get(connection.id)
        if (failure && failure.retryAt > this.deps.now()) continue
        await this.one(api, `${integration.id}/${connection.label}`, connection)
      }
    }
    if (!this.started) {
      this.started = true
      this.deps.log(`watching ${this.expires.size} oauth credentials`)
    }
  }

  private async one(api: Api, name: string, connection: Extract<Connection, { type: "credential" }>) {
    try {
      const started = this.deps.now()
      const value = await api.resolve(connection)
      const took = this.deps.now() - started
      if (value?.type === "key") {
        this.keys.add(connection.id)
        return
      }
      if (!value) return
      const previous = this.expires.get(connection.id)
      this.expires.set(connection.id, value.expires)
      // Every process sharing the database sees the new expiry; only the one
      // whose resolve() actually performed the refresh logs it. Core can only
      // have refreshed here if the credential was due going in, and a real
      // refresh cannot complete in database-read time. On the first look
      // there is no history, so the duration alone decides.
      const changed = previous === undefined || previous !== value.expires
      const due = previous === undefined || previous <= started + DUE_WITHIN_MS
      if (changed && due && took >= REFRESH_MIN_MS) {
        this.deps.log(`refreshed ${name} expires=${new Date(value.expires).toISOString()} took=${took}ms`)
      }
      if (this.failures.delete(connection.id)) this.deps.log(`recovered ${name}`)
    } catch (err) {
      const count = (this.failures.get(connection.id)?.count ?? 0) + 1
      const delay = Math.min(BACKOFF_BASE_MS * 2 ** (count - 1), BACKOFF_MAX_MS)
      this.failures.set(connection.id, { count, retryAt: this.deps.now() + delay })
      this.deps.log(`failed ${name} attempt=${count} retry_in=${Math.round(delay / 60_000)}m: ${describe(err)}`)
    }
  }
}
