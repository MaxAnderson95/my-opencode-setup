/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode-ai/plugin/tui"

// Not "session.delete": that id already owns ctrl+d inside the session-list
// dialog, and a named command with no explicit `bind` inherits whatever the
// keybind config has for its id, which would steal ctrl+d globally.
const COMMAND = "session.delete.current"

function message(context: Plugin.Context, sessionID: string) {
  const session = context.data.session.get(sessionID)
  const target = session?.title ? `"${session.title}"` : sessionID
  // Session.remove cascades: it interrupts the session, then removes every
  // child before publishing session.deleted, so say how much is going away.
  const children = context.data.session.family(sessionID).filter((id) => id !== sessionID).length
  const also = children === 0 ? "" : ` and ${children} child session${children === 1 ? "" : "s"}`
  return `${target}${also} will be permanently deleted. This cannot be undone.`
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  // A declared HTTP status rejects with the parsed JSON body, not an Error.
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message
  }
  return String(error)
}

function Commands(props: { context: Plugin.Context }) {
  const context = props.context

  context.keymap.layer(() => {
    // Read the route here rather than gating with `enabled`: the layer body runs
    // inside a Solid effect, so a store read re-registers on navigation, while
    // an `enabled` callback is only re-evaluated when the keymap invalidates.
    const route = context.ui.router.current()
    const sessionID = route.type === "session" ? route.sessionID : undefined

    return {
      mode: "global",
      commands:
        sessionID === undefined
          ? []
          : [
              {
                id: COMMAND,
                title: "Delete session",
                description: "Delete the current session and all of its history",
                group: "Session",
                palette: true,
                slash: { name: "delete" },
                run: async () => {
                  const confirmed = await context.ui.dialog.confirm({
                    title: "Delete session",
                    message: message(context, sessionID),
                    label: { confirm: "delete" },
                  })
                  if (!confirmed) return
                  try {
                    await context.client.session.remove({ sessionID })
                  } catch (error) {
                    context.ui.toast.show({
                      title: "Failed to delete session",
                      message: errorMessage(error),
                      variant: "error",
                    })
                  }
                  // No navigation or success toast here: on session.deleted the
                  // host routes home and toasts, and the session-tabs context
                  // closes the tab and selects a neighbour when tabs are on.
                },
              },
            ],
    }
  })

  return null
}

export default Plugin.define({
  id: "session-delete",
  setup(context) {
    // keymap.layer() is Keymap.createLayer, which is owned by the calling
    // component, so registration has to happen inside one. A headless claim on
    // the "app" slot is the host's own pattern for this.
    return context.ui.slot({ append: "app", render: () => <Commands context={context} /> })
  },
})
