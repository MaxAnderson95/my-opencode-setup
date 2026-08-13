import { Plugin } from "@opencode-ai/plugin"
import { writeCallout } from "./state"

// The v2 tool draft types raw JSON Schema inputs as `unknown`, so the executor
// narrows through this shape (mirrors the schema below).
type CalloutInput = {
  content?: string
  clear?: boolean
}

export default Plugin.define({
  id: "callout",
  setup: async (ctx) => {
    await ctx.tool.transform((tools) => {
      tools.add({
        name: "callout",
        description:
          "Put important information in the user's OpenCode sidebar for the current session. Use for critical findings, created PR URLs, blockers, or other information that should remain visible. For multiple related items, prefer a concise bulleted list and put each URL on its own line so it remains independently clickable. Each content call replaces the previous callout; use clear=true to remove it.",
        input: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description:
                "Concise text or URLs to display. Prefer bullets for multiple items, with each URL on its own line. Replaces the existing callout.",
            },
            clear: {
              type: "boolean",
              description: "Set to true to clear the existing callout.",
            },
          },
          additionalProperties: false,
        },
        // Direct workflow tool: keep it in the provider's native tool list
        // instead of being folded into the CodeMode execute catalog.
        options: { codemode: false },
        async execute(input, context) {
          const args = input as CalloutInput
          if (args.clear === true) {
            await writeCallout(context.sessionID, "")
            return { content: "Callout cleared." }
          }

          const content = args.content?.trim()
          if (!content) throw new Error("Provide content or set clear=true.")
          await writeCallout(context.sessionID, content)
          return { content: "Callout displayed in the sidebar." }
        },
      })
    })
  },
})
