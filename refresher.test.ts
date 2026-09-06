import { describe, expect, test } from "bun:test"
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  DUE_WITHIN_MS,
  REFRESH_MIN_MS,
  Refresher,
  type Connection,
  type Credential,
} from "./lib/refresher.ts"

const work: Connection = { type: "credential", id: "cred_work", label: "Work" }
const personal: Connection = { type: "credential", id: "cred_personal", label: "Personal" }
const zen: Connection = { type: "credential", id: "cred_zen", label: "Primary" }
const env: Connection = { type: "env", name: "ANTHROPIC_API_KEY" }

type Resolver = (h: { now: number; spend: (ms: number) => void }) => Credential | undefined

function harness(values: Record<string, Resolver>) {
  let now = 10 * 60_000
  const log: string[] = []
  const resolved: string[] = []
  const refresher = new Refresher({ now: () => now, log: (line) => log.push(line) })
  const api = {
    list: async () => [
      { id: "anthropic", connections: [work, personal, env] },
      { id: "opencode", connections: [zen] },
    ],
    resolve: async (connection: Connection) => {
      if (connection.type !== "credential") throw new Error("env connections must be skipped")
      resolved.push(connection.id)
      return values[connection.id]?.({ now, spend: (ms) => (now += ms) })
    },
  }
  return { tick: () => refresher.tick(api), log, resolved, advance: (ms: number) => (now += ms), now: () => now }
}

describe("Refresher", () => {
  test("resolves every credential connection, skips env connections, reports a count", async () => {
    const h = harness({
      cred_work: () => ({ type: "oauth", expires: 1 }),
      cred_personal: () => ({ type: "oauth", expires: 2 }),
      cred_zen: () => ({ type: "key" }),
    })
    await h.tick()
    expect(h.resolved).toEqual(["cred_work", "cred_personal", "cred_zen"])
    expect(h.log).toEqual(["watching 2 oauth credentials"])
  })

  test("stops resolving API keys after the first look", async () => {
    const h = harness({ cred_zen: () => ({ type: "key" }) })
    await h.tick()
    await h.tick()
    expect(h.resolved.filter((id) => id === "cred_zen")).toHaveLength(1)
  })

  test("logs a refresh it performed: credential was due and resolve took network time", async () => {
    let expires = 0
    const h = harness({
      cred_work: ({ now, spend }) => {
        if (expires <= now + DUE_WITHIN_MS) {
          spend(REFRESH_MIN_MS)
          expires = now + 8 * 60 * 60_000
        }
        return { type: "oauth", expires }
      },
    })
    expires = h.now() + 60 * 60_000
    await h.tick()
    h.advance(58 * 60_000)
    await h.tick()
    expect(h.log.at(-1)).toMatch(/^refreshed anthropic\/Work expires=\S+ took=50ms$/)
  })

  test("stays silent when another process refreshed a due credential first", async () => {
    let expires = 0
    const h = harness({ cred_work: () => ({ type: "oauth", expires }) })
    expires = h.now() + 60 * 60_000
    await h.tick()
    h.advance(58 * 60_000)
    expires = h.now() + 8 * 60 * 60_000
    await h.tick()
    expect(h.log).toEqual(["watching 1 oauth credentials"])
  })

  test("stays silent when a credential that was not due changed expiry", async () => {
    let expires = 0
    let slow = false
    const h = harness({
      cred_work: ({ spend }) => {
        if (slow) spend(REFRESH_MIN_MS)
        return { type: "oauth", expires }
      },
    })
    expires = h.now() + 60 * 60_000
    await h.tick()
    // Even a slow resolve cannot have been a refresh if the credential had an hour left.
    slow = true
    expires = h.now() + 9 * 60 * 60_000
    await h.tick()
    expect(h.log).toEqual(["watching 1 oauth credentials"])
  })

  test("logs a refresh performed on the first look when it took network time", async () => {
    const h = harness({
      cred_work: ({ now, spend }) => {
        spend(REFRESH_MIN_MS)
        return { type: "oauth", expires: now + 8 * 60 * 60_000 }
      },
    })
    await h.tick()
    expect(h.log[0]).toMatch(/^refreshed anthropic\/Work /)
  })

  test("backs off exponentially after failures and logs recovery", async () => {
    let fail = true
    const h = harness({
      cred_personal: () => {
        if (fail) throw new Error("token exchange failed (400)")
        return { type: "oauth", expires: 5 }
      },
    })
    await h.tick()
    expect(h.log[0]).toBe("failed anthropic/Personal attempt=1 retry_in=15m: token exchange failed (400)")

    h.advance(BACKOFF_BASE_MS - 1)
    await h.tick()
    expect(h.resolved.filter((id) => id === "cred_personal")).toHaveLength(1)

    h.advance(1)
    await h.tick()
    expect(h.log.at(-1)).toBe("failed anthropic/Personal attempt=2 retry_in=30m: token exchange failed (400)")

    h.advance(BACKOFF_BASE_MS * 2)
    await h.tick()
    expect(h.log.at(-1)).toBe("failed anthropic/Personal attempt=3 retry_in=60m: token exchange failed (400)")

    fail = false
    h.advance(BACKOFF_BASE_MS * 4)
    await h.tick()
    expect(h.log.at(-1)).toBe("recovered anthropic/Personal")
  })

  test("caps the backoff", async () => {
    const h = harness({
      cred_personal: () => {
        throw new Error("nope")
      },
    })
    for (let i = 0; i < 8; i++) {
      await h.tick()
      h.advance(BACKOFF_MAX_MS)
    }
    expect(h.log.at(-1)).toBe(`failed anthropic/Personal attempt=8 retry_in=${BACKOFF_MAX_MS / 60_000}m: nope`)
  })

  test("reports the cause chain of a wrapped failure", async () => {
    const h = harness({
      cred_personal: () => {
        throw new Error("", { cause: new Error("Request failed: 401") })
      },
    })
    await h.tick()
    expect(h.log[0]).toBe("failed anthropic/Personal attempt=1 retry_in=15m: Request failed: 401")
  })
})
