import { expect, spyOn, test } from "bun:test"
import { createDelivery } from "./delivery"

test("presence suppresses delivery and repeated events send once", async () => {
  let away = false
  let calls = 0
  const deliver = createDelivery("https://example.test/secret", async () => away, async (_url, init) => {
    calls++
    expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("event-1")
    return new Response(null, { status: 202 })
  })
  const payload = { title: "Test", body: "Test" }
  await deliver("event-1", payload)
  expect(calls).toBe(0)
  away = true
  await Promise.all([deliver("event-1", payload), deliver("event-1", payload)])
  await deliver("event-1", payload)
  expect(calls).toBe(1)
})

test("HTTP rejection is logged safely and permits a later retry", async () => {
  const log = spyOn(console, "warn").mockImplementation(() => {})
  try {
    let calls = 0
    const deliver = createDelivery("https://example.test/secret", async () => true, async () => {
      calls++
      return new Response("private response", { status: calls === 1 ? 503 : 202 })
    })
    const payload = { title: "private title", body: "private body" }
    await deliver("event-2", payload)
    await deliver("event-2", payload)
    expect(calls).toBe(2)
    expect(log.mock.calls).toEqual([["[hark] Notification rejected: HTTP 503"]])
  } finally { log.mockRestore() }
})

test("transport failures redact exception details and use a bounded request", async () => {
  const log = spyOn(console, "warn").mockImplementation(() => {})
  try {
    const deliver = createDelivery("https://example.test/secret", async () => true, async (_url, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      expect(init?.redirect).toBe("error")
      throw new Error("secret webhook credential")
    })
    await deliver("event-3", { title: "Test", body: "Test" })
    expect(log.mock.calls).toEqual([["[hark] Notification request failed or timed out"]])
  } finally { log.mockRestore() }
})
