import { afterEach, expect, mock, test } from "bun:test"
import type { MessageListInput, SessionMessageInfo } from "@opencode/client"
import { APIConnectionError, AuthenticationError } from "@typesafe-ai/sdk"
import { askJev } from "./jev"

const originalFetch = globalThis.fetch
const originalKey = process.env.TYPESAFE_API_KEY
afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY
  else process.env.TYPESAFE_API_KEY = originalKey
})

const original: SessionMessageInfo = {
  id: "msg_original", type: "user", text: "Fix the export and deploy it.", time: { created: 1 },
}
const latest: SessionMessageInfo = {
  id: "msg_latest", type: "assistant", agent: "build", model: { providerID: "test", id: "test" },
  time: { created: 2 }, content: [
    { type: "text", text: "The fix passes tests. Deployment is still pending." },
    { type: "reasoning", text: "Private reasoning should not be sent." },
    {
      type: "tool", id: "call_test", name: "shell", time: { created: 2 },
      state: { status: "completed", input: { command: "test" }, content: [{ type: "text", text: "Tests: PASS" }] },
    },
  ],
}

function client(messages = [latest, original]) {
  return { message: { list: mock(async (input: MessageListInput) => ({
    data: input.type === "user" ? [original] : messages,
    cursor: {},
  })) } }
}

function response(noul: number) {
  return Response.json({ answers: { answer: { type: "noul", noul } } })
}

test("reads original and recent messages and calls only direct TypeSafe, without generation", async () => {
  process.env.TYPESAFE_API_KEY = "test-key"
  const api = client()
  const request = mock(async (url: string | URL | Request, init?: RequestInit) => {
    expect(url).toBe("https://api.typesafe.ai/v1/systemone")
    const body = JSON.parse(String(init?.body))
    expect(body.model).toBe("jev-latest")
    expect(body.state.originalPrompt).toBe(original.text)
    expect(body.state.recentContext).toEqual([
      { role: "user", content: original.text },
      { role: "assistant", content: "The fix passes tests. Deployment is still pending." },
      { role: "tool", content: "shell: completed\nTests: PASS" },
    ])
    expect(body.questions.answer.instructions).toContain("so is it done yet?")
    expect(String(init?.body)).not.toContain("Private reasoning")
    return response(0.07)
  })
  globalThis.fetch = Object.assign(request, { preconnect: originalFetch.preconnect })
  expect(await askJev(api, "ses_test", "so is it done yet?")).toBe("No · 93.0% confidence")
  expect(request).toHaveBeenCalledTimes(1)
  expect(api.message.list).toHaveBeenCalledWith({ sessionID: "ses_test", type: "user", order: "asc", limit: 1 })
  expect(api.message.list).toHaveBeenCalledWith({ sessionID: "ses_test", order: "desc", limit: 40 })
})

test("keeps recent evidence bounded while preserving the original task separately", async () => {
  process.env.TYPESAFE_API_KEY = "test-key"
  const messages: SessionMessageInfo[] = Array.from({ length: 40 }, (_, index) => ({
    id: `msg_${index}`, type: "user", text: `${index}: ${"x".repeat(10_000)} newest-${index}`,
    time: { created: 100 - index },
  }))
  globalThis.fetch = Object.assign(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    const entries: Array<{ content: string }> = body.state.recentContext
    expect(entries.reduce((total, entry) => total + entry.content.length, 0)).toBeLessThanOrEqual(24_000)
    expect(entries.at(-1)?.content).toContain("newest-0")
    expect(body.state.originalPrompt).toBe(original.text)
    return response(0.9)
  }, { preconnect: originalFetch.preconnect })
  await askJev(client(messages), "ses_test", "Done?")
})

test("reports yes probability and uncertainty including exact ties", async () => {
  process.env.TYPESAFE_API_KEY = "test-key"
  for (const [noul, expected] of [
    [0.92, "Yes · 92.0% confidence"],
    [0.51, "Yes · 51.0% confidence (uncertain)"],
    [0.5, "No · 50.0% confidence (uncertain)"],
  ] as const) {
    globalThis.fetch = Object.assign(async () => response(noul), { preconnect: originalFetch.preconnect })
    expect(await askJev(client(), "ses_test", "Done?")).toBe(expected)
  }
})

test("API errors, invalid primitives, and timeouts never become decisions", async () => {
  process.env.TYPESAFE_API_KEY = "test-key"
  globalThis.fetch = Object.assign(async () => new Response("", { status: 401 }), { preconnect: originalFetch.preconnect })
  await expect(askJev(client(), "ses_test", "Done?")).rejects.toBeInstanceOf(AuthenticationError)
  globalThis.fetch = Object.assign(async () => Response.json({ answers: { answer: { type: "choice", noul: 0.99 } } }), { preconnect: originalFetch.preconnect })
  await expect(askJev(client(), "ses_test", "Done?")).rejects.toThrow("invalid Noul")
  globalThis.fetch = Object.assign(async () => { throw new DOMException("Timed out", "TimeoutError") }, { preconnect: originalFetch.preconnect })
  await expect(askJev(client(), "ses_test", "Done?")).rejects.toBeInstanceOf(APIConnectionError)
})

test("empty questions do not read history or call TypeSafe", async () => {
  const api = client()
  await expect(askJev(api, "ses_test", " ")).rejects.toThrow("Usage:")
  expect(api.message.list).not.toHaveBeenCalled()
})
