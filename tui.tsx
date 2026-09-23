/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"

const format = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
})

const PAGE_SIZE = 50
const MAX_PAGES = 10

export default Plugin.define({
  id: "message-timestamps",
  setup(context) {
    // Host-owned store: reads inside the render function are tracked by the
    // host's Solid runtime, whichever solid-js copy an installed package loads.
    const [completed, update] = context.storage.memory("last-reply", {
      initial: {} as Record<string, number>,
    })
    const inflight = new Set<string>()

    // Asks the server rather than reading context.data.session.message: the
    // TUI loads only the newest 20 messages, and a long agentic turn pushes
    // the previous reply out of that window.
    async function refresh(sessionID: string) {
      if (inflight.has(sessionID)) return
      inflight.add(sessionID)
      try {
        let cursor: string | undefined
        for (let page = 0; page < MAX_PAGES; page++) {
          const response = await context.client.message.list(
            cursor
              ? { sessionID, type: "assistant", limit: PAGE_SIZE, cursor }
              : { sessionID, type: "assistant", limit: PAGE_SIZE, order: "desc" },
          )
          for (const message of response.data) {
            if (message.type !== "assistant" || message.time.completed === undefined) continue
            // Mirrors the host's footer rule (rows.ts): the step that ended
            // the turn, not an intermediate tool-calls step.
            const terminal =
              (message.finish !== undefined && !["tool-calls", "unknown"].includes(message.finish)) ||
              message.error !== undefined
            if (!terminal) continue
            const time = message.time.completed
            update((draft) => {
              draft[sessionID] = time
            })
            return
          }
          cursor = response.cursor.next ?? undefined
          if (!cursor) return
        }
      } catch {
        // Leave the last known value; the next finished turn retries.
      } finally {
        inflight.delete(sessionID)
      }
    }

    const offs = [
      context.data.on("session.execution.succeeded", (event) => void refresh(event.data.sessionID)),
      context.data.on("session.execution.failed", (event) => void refresh(event.data.sessionID)),
      context.data.on("session.execution.interrupted", (event) => void refresh(event.data.sessionID)),
    ]

    // `prepend` keeps this near the top of the sidebar; `append` would land
    // below the host's Context and MCP sections.
    const release = context.ui.slot({
      prepend: "sidebar.content",
      render: (input) => {
        void refresh(input.sessionID)
        // A function child, not <Show>: installed packages load from
        // node_modules, where Solid's JSX compiler does not run, so props are
        // evaluated once. The host's insert() re-runs a function child.
        return (
          <box>
            {() => {
              const time = completed[input.sessionID]
              if (time === undefined) return null
              return (
                <>
                  <text fg={context.theme.text.base}>
                    <b>Last reply</b>
                  </text>
                  <text fg={context.theme.text.muted}>{format.format(time)}</text>
                </>
              )
            }}
          </box>
        )
      },
    })

    return () => {
      for (const off of offs) off()
      release()
    }
  },
})
