import { Plugin } from "@opencode/plugin"
import type { Session } from "@opencode/schema/session"

// The v2 tool draft types raw JSON Schema inputs as `unknown`, so the executor
// narrows through this shape (mirrors the schema below).
type Input = {
  sessionID?: string
}

export default Plugin.define({
  id: "subagent-interrupt",
  setup: async (ctx) => {
    await ctx.tool.transform((tools) => {
      tools.add({
        name: "subagent_interrupt",
        description: [
          "Stop a background subagent you launched with the subagent tool.",
          "Pass the sessionID that tool returned. Only direct children of the current session can be interrupted.",
          "The subagent stops where it is; work it already wrote to disk stays. A cancellation notice arrives separately.",
        ].join("\n"),
        input: {
          type: "object",
          properties: {
            sessionID: {
              type: "string",
              description: "The ses_... id the subagent tool returned for the background subagent.",
            },
          },
          required: ["sessionID"],
          additionalProperties: false,
        },
        options: { codemode: false },
        async execute(input, context) {
          const raw = (input as Input).sessionID?.trim()
          if (!raw) throw new Error("A subagent sessionID is required.")
          const sessionID = raw as Session.ID

          const child = await ctx.session.get({ sessionID }).catch(() => undefined)
          if (!child) throw new Error(`Session ${raw} not found.`)
          if (child.parentID !== context.sessionID)
            throw new Error(`Session ${raw} is not a subagent of this session.`)

          const { interrupted } = await ctx.session.interrupt({ sessionID })
          return {
            content: interrupted
              ? `Interrupted subagent ${raw}. Its cancellation notice will arrive as a separate message.`
              : `Subagent ${raw} was not running: it already finished, or it was interrupted earlier.`,
          }
        },
      })
    })
  },
})
