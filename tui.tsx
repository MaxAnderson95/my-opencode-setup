// @ts-nocheck
/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { Show, createMemo, createSignal } from "solid-js"

const id = "elapsed-timer"

function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  return mins === 0 ? `${hours}h` : `${hours}h ${mins}m`
}

const tui: TuiPlugin = async (api, options) => {
  if (options && options.enabled === false) return

  // Single top-level heartbeat. One interval for the whole plugin, not per
  // slot invocation. createMemo inside the slot subscribes to this tick.
  const [tick, setTick] = createSignal(0)
  const heartbeat = setInterval(() => setTick((t) => t + 1), 1000)
  api.lifecycle.onDispose(() => clearInterval(heartbeat))

  api.slots.register({
    slots: {
      session_prompt_right(ctx, props) {
        const busyStart = createMemo<number | undefined>((prev) => {
          const s = api.state.session.status(props.session_id)
          if (s?.type === "busy") return prev ?? Date.now()
          return undefined
        }, undefined)

        const elapsed = createMemo(() => {
          tick()
          const start = busyStart()
          if (start === undefined) return 0
          return Math.floor((Date.now() - start) / 1000)
        })

        return (
          <Show when={busyStart() !== undefined}>
            <text fg={ctx.theme.current.textMuted}>{formatDuration(elapsed())}</text>
          </Show>
        )
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
