/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode-ai/plugin/tui"

function Commands(props: { context: Plugin.Context }) {
  const context = props.context

  context.keymap.layer(() => {
    const route = context.ui.router.current()

    return {
      mode: "global",
      commands:
        route.type !== "session" || !context.ui.tabs.enabled()
          ? []
          : [
              {
                id: "session.close.current",
                title: "Close session tab",
                description: "Close the current tab and open a new session tab",
                group: "Session",
                palette: true,
                slash: { name: "close" },
                run: () => {
                  if (!context.ui.tabs.close(route.sessionID)) return
                  context.keymap.dispatch("session.new")
                },
              },
            ],
    }
  })

  return null
}

export default Plugin.define({
  id: "session-close",
  setup(context) {
    return context.ui.slot({ append: "app", render: () => <Commands context={context} /> })
  },
})
