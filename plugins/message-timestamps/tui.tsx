/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { createMemo } from "solid-js"

const format = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
})

export default Plugin.define({
  id: "message-timestamps",
  setup(context) {
    // `prepend` keeps this near the top of the sidebar; `append` would land
    // below the host's Context and MCP sections.
    return context.ui.slot({
      prepend: "sidebar.content",
      render: (input) => {
        // Mirrors the host's footer rule (rows.ts): a step that ends the turn,
        // not an intermediate tool-calls step, so mid-turn it keeps showing
        // the previous reply.
        const label = createMemo(() => {
          const messages = context.data.session.message.list(input.sessionID)
          for (let index = messages.length - 1; index >= 0; index--) {
            const message = messages[index]
            if (message.type !== "assistant" || message.time.completed === undefined) continue
            const terminal =
              (message.finish !== undefined && !["tool-calls", "unknown"].includes(message.finish)) ||
              message.error !== undefined
            if (terminal) return format.format(message.time.completed)
          }
          return undefined
        })

        // A function child, not <Show>: installed packages load from
        // node_modules, where Solid's JSX compiler does not run, so props are
        // evaluated once. The host's insert() re-runs a function child.
        return (
          <box>
            {() => {
              const value = label()
              if (value === undefined) return null
              return (
                <>
                  <text fg={context.theme.text.base}>
                    <b>Last reply</b>
                  </text>
                  <text fg={context.theme.text.muted}>{value}</text>
                </>
              )
            }}
          </box>
        )
      },
    })
  },
})
