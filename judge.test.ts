import { afterEach, expect, test } from "bun:test"
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

async function harness(options: Record<string, unknown>, storage = new Map<string, unknown>()) {
  const hooks: Record<string, Hook> = {}
  const commands: any[] = []
  const synthetic: any[] = []
  const ctx = {
    options: { logFile: false, ...options },
    location: { directory: "/repo", project: { directory: "/repo" } },
    storage: { get: async (key: string) => storage.get(key), set: async (key: string, value: unknown) => void storage.set(key, value) },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID }),
      context: async () => [user("msg_1", "run the tests"), assistant("msg_2", [{ id: "call_1", name: "shell", input: { command: "rm -rf ~" } }])],
      synthetic: async (input: unknown) => void synthetic.push(input),
    },
    permission: { hook: async (_: string, fn: Hook) => void (hooks.evaluate = fn) },
    tool: { hook: async (_: string, fn: Hook) => void (hooks.after = fn) },
    command: { transform: async (fn: (editor: { add: (c: unknown) => void }) => void) => fn({ add: (c) => commands.push(c) }) },
  } as unknown as Plugin.Context
  await plugin.setup(ctx)
  return { hooks, commands, synthetic, storage }
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
