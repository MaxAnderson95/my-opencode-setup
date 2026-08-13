/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode-ai/plugin/tui"
import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"

function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  return mins === 0 ? `${hours}h` : `${hours}h ${mins}m`
}

export default Plugin.define({
  id: "elapsed-timer",
  setup(context) {
    if (context.options.enabled === false) return

    // Busy-start times are tracked at the plugin level from execution events,
    // not inside the slot component: the host may unmount the prompt footer
    // (permission prompts, route changes), and any state held in the slot's
    // memos would be wiped on every such blip.
    const [starts, setStarts] = createSignal<Record<string, number>>({})
    const track = (sessionID: string) =>
      setStarts((prev) => (sessionID in prev ? prev : { ...prev, [sessionID]: Date.now() }))
    const untrack = (sessionID: string) =>
      setStarts((prev) => {
        if (!(sessionID in prev)) return prev
        const next = { ...prev }
        delete next[sessionID]
        return next
      })

    const offs = [
      context.data.on("session.execution.started", (event) => track(event.data.sessionID)),
      context.data.on("session.execution.succeeded", (event) => untrack(event.data.sessionID)),
      context.data.on("session.execution.failed", (event) => untrack(event.data.sessionID)),
      context.data.on("session.execution.interrupted", (event) => untrack(event.data.sessionID)),
    ]

    const release = context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => {
        const busyStart = createMemo<number | undefined>((prev) => {
          const sessionID = input.sessionID
          if (!sessionID) return undefined
          const tracked = starts()[sessionID]
          if (tracked !== undefined) return tracked
          // Fallback for a session already running when the TUI attached,
          // before its first execution event arrives.
          if (context.data.session.status(sessionID) === "running") return prev ?? Date.now()
          return undefined
        }, undefined)

        // The heartbeat lives in the component and only while busy, so an
        // idle TUI schedules no timers at all.
        const [now, setNow] = createSignal(Date.now())
        createEffect(() => {
          if (busyStart() === undefined) return
          setNow(Date.now())
          const heartbeat = setInterval(() => setNow(Date.now()), 1000)
          onCleanup(() => clearInterval(heartbeat))
        })

        const elapsed = createMemo(() => {
          const start = busyStart()
          if (start === undefined) return 0
          return Math.max(0, Math.floor((now() - start) / 1000))
        })

        return (
          <Show when={busyStart() !== undefined}>
            <text fg={context.theme.text.subdued}>{formatDuration(elapsed())}</text>
          </Show>
        )
      },
    })

    return () => {
      for (const off of offs) off()
      release()
    }
  },
})
