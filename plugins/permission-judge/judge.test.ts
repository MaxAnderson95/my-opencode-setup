import { afterEach, expect, mock, spyOn, test } from "bun:test"
import * as os from "node:os"
import type { Plugin } from "@opencode/plugin"
import { decisionClient, DecisionError } from "./decisions"
import plugin, { parseOptions } from "./index"
import {
  collectEvidence,
  createBreaker,
  defaultThresholds,
  type JudgeAnswers,
  policy,
  questions,
  type SessionMessage,
  type Verdict,
} from "./judge"

const user = (id: string, text: string) => ({ id, type: "user", text, time: { created: 0 } }) as unknown as SessionMessage
const assistant = (id: string, tools: { id: string; name: string; input: unknown }[]) =>
  ({
    id,
    type: "assistant",
    time: { created: 0 },
    content: tools.map((tool) => ({ type: "tool", ...tool, state: { status: "running", input: tool.input }, time: { created: 0 } })),
  }) as unknown as SessionMessage

const answers = (risk: number[], authorized: number, forbidden: number): JudgeAnswers => ({
  risk: { type: "score", score: 0, probabilities: risk, confidence: 1 },
  authorized: { type: "noul", noul: authorized },
  forbidden: { type: "noul", noul: forbidden },
})

const wire = (risk: number[], authorized: number, forbidden: number) => ({
  model: "jev-1.13.0",
  answers: {
    risk: { type: "score", score: 1, confidence: 0.9, legend: {}, probabilities: Object.fromEntries(risk.map((p, i) => [String(i), p])) },
    authorized: { type: "noul", noul: authorized },
    forbidden: { type: "noul", noul: forbidden },
  },
})

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

test("decision client posts the shared Decisions body and validates typed answers", async () => {
  const calls: { url: string; body: any; auth: string | null }[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("authorization") })
    return Response.json(wire([0.1, 0.8, 0.1, 0], 0.9, 0.05))
  }) as unknown as typeof globalThis.fetch
  const decide = decisionClient({ provider: "openrouter", model: "~typesafe/jev-latest", apiKey: "k", timeoutMs: 1000, fetch })
  const result = await decide({ hello: "world" }, questions)
  expect(calls[0]?.url).toBe("https://openrouter.ai/api/alpha/decisions")
  expect(calls[0]?.auth).toBe("Bearer k")
  expect(calls[0]?.body).toMatchObject({ model: "~typesafe/jev-latest", state: { hello: "world" } })
  expect(Object.keys(calls[0]?.body.questions)).toEqual(["risk", "authorized", "forbidden"])
  expect(result.risk.probabilities).toEqual([0.1, 0.8, 0.1, 0])
  expect(result.authorized.noul).toBe(0.9)
})

test("decision client rejects HTTP failures and mistyped answers", async () => {
  const respond = (response: Response) =>
    decisionClient({ provider: "typesafe", model: "jev-latest", apiKey: "k", timeoutMs: 1000, fetch: (async () => response) as unknown as typeof fetch })
  await expect(respond(new Response("nope", { status: 401 }))({}, questions)).rejects.toThrow("HTTP 401")
  const wrong = wire([0.5, 0.5, 0, 0], 0.5, 0.5)
  ;(wrong.answers as Record<string, unknown>).forbidden = { type: "score", score: 1 }
  await expect(respond(Response.json(wrong))({}, questions)).rejects.toBeInstanceOf(DecisionError)
})

test("policy allows low-risk authorized work, denies forbidden or unauthorized high-risk work, and asks otherwise", () => {
  const t = defaultThresholds
  expect(policy(answers([0.6, 0.35, 0.05, 0], 0.9, 0.05), t).effect).toBe("allow")
  expect(policy(answers([0.6, 0.35, 0.05, 0], 0.9, 0.9), t)).toMatchObject({ effect: "deny", rule: "forbidden" })
  expect(policy(answers([0, 0, 0.1, 0.9], 0.1, 0.05), t)).toMatchObject({ effect: "deny", rule: "unauthorized-high-risk" })
  // The user asked for the risky action: the judge never overrides that, it asks the human.
  expect(policy(answers([0, 0, 0.1, 0.9], 0.95, 0.05), t).effect).toBe("ask")
  expect(policy(answers([0.3, 0.3, 0.4, 0], 0.9, 0.05), t).effect).toBe("ask")
})

