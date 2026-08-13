/**
 * Minimal typed access to the OpenCode server's MCP + config HTTP endpoints.
 *
 * The v2 plugin context deliberately exposes only a subset of the server client
 * (agent/catalog/command/session/tool/...) and has NO MCP domain, so a plugin
 * cannot reach /api/mcp through `ctx`. The full `@opencode-ai/client` package
 * does expose `mcp.connect/disconnect/list`, but it is not a resolvable
 * dependency of this repo, so this module speaks the same wire contract
 * directly:
 *
 *   - discovery: the local-service registration file used by
 *     `@opencode-ai/client/service` `discover()` — `$XDG_STATE_HOME/opencode/
 *     service.json` (fallback `~/.local/state/opencode/service.json`), JSON
 *     `{ url, pid, password? }`, Basic auth `opencode:<password>`.
 *   - routes/verbs/statuses: copied from the generated promise client
 *     (`@opencode-ai/client/dist/promise/generated/client.js`): GET /api/mcp,
 *     POST /api/mcp/{server}/connect|disconnect (204), GET /api/config.
 *   - location scoping: object query params encode as `location[directory]=…`.
 *
 * The plugin runs inside the server process, so the discovered registration is
 * normally this very process (registration.pid === process.pid). A mismatch
 * would mean this plugin was loaded by a server that is not the registered
 * local service; we still use the registration because there is no other
 * discovery contract, but tool errors will surface any resulting confusion.
 */

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

/** Wire shape of Mcp.Status (@opencode-ai/schema/mcp). */
export type McpStatus =
  | { status: "connected" }
  | { status: "pending" }
  | { status: "disabled" }
  | { status: "failed"; error: string }
  | { status: "needs_auth" }

/** Wire shape of McpServer rows from GET /api/mcp. */
export type McpServerRow = {
  name: string
  status: McpStatus
  integrationID?: string
}

/** The slice of ConfigMCP.Server this plugin cares about. */
export type McpServerConfig = {
  type: "local" | "remote"
  disabled?: boolean
  oauth?: Record<string, unknown> | false
}

type Endpoint = { url: string; headers: Record<string, string> }

type Registration = { url?: unknown; password?: unknown }

function registrationFile(): string {
  const stateHome = process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state")
  return join(stateHome, "opencode", "service.json")
}

async function readEndpoint(): Promise<Endpoint> {
  const text = await readFile(registrationFile(), "utf8").catch(() => undefined)
  if (text === undefined) {
    throw new Error(`OpenCode service registration not found at ${registrationFile()}`)
  }
  let info: Registration
  try {
    info = JSON.parse(text) as Registration
  } catch {
    throw new Error(`OpenCode service registration is not valid JSON (${registrationFile()})`)
  }
  if (typeof info.url !== "string" || !info.url) {
    throw new Error(`OpenCode service registration has no url (${registrationFile()})`)
  }
  const headers: Record<string, string> = {}
  if (typeof info.password === "string" && info.password) {
    headers["authorization"] = "Basic " + Buffer.from(`opencode:${info.password}`).toString("base64")
  }
  return { url: info.url, headers }
}

async function errorMessage(response: Response): Promise<string> {
  const fallback = `HTTP ${response.status}`
  try {
    const body: unknown = await response.json()
    if (body && typeof body === "object" && "message" in body && typeof body.message === "string" && body.message) {
      return body.message
    }
    return fallback
  } catch {
    return fallback
  }
}

export interface ServerApi {
  mcpList(directory?: string): Promise<McpServerRow[]>
  mcpConnect(name: string, directory?: string): Promise<void>
  mcpDisconnect(name: string, directory?: string): Promise<void>
  /** Merged `mcp.servers` across config documents; later documents win, matching core loadConfig. */
  mcpConfig(directory?: string): Promise<Record<string, McpServerConfig>>
}

export function createServerApi(): ServerApi {
  // The registration is stable for the lifetime of the hosting server process,
  // but a transport failure invalidates the cache so a service restart with a
  // new port/password recovers on the next call.
  let endpoint: Promise<Endpoint> | undefined

  async function request(path: string, init: RequestInit, directory?: string): Promise<Response> {
    const attempt = async (fresh: boolean): Promise<Response> => {
      if (fresh || !endpoint) endpoint = readEndpoint()
      const resolved = await endpoint.catch((error: unknown) => {
        endpoint = undefined
        throw error
      })
      const url = new URL(path, resolved.url)
      // Matches the generated client's object query encoding: location[directory]=…
      if (directory) url.searchParams.set("location[directory]", directory)
      try {
        return await fetch(url, { ...init, headers: { ...resolved.headers, ...init.headers } })
      } catch (error) {
        endpoint = undefined
        throw error
      }
    }
    try {
      return await attempt(false)
    } catch {
      return attempt(true)
    }
  }

  return {
    async mcpList(directory) {
      const response = await request("/api/mcp", { method: "GET" }, directory)
      if (response.status !== 200) throw new Error(await errorMessage(response))
      const body = (await response.json()) as { data?: McpServerRow[] }
      return body.data ?? []
    },

    async mcpConnect(name, directory) {
      const response = await request(`/api/mcp/${encodeURIComponent(name)}/connect`, { method: "POST" }, directory)
      if (response.status !== 204) throw new Error(await errorMessage(response))
      await response.body?.cancel().catch(() => {})
    },

    async mcpDisconnect(name, directory) {
      const response = await request(`/api/mcp/${encodeURIComponent(name)}/disconnect`, { method: "POST" }, directory)
      if (response.status !== 204) throw new Error(await errorMessage(response))
      await response.body?.cancel().catch(() => {})
    },

    async mcpConfig(directory) {
      const response = await request("/api/config", { method: "GET" }, directory)
      if (response.status !== 200) throw new Error(await errorMessage(response))
      const entries = (await response.json()) as Array<{
        type?: string
        info?: { mcp?: { servers?: Record<string, McpServerConfig> } }
      }>
      const merged: Record<string, McpServerConfig> = {}
      for (const entry of entries) {
        if (entry.type !== "document") continue
        for (const [name, server] of Object.entries(entry.info?.mcp?.servers ?? {})) {
          merged[name] = server
        }
      }
      return merged
    },
  }
}
