/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { askJev } from "./jev"

function Commands(props: { context: Plugin.Context }) {
  const context = props.context
  const pending = new Set<string>()
  context.keymap.layer(() => ({
    mode: "global",
    commands: [{
      id: "jev.ask",
      title: "Ask Jev",
      description: "Get a yes/no decision about this session without an LLM turn",
      group: "Session",
      palette: true,
      slash: { name: "jev", arguments: true },
      run: async (input) => {
        const route = context.ui.router.current()
        if (route.type !== "session") {
          context.ui.toast.show({ message: "Open a session before asking Jev.", variant: "warning" })
          return
        }
        const sessionID = route.sessionID
        if (pending.has(sessionID)) return
        pending.add(sessionID)
        try {
          const question = input?.trim() ?? ""
          if (!question) throw new Error("Usage: /jev <binary question>")
          context.ui.toast.show({ title: "Jev", message: "Checking conversation evidence…", duration: 2000 })
          const result = await askJev(context.client, sessionID, question)
          await context.ui.dialog.alert({ title: "Jev", message: `${question}\n\n${result}` })
        } catch (error) {
          context.ui.toast.show({
            title: "Jev failed",
            message: error instanceof Error ? error.message : "Unknown error",
            variant: "error",
            duration: 10_000,
          })
        } finally {
          pending.delete(sessionID)
        }
      },
    }],
  }))
  return null
}

export default Plugin.define({
  id: "jev",
  setup(context) {
    return context.ui.slot({ append: "app", render: () => <Commands context={context} /> })
  },
})
