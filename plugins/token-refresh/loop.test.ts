import { describe, expect, test } from "bun:test"
import { createLoop } from "./lib/loop.ts"

const TICK_MS = 120_000
const JITTER_MS = 60_000

// A manual timer: tests fire pending callbacks explicitly and can see how
// long each was scheduled for.
function manualTimer() {
  const pending = new Map<number, { fn: () => void; ms: number }>()
  let next = 1
  return {
    timer: {
      set: (fn: () => void, ms: number) => {
        const id = next++
        pending.set(id, { fn, ms })
        return id
      },
      clear: (handle: unknown) => {
        if (typeof handle === "number") pending.delete(handle)
      },
    },
    pending,
    // Fires the single pending callback and waits for the async tick inside it.
    async fire() {
      expect(pending.size).toBe(1)
      const [id, entry] = [...pending.entries()][0]!
      pending.delete(id)
      entry.fn()
      await new Promise((r) => setTimeout(r, 0))
    },
    delays: () => [...pending.values()].map((entry) => entry.ms),
  }
}

function harness(options: { random?: () => number; tick?: (ctx: string) => Promise<void> } = {}) {
  const t = manualTimer()
  const ticks: string[] = []
  const log: string[] = []
  const loop = createLoop<string>({
    tick:
      options.tick ??
      (async (ctx) => {
        ticks.push(ctx)
      }),
    tickMs: TICK_MS,
    jitterMs: JITTER_MS,
    random: options.random ?? (() => 0.5),
    timer: t.timer,
    log: (line) => log.push(line),
  })
  return { loop, ticks, log, ...t }
}

describe("createLoop", () => {
  test("first attach schedules a tick with a random delay inside one interval", () => {
    const h = harness({ random: () => 0.25 })
    h.loop.attach("a")
    expect(h.delays()).toEqual([TICK_MS * 0.25])
  })

  test("each tick reschedules with interval plus jitter", async () => {
    const h = harness({ random: () => 0.5 })
    h.loop.attach("a")
    await h.fire()
    expect(h.ticks).toEqual(["a"])
    expect(h.delays()).toEqual([TICK_MS + JITTER_MS * 0.5])
  })

  test("a second attach does not start a second chain", async () => {
    const h = harness()
    h.loop.attach("a")
    h.loop.attach("b")
    expect(h.pending.size).toBe(1)
    await h.fire()
    expect(h.ticks).toEqual(["a"])
    expect(h.pending.size).toBe(1)
  })

  test("detaching the owner hands the loop to a surviving context", async () => {
    const h = harness()
    const detachA = h.loop.attach("a")
    h.loop.attach("b")
    detachA()
    expect(h.pending.size).toBe(1)
    await h.fire()
    expect(h.ticks).toEqual(["b"])
  })

  test("detaching the last context stops the loop", async () => {
    const h = harness()
    const detach = h.loop.attach("a")
    await h.fire()
    detach()
    expect(h.pending.size).toBe(0)
  })

  test("attaching again after the loop stopped starts a fresh chain", () => {
    const h = harness()
    const detach = h.loop.attach("a")
    detach()
    h.loop.attach("b")
    expect(h.pending.size).toBe(1)
  })

  test("a context attaching mid-tick after the last one left yields exactly one chain", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const h = harness({ tick: () => gate })
    const detach = h.loop.attach("a")
    const fired = h.fire()
    // Tick is in flight: the owner leaves and a newcomer arrives.
    detach()
    h.loop.attach("b")
    expect(h.pending.size).toBe(1)
    release()
    await fired
    await new Promise((r) => setTimeout(r, 0))
    expect(h.pending.size).toBe(1)
  })

  test("detaching everyone mid-tick leaves nothing scheduled", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const h = harness({ tick: () => gate })
    const detach = h.loop.attach("a")
    const fired = h.fire()
    detach()
    release()
    await fired
    await new Promise((r) => setTimeout(r, 0))
    expect(h.pending.size).toBe(0)
  })

  test("a throwing tick is logged and the chain continues", async () => {
    const h = harness({
      tick: async () => {
        throw new Error("boom")
      },
    })
    h.loop.attach("a")
    await h.fire()
    expect(h.log).toEqual(["tick failed: boom"])
    expect(h.pending.size).toBe(1)
  })
})
