import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Adapter } from "./adapters.ts"
import { ALLOW, RESUME, STOP, type GuardHost, type SavedGate } from "./guard.ts"

export const STATE_DIR = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "opencode")

const formPath = (root: string, id: string) =>
  `/api/session/${encodeURIComponent(root)}/form/${encodeURIComponent(id)}`

/**
 * Connects the guard to one OpenCode server: gate state on disk, session
 * lookups through the plugin API, and forms/interrupts through the HTTP API of
 * the managed service this process owns.
 */
export function createHost(
  session: GuardHost["session"],
  adapters: readonly Adapter[],
  log: (message: string) => void,
  directory = STATE_DIR,
): GuardHost {
  const file = join(directory, "overage-guard.json")

  async function request(method: string, path: string, body?: unknown) {
    const registration = JSON.parse(await readFile(join(directory, "service.json"), "utf8")) as {
      pid: number
      url: string
      password?: string
    }
    // Forms are process-local. Never silently create a question on another server.
    if (registration.pid !== process.pid) {
      throw new Error("Overage guard requires this OpenCode process to own the managed service registration")
    }
    const response = await fetch(new URL(path, registration.url), {
      method,
      headers: {
        "content-type": "application/json",
        ...(registration.password
          ? { authorization: `Basic ${Buffer.from(`opencode:${registration.password}`).toString("base64")}` }
          : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok && response.status !== 404) {
      throw new Error(`Overage guard: OpenCode ${method} ${path} returned ${response.status}`)
    }
    return response
  }

  return {
    async load() {
      let text: string
      try {
        text = await readFile(file, "utf8")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
        throw error
      }
      const saved = JSON.parse(text) as { version: number; gates: SavedGate[] }
      if (
        saved.version !== 1 ||
        !Array.isArray(saved.gates) ||
        saved.gates.some(
          (gate) =>
            typeof gate.root !== "string" ||
            typeof gate.provider !== "string" ||
            typeof gate.account !== "string" ||
            (gate.reset !== undefined && !Number.isFinite(gate.reset)) ||
            (gate.allowedUntil !== undefined && !Number.isFinite(gate.allowedUntil)) ||
            (gate.form !== undefined && typeof gate.form !== "string"),
        )
      )
        throw new Error("Invalid overage guard state; refusing to discard the spending guard")
      return saved.gates
    },
    async save(gates) {
      await mkdir(directory, { recursive: true })
      const temp = `${file}.${process.pid}.tmp`
      await writeFile(temp, JSON.stringify({ version: 1, gates }), { mode: 0o600 })
      await rename(temp, file)
    },
    session,
    async children(id) {
      const children: string[] = []
      let cursor: string | undefined
      do {
        const query = new URLSearchParams(cursor ? { cursor } : { parentID: id, limit: "100" })
        const response = await request("GET", `/api/session?${query}`)
        const page = (await response.json()) as { data: { id: string }[]; cursor: { next?: string } }
        children.push(...page.data.map((child) => child.id))
        cursor = page.cursor.next
      } while (cursor)
      return children
    },
    async interrupt(id) {
      await request("POST", `/api/session/${encodeURIComponent(id)}/interrupt`, { continue: false })
    },
    async form(root, id, provider, reset) {
      const adapter = adapters.find((item) => item.providerID === provider)
      const name = adapter?.name ?? provider
      const term = adapter?.term ?? "paid usage"
      const until =
        reset && reset > Date.now()
          ? ` Permission expires at ${new Date(reset).toISOString()}.`
          : " Permission lasts five minutes because no future reset time is available."
      const response = await request("POST", `/api/session/${encodeURIComponent(root)}/form`, {
        id,
        title: `${name} ${term}`,
        metadata: { kind: "question", source: "overage-guard", provider },
        fields: [
          {
            key: "decision",
            type: "string",
            required: true,
            custom: false,
            title: `${name} ${term}`,
            description:
              `${name} is billing this session to ${term} beyond the subscription. New model requests for this session and its subagents are paused. Leave this question unanswered to keep waiting.` +
              until,
            options: [
              {
                value: RESUME,
                label: "Resume after reset",
                description: `Try one waiting ${name} request; release the others only after subscription usage is confirmed.`,
              },
              {
                value: ALLOW,
                label: `Allow ${term}`,
                description: `Continue using ${term} until the time above.`,
              },
              {
                value: STOP,
                label: "Stop session and subagents",
                description: "Stop the parent and all subagents. Continue them manually later.",
              },
            ],
          },
        ],
      })
      if (!response.ok) throw new Error("Overage question could not be created")
    },
    async state(root, id) {
      const response = await request("GET", `${formPath(root, id)}/state`)
      if (response.status === 404) return undefined
      const result = (await response.json()) as { data: Awaited<ReturnType<GuardHost["state"]>> }
      return result.data
    },
    async cancel(root, id) {
      const state = await this.state(root, id)
      if (state?.status === "pending") await request("POST", `${formPath(root, id)}/cancel`)
    },
    error(error) {
      log(`guard error: ${error instanceof Error ? error.message : String(error)}`)
    },
  }
}