test("breaker turns repeated denials into prompts until the user speaks again", () => {
  const breaker = createBreaker({ consecutive: 3, total: 4 })
  const deny: Verdict = { effect: "deny", rule: "forbidden", reason: "r" }
  const allow: Verdict = { effect: "allow", rule: "allowed" }
  const run = (turn: string, verdict: Verdict) => breaker("root", turn, verdict).effect
  expect([run("a", deny), run("a", deny), run("a", deny), run("a", deny)]).toEqual(["deny", "deny", "deny", "ask"])
  expect(run("a", allow)).toBe("allow")
  // The allow reset the consecutive count; the fourth counted denial then hits the total limit.
  expect([run("a", deny), run("a", deny)]).toEqual(["deny", "ask"])
})

test("breaker resets on allow and on a new user turn", () => {
  const breaker = createBreaker({ consecutive: 2, total: 20 })
  const deny: Verdict = { effect: "deny", rule: "forbidden", reason: "r" }
  expect(breaker("root", "a", deny).effect).toBe("deny")
  expect(breaker("root", "a", deny).effect).toBe("deny")
  expect(breaker("root", "a", deny).effect).toBe("ask")
  expect(breaker("root", "a", { effect: "allow", rule: "allowed" }).effect).toBe("allow")
  expect(breaker("root", "a", deny).effect).toBe("deny")
  expect(breaker("root", "b", deny).effect).toBe("deny")
  expect(breaker("root", "b", deny).effect).toBe("deny")
  expect(breaker("root", "b", deny).effect).toBe("ask")
})

test("evidence carries the requested tool input, recent actions without outputs, and the user's messages", () => {
  const messages = [
    user("msg_1", "original task"),
    user("msg_2", "two"),
    assistant("msg_3", [{ id: "call_a", name: "read", input: { path: "a.ts" } }]),
    user("msg_4", "three"),
    user("msg_5", "four"),
    assistant("msg_6", [{ id: "call_b", name: "shell", input: { command: "git push --force" } }]),
  ]
  const evidence = collectEvidence({
    action: "shell",
    resources: ["git push --force"],
    source: { messageID: "msg_6", id: "call_b" },
    messages,
    directory: "/repo",
    home: "/home/max",
  })
  expect(evidence.request).toEqual({ action: "shell", resources: ["git push --force"], tool: "shell", input: { command: "git push --force" } })
  expect(evidence.user_messages).toEqual(["original task", "two", "three", "four"])
  expect(evidence.recent_agent_actions).toEqual([{ tool: "read", input: { path: "a.ts" } }])
  expect(evidence.delegated_task).toBeUndefined()
})

test("subagent evidence uses the root session's user messages and labels the delegated task", () => {
  const evidence = collectEvidence({
    action: "shell",
    resources: ["ls"],
    messages: [user("msg_c1", "explore the repo")],
    rootMessages: [user("msg_r1", "find the bug, do not push anything")],
    directory: "/repo",
    home: "/home/max",
  })
  expect(evidence.user_messages).toEqual(["find the bug, do not push anything"])
  expect(evidence.delegated_task).toBe("explore the repo")
})

test("options reject invalid values", () => {
  expect(parseOptions({}).model).toBe("jev-latest")
  expect(parseOptions({ provider: "openrouter" }).model).toBe("~typesafe/jev-latest")
  expect(() => parseOptions({ provider: "openai" })).toThrow()
  expect(() => parseOptions({ thresholds: { allowLowRisk: 2 } })).toThrow()
  expect(() => parseOptions({ thresholds: { typo: 0.5 } })).toThrow()
})

type Hook = (event: any) => Promise<void> | void

