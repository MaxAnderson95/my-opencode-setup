/**
 * overage-guard — pauses a session family when a subscription provider starts
 * billing beyond the plan, and asks the user whether to wait, allow it, or stop.
 *
 * Detection is per provider (lib/adapters.ts); the pause/question state machine
 * is shared (lib/guard.ts); lib/host.ts connects it to one OpenCode server. This
 * file is wiring only.
 */
import { appendFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { Plugin } from "@opencode-ai/plugin"
import { adapters } from "./lib/adapters.ts"
import { OverageGuard, type Account, type Ticket } from "./lib/guard.ts"
import { createHost } from "./lib/host.ts"

const LOG = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "opencode/overage-guard.log")

const log = (line: string) => {
  try {
    appendFileSync(LOG, `${new Date().toISOString()} pid=${process.pid} ${line}\n`)
  } catch {}
}

type Context = Parameters<Plugin.Plugin["setup"]>[0]

/** Subscription OAuth connections are guarded; API keys and environment credentials are not. */
async function account(ctx: Context, provider: string): Promise<Account | undefined> {
  try {
    const connection = await ctx.integration.connection.active(provider)
    if (connection?.type !== "credential") return undefined
    const credential = await ctx.integration.connection.resolve(connection)
    return credential?.type === "oauth" ? { provider, id: connection.id } : undefined
  } catch (error) {
    log(`account lookup failed for ${provider}: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

export default Plugin.define({
  id: "overage-guard",
  setup: async (ctx) => {
    const byProvider = new Map(adapters.map((adapter) => [adapter.providerID, adapter]))
    const guard = new OverageGuard(createHost((sessionID) => ctx.session.get({ sessionID }), adapters, log))
    // Other plugins may replace the Request object between the two hooks, so
    // tickets are matched to responses per session and provider, in request
    // order. A mismatch between concurrent requests of one session is harmless:
    // they share root, epoch, and account.
    const inflight = new Map<string, Ticket[]>()
    const key = (evt: { sessionID: string; model: { providerID: string } }) =>
      `${evt.sessionID}/${evt.model.providerID}`

    const registrations = [
      await ctx.session.hook("http.request", async (evt) => {
        const adapter = byProvider.get(evt.model.providerID)
        const guarded = adapter ? await account(ctx, adapter.providerID) : undefined
        const ticket = await guard.before(evt.sessionID, guarded, evt.request.signal)
        if (!guarded) return
        const queue = inflight.get(key(evt)) ?? []
        queue.push(ticket)
        inflight.set(key(evt), queue)
      }),
      await ctx.session.hook("http.response", async (evt) => {
        const adapter = byProvider.get(evt.model.providerID)
        const ticket = inflight.get(key(evt))?.shift()
        if (!adapter || !ticket) return
        await guard.observe(ticket, adapter.read(evt.response))
      }),
    ]

    const abort = new AbortController()
    void (async () => {
      while (!abort.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
            try {
              await guard.event(event)
            } catch (error) {
              log(`event handling failed: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
        } catch (error) {
          log(`event stream ended: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (abort.signal.aborted) break
        await delay(1000, undefined, { signal: abort.signal }).catch(() => {})
        try {
          await guard.event({ type: "server.connected", data: {} })
        } catch (error) {
          log(`reconcile failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    })()

    return async () => {
      abort.abort()
      await guard.close()
      for (const registration of registrations) {
        try {
          await registration.dispose()
        } catch {
          // Host may already have torn the registration down.
        }
      }
    }
  },
})
