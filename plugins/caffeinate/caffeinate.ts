import type { Plugin } from "@opencode-ai/plugin"
import type { Subprocess } from "bun"

// One caffeinate process per session. When a session is working (busy or
// retry), we ensure it has its own caffeinate. When it goes idle - or is
// deleted, or opencode itself exits - we kill that session's caffeinate.
//
// The machine is allowed to sleep only when EVERY session is idle, since
// each session keeps its own caffeinate alive independently. This matters
// when multiple opencode sessions run concurrently and finish in unknown
// order.
export const CaffeinatePlugin: Plugin = async () => {
  const procs = new Map<string, Subprocess>()

  function startFor(sessionID: string) {
    if (procs.has(sessionID)) return
    const proc = Bun.spawn(["caffeinate", "-di", "-w", String(process.pid)], {
      stdout: "ignore",
      stderr: "ignore",
    })
    procs.set(sessionID, proc)
    void proc.exited.finally(() => {
      if (procs.get(sessionID) === proc) procs.delete(sessionID)
    })
  }

  function stopFor(sessionID: string) {
    const proc = procs.get(sessionID)
    if (!proc) return
    try {
      proc.kill()
    } catch {}
    procs.delete(sessionID)
  }

  function stopAll() {
    for (const proc of procs.values()) {
      try {
        proc.kill()
      } catch {}
    }
    procs.clear()
  }

  // Safety net for the case where opencode exits while a session is still
  // busy — no final "idle" event will fire, so without this the caffeinate
  // would be reparented to launchd and live forever. This does NOT tie
  // caffeinate lifecycle to the opencode process; if opencode is idle,
  // stopAll is a no-op.
  process.once("SIGINT", stopAll)
  process.once("SIGTERM", stopAll)
  process.once("SIGHUP", stopAll)
  process.once("exit", stopAll)

  return {
    event: async ({ event }) => {
      if (event.type === "session.status") {
        const { sessionID, status } = event.properties
        // SessionStatus has three variants:
        //   busy  — actively generating
        //   retry — waiting to retry a failed request (still working)
        //   idle  — not doing anything
        const t = status.type
        if (t === "busy" || t === "retry") {
          startFor(sessionID)
        } else if (t === "idle") {
          stopFor(sessionID)
        }
        return
      }

      if (event.type === "session.idle") {
        stopFor(event.properties.sessionID)
        return
      }

      if (event.type === "server.instance.disposed") {
        stopAll()
        return
      }

      // Safety net: if a session is deleted while busy, no "idle" will
      // ever fire for it.
      if (event.type === "session.deleted") {
        const id = event.properties.sessionID || event.properties.info?.id
        if (id) stopFor(id)
        return
      }
    },
  }
}

export default CaffeinatePlugin