const userRules = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "shell", resource: "*", effect: "ask" },
  { action: "shell", resource: "git status *", effect: "allow" },
  { action: "shell", resource: "git log *", effect: "allow" },
  { action: "shell", resource: "echo *", effect: "allow" },
  { action: "shell", resource: "git push *", effect: "deny" },
]

async function harness(options: Record<string, unknown>, storage = new Map<string, unknown>()) {
  const hooks: Record<string, Hook> = {}
  const commands: any[] = []
  const synthetic: any[] = []
  const health: unknown[] = []
  let handlers: Record<string, () => Promise<unknown>> = {}
  const ctx = {
    options: { logFile: false, ...options },
    location: { directory: "/repo", project: { directory: "/repo" } },
    storage: { get: async (key: string) => storage.get(key), set: async (key: string, value: unknown) => void storage.set(key, value) },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, agent: "build" }),
      context: async () => [user("msg_1", "run the tests"), assistant("msg_2", [{ id: "call_1", name: "shell", input: { command: "rm -rf ~" } }])],
      synthetic: async (input: unknown) => void synthetic.push(input),
    },
    agent: { get: async () => ({ data: { permissions: userRules } }) },
    rpc: {
      register: async (_: unknown, value: typeof handlers) => {
        handlers = value
        return { events: { emit: async (_name: string, data: unknown) => void health.push(data) } }
      },
    },
    permission: { hook: async (_: string, fn: Hook) => void (hooks.evaluate = fn) },
    tool: { hook: async (name: string, fn: Hook) => void (hooks[name === "execute.before" ? "before" : "after"] = fn) },
    command: { transform: async (fn: (editor: { add: (c: unknown) => void }) => void) => fn({ add: (c) => commands.push(c) }) },
  } as unknown as Plugin.Context
  await plugin.setup(ctx)
  return { hooks, commands, synthetic, storage, health, status: () => handlers.health!() }
}

/** Runs a shell call through execute.before, then its permission evaluation. */
async function shell(h: Awaited<ReturnType<typeof harness>>, command: string, resources: string[], effect = "ask") {
  await h.hooks.before!({ tool: "shell", id: "call_1", input: { command } })
  const event: any = { ...askEvent(), resources, effect }
  await h.hooks.evaluate!(event)
  return event
}

const askEvent = () => ({
  sessionID: "ses_1",
  action: "shell",
  resources: ["rm -rf ~"],
  source: { type: "tool", messageID: "msg_2", id: "call_1" },
  effect: "ask",
})

test("a denial reaches the model through execute.after with the reason", async () => {
  process.env.TYPESAFE_API_KEY = "test"
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return Response.json(wire([0, 0, 0.05, 0.95], 0.05, 0.1))
  }) as unknown as typeof fetch
  const { hooks } = await harness({})
  const event: any = askEvent()
  await hooks.evaluate!(event)
  expect(event.effect).toBe("deny")
  const after: any = { id: "call_1", status: "error", error: new Error("Unable to execute command: rm -rf ~") }
  await hooks.after!(after)
  expect(after.error.message).toContain("Blocked by the permission judge")
  expect(calls).toBe(1)
})

test("auto mode allows without calling the model, and /auto toggles it", async () => {
  process.env.TYPESAFE_API_KEY = "test"
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return Response.json(wire([0.9, 0.1, 0, 0], 0.9, 0))
  }) as unknown as typeof fetch
  const { hooks, commands, synthetic, storage } = await harness({})
  await commands[0].execute({ sessionID: "ses_1", prompt: { text: "" } })
  expect(storage.get("auto/ses_1")).toBe(true)
  expect(synthetic).toHaveLength(1)
  const event: any = askEvent()
  await hooks.evaluate!(event)
  expect(event.effect).toBe("allow")
  expect(calls).toBe(0)
  await commands[0].execute({ sessionID: "ses_1", prompt: { text: "off" } })
  const judged: any = askEvent()
  await hooks.evaluate!(judged)
  expect(calls).toBe(1)
})

