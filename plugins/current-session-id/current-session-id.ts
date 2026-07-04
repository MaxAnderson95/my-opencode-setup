import { tool, type Plugin } from "@opencode-ai/plugin"

export const CurrentSessionIdPlugin: Plugin = async () => {
  return {
    tool: {
      get_opencode_current_session_id: tool({
        description:
          "Return the current opencode session ID (format: ses_XXXXXXXXXXXXXXXXXXXXXXXXXX). " +
          "Use when you need to reference, log, or persist the ID of the session you are running in.",
        args: {},
        async execute(_args, context) {
          return context.sessionID
        },
      }),
    },

    // Inject the current session ID into the system prompt on every turn so
    // the agent can read it directly from context (e.g. for commit footers)
    // without spending a tool call on get_opencode_current_session_id.
    //
    // We append to the last existing system entry rather than pushing a new
    // one — some models (Qwen, Mistral via llama.cpp) reject multiple system
    // messages.
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return
      // Trailing newline is mandatory: without it, the next chunk opencode
      // concatenates (sometimes the first user message, for providers/flows
      // that fold user content into the trailing system block) glues
      // directly onto the session ID — producing IDs like
      // "ses_...Write an opencode plugin..." in the model's view.
      const note = `Current opencode session ID: ${input.sessionID}\n`
      if (output.system.length > 0) {
        output.system[output.system.length - 1] += "\n\n" + note
      } else {
        output.system.push(note)
      }
    },
  }
}
