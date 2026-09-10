import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, it } from "bun:test"
import { adapters } from "./lib/adapters.ts"
import { ALLOW, OverageGuard } from "./lib/guard.ts"
import { createHost } from "./lib/host.ts"

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function stateDir(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  return directory
}

const noLog = () => {}

it("uses authenticated native forms without a tool call and persists the gate", async () => {
  const directory = await stateDir("overage-api-")
  const calls: { path: string; body: Record<string, unknown> }[] = []
  let form: Record<string, unknown> | undefined
  let state: Record<string, unknown> = { status: "pending" }
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Basic ${Buffer.from("opencode:test-password").toString("base64")}`)
    let text = ""
    for await (const chunk of request) text += chunk
    const body = text ? JSON.parse(text) : {}
    const path = request.url!
    calls.push({ path, body })
    response.setHeader("content-type", "application/json")
    if (path === "/api/session/root") response.end(JSON.stringify({ data: { id: "root" } }))
    else if (path === "/api/session/root/form") {
      form = body
      response.end(JSON.stringify({ data: { ...body, sessionID: "root" } }))
    } else if (path.endsWith("/state")) response.end(JSON.stringify({ data: state }))
    else if (path.endsWith("/cancel")) {
      state = { status: "cancelled" }
      response.writeHead(204).end()
    } else if (path.startsWith("/api/session?")) response.end(JSON.stringify({ data: [], cursor: {} }))
    else if (path.endsWith("/interrupt")) response.writeHead(204).end()
    else response.writeHead(404).end("{}")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  await writeFile(
    join(directory, "service.json"),
    JSON.stringify({ pid: process.pid, url: `http://127.0.0.1:${address.port}`, password: "test-password" }),
  )
  const host = createHost(async (id) => ({ id }), adapters, noLog, directory)
  const guard = new OverageGuard(host)
  cleanups.push(() => guard.close())
  const codex = { provider: "openai", id: "account" }
  const ticket = await guard.before("root", codex)
  await guard.observe(ticket, { using: true, reset: Date.now() + 1_000_000 })
  assert.deepEqual(form?.metadata, { kind: "question", source: "overage-guard", provider: "openai" })
  assert.equal(form?.title, "OpenAI credits")
  const fields = form?.fields as { options: { value: string; label: string }[] }[]
  assert.deepEqual(
    fields[0]!.options.map((option) => option.label),
    ["Resume after reset", "Allow credits", "Stop session and subagents"],
  )
  assert.equal("tool" in (form!.metadata as object), false)
  let proceeded = false
  const pending = guard.before("root", codex).then(() => {
    proceeded = true
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(proceeded, false)
  state = { status: "answered", answer: { decision: ALLOW } }
  await guard.event({ type: "form.replied", data: { id: form?.id, sessionID: "root", answer: { decision: ALLOW } } })
  await pending
  const disk = JSON.parse(await readFile(join(directory, "overage-guard.json"), "utf8"))
  assert.equal(disk.gates[0].provider, "openai")
  assert.equal(disk.gates[0].account, "account")
  assert.ok(disk.gates[0].allowedUntil > Date.now())
  assert.equal(
    calls.some((call) => call.path.includes("prompt")),
    false,
  )
  assert.equal(JSON.stringify(disk).includes("test-password"), false)
})

it("admits requests through the local session API when another process owns the service", async () => {
  const directory = await stateDir("overage-private-")
  await writeFile(join(directory, "service.json"), JSON.stringify({ pid: process.pid + 1, url: "http://127.0.0.1:1" }))
  const lookedUp: string[] = []
  const host = createHost(
    async (id) => {
      lookedUp.push(id)
      return id === "child" ? { id, parentID: "root" } : { id }
    },
    adapters,
    noLog,
    directory,
  )
  const guard = new OverageGuard(host)
  cleanups.push(() => guard.close())
  assert.equal((await guard.before("child")).root, "root")
  assert.equal((await guard.before("root", { provider: "anthropic", id: "account" })).root, "root")
  assert.deepEqual(lookedUp, ["child", "root"])
  await assert.rejects(host.form("root", "question", "anthropic"), /own the managed service/)
})

it("fails closed on malformed persistent spending state", async () => {
  const directory = await stateDir("overage-state-")
  await writeFile(
    join(directory, "overage-guard.json"),
    JSON.stringify({ version: 1, gates: [{ root: "root", account: "account", allowedUntil: "forever" }] }),
  )
  await assert.rejects(
    createHost(async (id) => ({ id }), adapters, noLog, directory).load(),
    /Invalid overage guard state/,
  )
})
