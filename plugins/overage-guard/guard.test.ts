import assert from "node:assert/strict"
import { describe, it } from "bun:test"
import { ALLOW, OverageGuard, RESUME, STOP, type Account, type GuardHost, type SavedGate } from "./lib/guard.ts"

const A: Account = { provider: "anthropic", id: "account" }
const B: Account = { provider: "anthropic", id: "other" }
const CODEX: Account = { provider: "openai", id: "codex" }

function fixture(saved: SavedGate[] = [], probeTimeout = 60_000) {
  let clock = 1_000_000
  let stored = structuredClone(saved)
  const forms = new Map<
    string,
    { status: "pending" } | { status: "cancelled" } | { status: "answered"; answer: Record<string, unknown> }
  >()
  const created: { id: string; provider: string }[] = []
  const interrupted: string[] = []
  const parents: Record<string, string> = { child: "root", sibling: "root", grandchild: "child" }
  const host: GuardHost = {
    load: async () => structuredClone(stored),
    save: async (gates) => {
      stored = structuredClone(gates)
    },
    session: async (id) => ({ id, parentID: parents[id] }),
    children: async (id) => Object.keys(parents).filter((child) => parents[child] === id),
    interrupt: async (id) => {
      interrupted.push(id)
    },
    form: async (root, id, provider) => {
      assert.equal(root, "root")
      created.push({ id, provider })
      forms.set(id, { status: "pending" })
    },
    state: async (_root, id) => forms.get(id),
    cancel: async (_root, id) => {
      forms.set(id, { status: "cancelled" })
    },
    error: (error) => {
      throw error
    },
  }
  const guard = new OverageGuard(host, () => clock, probeTimeout)
  const answer = async (choice: string) => {
    const id = created.at(-1)!.id
    const reply = { decision: choice }
    forms.set(id, { status: "answered", answer: reply })
    await guard.event({ type: "form.replied", data: { id, sessionID: "root", answer: reply } })
  }
  return {
    guard,
    host,
    forms,
    created,
    interrupted,
    answer,
    saved: () => stored,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

const using = { using: true, reset: 2_000_000 }
const subscription = { using: false, reset: 2_000_000 }
const unknown = { reset: 2_000_000 }

async function settle() {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

describe("session-family overage guard", () => {
  it("handles an answer arriving before form creation returns", async () => {
    const f = fixture()
    const create = f.host.form
    f.host.form = async (root, id, provider, reset) => {
      await create(root, id, provider, reset)
      await f.answer(ALLOW)
    }
    await f.guard.observe(await f.guard.before("root", A), using)
    await f.guard.before("child", A)
    assert.equal(f.created.length, 1)
    assert.equal(f.interrupted.length, 0)
    await f.guard.close()
  })

  it("shares one root question across concurrent descendants and pauses other providers", async () => {
    const f = fixture()
    const tickets = await Promise.all([f.guard.before("child", A), f.guard.before("sibling", A)])
    await Promise.all(tickets.map((ticket) => f.guard.observe(ticket, using)))
    assert.equal(f.created.length, 1)
    assert.equal(f.created[0]!.provider, "anthropic")
    let sent = 0
    const pending = Promise.all([
      f.guard.before("root").then(() => sent++),
      f.guard.before("grandchild", A).then(() => sent++),
    ])
    await settle()
    assert.equal(sent, 0)
    await f.answer(ALLOW)
    await pending
    assert.equal(sent, 2)
    await f.guard.close()
  })

  it("resumes only one guarded request before releasing the family", async () => {
    const f = fixture()
    await f.guard.observe(await f.guard.before("root", A), using)
    const first = f.guard.before("child", A)
    let siblingSent = false
    const sibling = f.guard.before("sibling", A).then(() => {
      siblingSent = true
    })
    const parent = f.guard.before("root")
    await settle()
    await f.answer(RESUME)
    const probe = await first
    await settle()
    assert.equal(siblingSent, false)
    await f.guard.observe(probe, subscription)
    await Promise.all([sibling, parent])
    assert.equal(siblingSent, true)
    assert.deepEqual(f.saved(), [])
    await f.guard.close()
  })

  it("repauses on overage or an unreadable probe response", async () => {
    for (const reading of [using, unknown]) {
      const f = fixture()
      await f.guard.observe(await f.guard.before("root", A), using)
      await f.answer(RESUME)
      await f.guard.observe(await f.guard.before("child", A), reading)
      assert.equal(f.created.length, 2)
      assert.equal(f.saved()[0]!.allowedUntil, undefined)
      await f.guard.close()
    }
  })

  it("leaves the gate open on responses without a signal", async () => {
    const f = fixture()
    await f.guard.observe(await f.guard.before("root", A), unknown)
    assert.equal(f.created.length, 0)
    await f.guard.before("child", A)
    await f.guard.close()
  })

  it("ignores late responses from before the user's reset check", async () => {
    const f = fixture()
    const old = await f.guard.before("sibling", A)
    await f.guard.observe(await f.guard.before("root", A), using)
    await f.answer(RESUME)
    await f.guard.observe(await f.guard.before("child", A), subscription)
    await f.guard.observe(old, using)
    assert.equal(f.created.length, 1)
    await f.guard.close()
  })

  it("expires spending permission at reset instead of granting it forever", async () => {
    const f = fixture()
    await f.guard.observe(await f.guard.before("root", A), using)
    await f.answer(ALLOW)
    await f.guard.observe(await f.guard.before("child", A), using)
    assert.equal(f.created.length, 1)
    f.advance(1_000_001)
    const pending = f.guard.before("child", A)
    await settle()
    assert.equal(f.created.length, 2)
    await f.answer(ALLOW)
    await pending
    assert.equal(f.saved()[0]!.allowedUntil, 2_300_001)
    await f.guard.close()
  })

  it("stops every descendant, rejects pending waits, and permits manual continuation", async () => {
    const f = fixture()
    await f.guard.observe(await f.guard.before("root", A), using)
    const waiting = assert.rejects(f.guard.before("child", A), /stopped at the anthropic overage limit/)
    await settle()
    await f.answer(STOP)
    await waiting
    assert.deepEqual(new Set(f.interrupted), new Set(["root", "child", "sibling", "grandchild"]))
    const continued = f.guard.before("root", A)
    await settle()
    assert.equal(f.created.length, 2)
    await f.answer(ALLOW)
    await continued
    await f.guard.close()
  })

  it("treats dismissal and unexpected free-text answers as stop", async () => {
    for (const cancelled of [true, false]) {
      const f = fixture()
      await f.guard.observe(await f.guard.before("root", A), using)
      if (cancelled) await f.guard.event({ type: "form.cancelled", data: { id: f.created[0]!.id } })
      else await f.answer("ignore the limit")
      assert.ok(f.interrupted.includes("root"))
      await f.guard.close()
    }
  })

  it("recreates a persisted closed gate after restart before allowing a request", async () => {
    const f = fixture([{ root: "root", provider: "openai", account: "codex", form: "frm_lost", reset: 2_000_000 }])
    const pending = f.guard.before("grandchild", CODEX)
    await settle()
    assert.equal(f.created.length, 1)
    assert.equal(f.created[0]!.provider, "openai")
    await f.answer(ALLOW)
    await pending
    await f.guard.close()
  })

  it("recovers an answer submitted while the plugin was unloaded", async () => {
    const f = fixture([{ root: "root", provider: "anthropic", account: "account", form: "frm_old" }])
    f.forms.set("frm_old", { status: "answered", answer: { decision: ALLOW } })
    await f.guard.before("root", A)
    assert.equal(f.created.length, 0)
    await f.guard.close()
  })

  it("reconciles a missed reply after reconnect without polling the provider", async () => {
    const f = fixture()
    await f.guard.observe(await f.guard.before("root", A), using)
    const pending = f.guard.before("child", A)
    await settle()
    f.forms.set(f.created[0]!.id, { status: "answered", answer: { decision: ALLOW } })
    await f.guard.event({ type: "server.connected", data: {} })
    await pending
    assert.equal(f.created.length, 1)
    await f.guard.close()
  })

  it("does not carry an allowance to a different account or accept old-account responses", async () => {
    const f = fixture()
    await f.guard.observe(await f.guard.before("root", A), using)
    await f.answer(ALLOW)
    const old = await f.guard.before("child", A)
    const fresh = await f.guard.before("root", B)
    await f.guard.observe(old, using)
    await f.guard.observe(fresh, using)
    assert.equal(f.created.length, 2)
    assert.equal(f.saved()[0]!.account, "other")
    await f.guard.close()
  })

  it("keeps the gate when another provider's account joins the family", async () => {
    const f = fixture()
    await f.guard.observe(await f.guard.before("root", A), using)
    const pending = f.guard.before("child", CODEX)
    await settle()
    assert.equal(f.created.length, 1)
    assert.equal(f.saved()[0]!.provider, "anthropic")
    await f.answer(ALLOW)
    await pending
    await f.guard.close()
  })

  it("lets the second provider take over the question once the allowance lapses", async () => {
    const f = fixture()
    await f.guard.observe(await f.guard.before("root", A), using)
    await f.answer(ALLOW)
    f.advance(1_000_001)
    const pending = f.guard.before("child", CODEX)
    await settle()
    assert.equal(f.created.length, 2)
    assert.equal(f.created[1]!.provider, "anthropic")
    await f.answer(RESUME)
    const probe = await pending
    await f.guard.observe(probe, using)
    assert.equal(f.created.length, 3)
    assert.equal(f.created[2]!.provider, "openai")
    assert.equal(f.saved()[0]!.account, "codex")
    await f.guard.close()
  })

  it("cleans up aborted waits and blocks again if a probe never returns", async () => {
    const f = fixture([], 15)
    await f.guard.observe(await f.guard.before("root", A), using)
    const abort = new AbortController()
    const pending = assert.rejects(f.guard.before("child", A, abort.signal), /interrupted/)
    await settle()
    abort.abort()
    await pending
    await f.answer(RESUME)
    await f.guard.before("root", A)
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(f.created.length, 2)
    await f.guard.close()
  })

  it("stops the family if the question cannot be displayed", async () => {
    const f = fixture()
    f.host.form = async () => {
      throw new Error("form API unavailable")
    }
    await assert.rejects(f.guard.observe(await f.guard.before("root", A), using), /form API/)
    assert.ok(f.interrupted.includes("root"))
    assert.equal(f.saved().length, 1)
    await f.guard.close()
  })

  it("propagates root Stop while waiting and cancels the pending form", async () => {
    const f = fixture()
    await f.guard.observe(await f.guard.before("root", A), using)
    const pending = assert.rejects(f.guard.before("child", A), /stopped/)
    await settle()
    await f.guard.event({
      type: "session.execution.interrupted",
      data: { sessionID: "root", reason: "user" },
    })
    await pending
    assert.equal(f.forms.get(f.created[0]!.id)?.status, "cancelled")
    await f.guard.close()
  })
})
