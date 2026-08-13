import { tool, type Plugin } from "@opencode-ai/plugin"
import { writeCallout } from "./state"

export const CalloutPlugin: Plugin = async () => ({
  tool: {
    callout: tool({
      description:
        "Put important information in the user's OpenCode sidebar for the current session. Use for critical findings, created PR URLs, blockers, or other information that should remain visible. Each content call replaces the previous callout; use clear=true to remove it.",
      args: {
        content: tool.schema
          .string()
          .optional()
          .describe("Concise text or a URL to display. Replaces the existing callout."),
        clear: tool.schema.boolean().optional().describe("Set to true to clear the existing callout."),
      },
      async execute(args, context) {
        if (args.clear === true) {
          await writeCallout(context.sessionID, "")
          return "Callout cleared."
        }

        const content = args.content?.trim()
        if (!content) throw new Error("Provide content or set clear=true.")
        await writeCallout(context.sessionID, content)
        return "Callout displayed in the sidebar."
      },
    }),
  },
})
