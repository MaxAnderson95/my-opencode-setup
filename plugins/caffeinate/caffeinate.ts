import { Plugin } from "@opencode-ai/plugin"
import type { Subprocess } from "bun"

// One caffeinate process per session. When a session begins executing we
// ensure it has its own caffeinate. When its execution settles (succeeded,
// failed, or interrupted) - or the session is deleted, or opencode itself
// exits - we kill that session's caffeinate.
//
// The machine is allowed to sleep only when EVERY session is idle, since
// each session keeps its own caffeinate alive independently. This matters
// when multiple opencode sessions run concurrently and finish in unknown
// order.
export default Plugin.define({
  id: "caffeinate",
  setup: (ctx) => {
    // caffeinate is a macOS binary; on any other platform register nothing.
    if (process.platform !== "darwin") return

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
    // busy — no terminal execution event will fire, so without this the
    // caffeinate would be reparented to launchd and live forever. This does
    // NOT tie caffeinate lifecycle to the opencode process; if opencode is
    // idle, stopAll is a no-op.
    process.once("SIGINT", stopAll)
    process.once("SIGTERM", stopAll)
    process.once("SIGHUP", stopAll)
    process.once("exit", stopAll)

    // Unlike v1's host-pushed event hook, subscribe() is a single SSE
    // stream, so a dropped connection must be re-established or the plugin
    // silently stops tracking for the rest of the process lifetime.
    const controller = new AbortController()
    const pump = (async () => {
      while (!controller.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            switch (event.type) {
              // Execution lifecycle: exactly one terminal event
              // (succeeded/failed/interrupted) closes each busy period opened
              // by started, and retries happen inside the period, so no extra
              // retry handling is needed.
              case "session.execution.started":
                startFor(event.data.sessionID)
                break
              case "session.execution.succeeded":
              case "session.execution.failed":
              case "session.execution.interrupted":
              case "session.idle":
                stopFor(event.data.sessionID)
                break
              // Safety net: if a session is deleted while busy, no terminal
              // execution event may ever fire for it.
              case "session.deleted":
                stopFor(event.data.sessionID)
                break
            }
          }
        } catch {
          // Aborted by cleanup, or the transport failed; either way handled
          // below.
        }
        // Whatever ended the stream, fail toward allowing sleep: sessions
        // still busy across a reconnect re-assert themselves on their next
        // execution event, whereas a stale caffeinate would pin the machine
        // awake indefinitely.
        stopAll()
        if (controller.signal.aborted) return
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    })()

    return async () => {
      process.off("SIGINT", stopAll)
      process.off("SIGTERM", stopAll)
      process.off("SIGHUP", stopAll)
      process.off("exit", stopAll)
      controller.abort()
      stopAll()
      await pump
    }
  },
})
