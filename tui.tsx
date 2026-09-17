/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"

type ResumeContext = Pick<Plugin.Context, "data" | "keymap" | "ui">

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message
  }
  return String(error)
}

export async function resume(context: ResumeContext, input?: string) {
  const sessionID = input?.trim()
  if (!sessionID) {
    context.keymap.dispatch("session.list")
    return
  }

  try {
    await context.data.session.sync(sessionID)
    const session = context.data.session.get(sessionID)
    if (!session) throw new Error(`Session ${sessionID} was not found`)
    context.ui.router.navigate({ type: "session", sessionID: session.id })
  } catch (error) {
    context.ui.toast.show({
      title: "Failed to resume session",
      message: errorMessage(error),
      variant: "error",
    })
  }
}

function Commands(props: { context: Plugin.Context }) {
  const context = props.context

  context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "session.resume.by-id",
        title: "Resume session by ID",
        description: "Open the session picker or resume a session by ID",
        group: "Session",
        slash: { name: "resume", arguments: true },
        run: (input?: string) => resume(context, input),
      },
    ],
  }))

  return null
}

export default Plugin.define({
  id: "session-resume",
  setup(context) {
    return context.ui.slot({ append: "app", render: () => <Commands context={context} /> })
  },
})
