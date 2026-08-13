import { writeSync } from "node:fs"
import { Plugin } from "@opencode-ai/plugin/tui"

// OSC 9;4 progress bar escape sequences (ConEmu protocol, supported by
// Ghostty 1.2.0+). Ghostty renders a blue indeterminate bar at the top of
// the terminal window and clears it automatically after ~15s of inactivity.
const PROGRESS_INDETERMINATE = "\x1b]9;4;3\x07"
const PROGRESS_CLEAR = "\x1b]9;4;0\x07"

// Re-send the indeterminate signal every KEEPALIVE_MS so Ghostty doesn't
// time out and clear the bar before the session is actually idle.
const KEEPALIVE_MS = 10_000

// Route and tab changes emit no server events, so a poll backs up the
// event-driven recomputes. Transitions are edge-detected, so polling is
// idempotent and cheap.
const POLL_MS = 1_000

export default Plugin.define({
  id: "ghostty-progress",
  setup(context) {
    if (context.options.enabled === false) return

    // Write straight to fd 1 instead of process.stdout: the opentui renderer
    // intercepts process.stdout.write for scrollback capture, and a captured
    // OSC sequence would be re-rendered as text instead of reaching the
    // terminal. OSC 9;4 moves no cursor and prints no glyphs, so a raw fd
    // write cannot disturb the rendered frame itself.
    const emit = (sequence: string) => {
      try {
        writeSync(1, sequence)
      } catch {
        // Non-blocking tty backpressure or a closed fd: drop this pulse; the
        // next keepalive retries.
      }
    }

    // In v1 this plugin ran in the per-terminal server, so "any busy session"
    // meant "busy in this terminal". The v2 server is shared and detached, so
    // mirroring every server session would light the bar for other terminals'
    // work. Scope to what this TUI presents: its open tabs plus the routed
    // session, expanded to session families so subagent activity counts.
    const roots = () => {
      const ids = new Set<string>()
      const route = context.ui.router.current()
      if (route.type === "session") ids.add(context.data.session.root(route.sessionID))
      if (context.ui.tabs.enabled()) {
        for (const tab of context.ui.tabs.list()) ids.add(tab.sessionID)
      }
      return ids
    }

    // data.session.status is "running" from session.execution.started until
    // succeeded/failed/interrupted, which spans v1's busy and retry states.
    const busyNow = () => {
      for (const root of roots()) {
        for (const id of context.data.session.family(root)) {
          if (context.data.session.status(id) === "running") return true
        }
      }
      return false
    }

    let busy = false
    let lastPulse = 0
    const sync = () => {
      const next = busyNow()
      const now = Date.now()
      if (next && (!busy || now - lastPulse >= KEEPALIVE_MS)) {
        emit(PROGRESS_INDETERMINATE)
        lastPulse = now
      }
      if (!next && busy) emit(PROGRESS_CLEAR)
      busy = next
    }

    const disposers = [
      context.data.on("session.execution.started", sync),
      context.data.on("session.execution.succeeded", sync),
      context.data.on("session.execution.failed", sync),
      context.data.on("session.execution.interrupted", sync),
      context.data.on("session.idle", sync),
      context.data.on("session.deleted", sync),
    ]
    const poll = setInterval(sync, POLL_MS)
    sync()

    const clearAll = () => {
      if (busy) emit(PROGRESS_CLEAR)
      busy = false
    }
    process.once("exit", clearAll)

    return () => {
      clearInterval(poll)
      for (const dispose of disposers) dispose()
      process.removeListener("exit", clearAll)
      clearAll()
    }
  },
})
