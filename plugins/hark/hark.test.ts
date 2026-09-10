import { expect, spyOn, test } from "bun:test"
import type { Plugin } from "@opencode-ai/plugin"

test("early attention and failures notify, while short success and children stay silent", async () => {
  const originalEndpoint = process.env.HARK_WEBHOOK_URL
  const originalOverride = process.env.HARK_ALWAYS_NOTIFY
  process.env.HARK_WEBHOOK_URL = "https://example.test/test-only"
  process.env.HARK_ALWAYS_NOTIFY = "1"
  const { default: plugin } = await import("./hark")
  if (originalEndpoint === undefined) delete process.env.HARK_WEBHOOK_URL
  else process.env.HARK_WEBHOOK_URL = originalEndpoint
  if (originalOverride === undefined) delete process.env.HARK_ALWAYS_NOTIFY
  else process.env.HARK_ALWAYS_NOTIFY = originalOverride

  const titles: string[] = []
  const request = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    titles.push(JSON.parse(String(init?.body)).title)
    return new Response(null, { status: 202 })
  }, { preconnect: globalThis.fetch.preconnect }))
  const events = [
    { type: "permission.asked", data: { sessionID: "parent", requestID: "p1" } },
    { type: "permission.asked", data: { sessionID: "parent", requestID: "p1" } },
    { type: "question.asked", data: { sessionID: "parent", requestID: "q1" } },
    { type: "question.asked", data: { sessionID: "child", requestID: "q2" } },
    { type: "session.execution.failed", data: { sessionID: "failed", error: { type: "test", message: "failure" } } },
    { type: "session.execution.started", data: { sessionID: "short" } },
    { type: "session.execution.succeeded", data: { sessionID: "short" } },
  ]
  let cleanup: Awaited<ReturnType<typeof plugin.setup>> = undefined
  try {
    cleanup = await plugin.setup({
      session: {
        get: async ({ sessionID }: { sessionID: string }) => ({
          title: sessionID,
          parentID: sessionID === "child" ? "parent" : undefined,
          location: { directory: "/test" },
        }),
      },
      event: {
        subscribe: async function* ({ signal }: { signal: AbortSignal }) {
          for (const event of events) yield event
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
        },
      },
    } as unknown as Plugin.Context)
    await Bun.sleep(1200)
    expect(titles.sort()).toEqual(["Errored · test", "Has a question · test", "Needs permission · test"])
  } finally {
    await cleanup?.()
    request.mockRestore()
  }
})
