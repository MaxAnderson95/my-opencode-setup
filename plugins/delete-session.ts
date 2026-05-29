import type { Plugin } from "@opencode-ai/plugin"

export const DeleteSessionPlugin: Plugin = async ({ client }) => {
  return {
    "command.execute.before": async (input, _output) => {
      if (input.command !== "delete") return

      await client.session.delete({ path: { id: input.sessionID } })

      // Prevent the command template from being sent to the LLM.
      // The TUI already handles the session.deleted event by navigating
      // back to the home screen and showing a toast notification.
      throw new Error("session deleted")
    },
  }
}