test("model failures and skipped actions leave the request for the human", async () => {
  process.env.TYPESAFE_API_KEY = "test"
  globalThis.fetch = (async () => new Response("overloaded", { status: 529 })) as unknown as typeof fetch
  const { hooks } = await harness({})
  const failed: any = askEvent()
  await hooks.evaluate!(failed)
  expect(failed.effect).toBe("ask")
  const question: any = { ...askEvent(), action: "question" }
  await hooks.evaluate!(question)
  expect(question.effect).toBe("ask")
  const allowed: any = { ...askEvent(), effect: "allow" }
  await hooks.evaluate!(allowed)
  expect(allowed.effect).toBe("allow")
})

test("user allow rules extend to git -C, GH_TOKEN-prefixed gh, and sed line ranges without calling Jev", async () => {
  process.env.TYPESAFE_API_KEY = "test"
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return Response.json(wire([0, 0, 0.5, 0.5], 0.5, 0.5))
  }) as unknown as typeof fetch
  const h = await harness({})
  expect((await shell(h, "git -C /tmp/x status && git -C \"$R\" log -3", ["git -C /tmp/x status", 'git -C "$R" log -3'])).effect).toBe("allow")
  expect((await shell(h, "git -C /tmp/x push origin main", ["git -C /tmp/x push origin main"])).effect).toBe("deny")
  expect(calls).toBe(0)
  expect((await shell(h, "git -C /tmp/x commit -m x", ["git -C /tmp/x commit -m x"])).effect).toBe("ask")
  expect(calls).toBe(1)
})

test("an allowed command that redirects to a file goes to Jev", async () => {
  process.env.TYPESAFE_API_KEY = "test"
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return Response.json(wire([0, 0, 0.1, 0.9], 0.05, 0.05))
  }) as unknown as typeof fetch
  const h = await harness({})
  expect((await shell(h, "echo hi 2>&1 >/dev/null", ["echo hi 2>&1 >/dev/null"], "allow")).effect).toBe("allow")
  expect(calls).toBe(0)
  expect((await shell(h, "{ echo x; } > ~/.zshrc", ["echo x"], "allow")).effect).toBe("deny")
  expect(calls).toBe(1)
})

test("when Jev fails, prompts go to the human, health is reported, and calls pause until the retry window", async () => {
  process.env.TYPESAFE_API_KEY = "test"
  let calls = 0
  let fail = true
  globalThis.fetch = (async () => {
    calls++
    return fail ? new Response("down", { status: 503 }) : Response.json(wire([0.9, 0.1, 0, 0], 0.9, 0))
  }) as unknown as typeof fetch
  const h = await harness({})
  expect(await h.status()).toEqual({ available: true })
  expect((await shell(h, "bun test", ["bun test"])).effect).toBe("ask")
  expect(h.health).toMatchObject([{ available: false }])
  expect(await h.status()).toMatchObject({ available: false, reason: "typesafe returned HTTP 503: down" })
  fail = false
  expect((await shell(h, "bun test", ["bun test"])).effect).toBe("ask")
  expect(calls).toBe(1)
  const now = Date.now()
  const clock = spyOn(Date, "now").mockReturnValue(now + 31_000)
  try {
    expect((await shell(h, "bun test", ["bun test"])).effect).toBe("allow")
  } finally {
    clock.mockRestore()
  }
  expect(calls).toBe(2)
  expect(h.health).toMatchObject([{ available: false }, { available: true }])
})

test("a missing API key is reported at startup", async () => {
  const saved = process.env.TYPESAFE_API_KEY
  delete process.env.TYPESAFE_API_KEY
  // Keep the fallback from finding a real ~/.env_private.
  mock.module("node:os", () => ({ ...os, homedir: () => "/nonexistent" }))
  try {
    const h = await harness({})
    await Bun.sleep(10)
    expect(h.health).toMatchObject([{ available: false, reason: expect.stringContaining("TYPESAFE_API_KEY") }])
  } finally {
    process.env.TYPESAFE_API_KEY = saved
    mock.module("node:os", () => os)
  }
})
