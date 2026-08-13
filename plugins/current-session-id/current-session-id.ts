import { Plugin } from "@opencode-ai/plugin"

export default Plugin.define({
  id: "current-session-id",
  setup: async (ctx) => {
    await ctx.tool.transform((tools) => {
      tools.add({
        name: "get_opencode_current_session_id",
        description:
          "Return the current opencode session ID (format: ses_XXXXXXXXXXXXXXXXXXXXXXXXXX). " +
          "Use when you need to reference, log, or persist the ID of the session you are running in.",
        input: { type: "object", properties: {}, additionalProperties: false },
        // Keep the tool directly exposed under its exact name; routed through
        // CodeMode it would no longer be callable the way agents and skills
        // expect.
        options: { codemode: false },
        execute: async (_input, context) => ({ content: context.sessionID }),
      })
    })

    // Inject the current session ID into the system prompt on every dispatch
    // so the agent can read it directly from context (e.g. for commit
    // footers) without spending a tool call on
    // get_opencode_current_session_id. The note is constant per session, so
    // repeated dispatches produce byte-identical context (prompt-cache safe).
    //
    // We append to the last existing system part rather than pushing a new
    // one — some models (Qwen, Mistral via llama.cpp) reject multiple system
    // messages.
    await ctx.session.hook("context", (input) => {
      // Trailing newline is mandatory: without it, the next chunk opencode
      // concatenates (sometimes the first user message, for providers/flows
      // that fold user content into the trailing system block) glues
      // directly onto the session ID — producing IDs like
      // "ses_...Write an opencode plugin..." in the model's view.
      const note = `Current opencode session ID: ${input.sessionID}\n`
      const last = input.system[input.system.length - 1]
      if (last) {
        input.system[input.system.length - 1] = { ...last, text: last.text + "\n\n" + note }
      } else {
        input.system.push({ type: "text", text: note })
      }
    })
  },
})
