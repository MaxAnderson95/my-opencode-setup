import type { Plugin } from "@opencode-ai/plugin"

// OSC 9;4 progress bar escape sequences (ConEmu protocol, supported by
// Ghostty 1.2.0+). Ghostty renders a blue indeterminate bar at the top of
// the terminal window and clears it automatically after ~15s of inactivity.
const PROGRESS_INDETERMINATE = "\x1b]9;4;3\x07"
const PROGRESS_CLEAR = "\x1b]9;4;0\x07"

// Send the indeterminate signal every KEEPALIVE_MS so Ghostty doesn't
// time out and clear the bar before the session is actually idle.
const KEEPALIVE_MS = 10_000

const progress = (s: string) => process.stdout.write(s)

export const GhosttyProgressPlugin: Plugin = async () => {
  const keepalives = new Map<string, ReturnType<typeof setInterval>>()

  function start(sessionID: string) {
    if (keepalives.has(sessionID)) return
    progress(PROGRESS_INDETERMINATE)
    keepalives.set(
      sessionID,
      setInterval(() => progress(PROGRESS_INDETERMINATE), KEEPALIVE_MS),
    )
  }

  function stop(sessionID: string) {
    const timer = keepalives.get(sessionID)
    if (timer) {
      clearInterval(timer)
      keepalives.delete(sessionID)
    }
    // Only clear if no sessions remain busy
    if (keepalives.size === 0) progress(PROGRESS_CLEAR)
  }

  function stopAll() {
    for (const timer of keepalives.values()) clearInterval(timer)
    keepalives.clear()
    progress(PROGRESS_CLEAR)
  }

  process.once("exit", stopAll)

  return {
    event: async ({ event }) => {
      if (event.type === "session.status") {
        const { sessionID, status } = event.properties
        const t = status.type
        if (t === "busy" || t === "retry") {
          start(sessionID)
        } else if (t === "idle") {
          stop(sessionID)
        }
        return
      }

      if (event.type === "session.idle") {
        stop(event.properties.sessionID)
        return
      }

      if (event.type === "server.instance.disposed") {
        stopAll()
        return
      }

      if (event.type === "session.deleted") {
        const id = event.properties.sessionID || event.properties.info?.id
        if (id) stop(id)
        return
      }
    },
  }
}

export default GhosttyProgressPlugin
