import { isAbsolute, resolve } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"

export const OpenInFinderPlugin: Plugin = async ({ $, directory }) => {
  return {
    "command.execute.before": async (input, _output) => {
      if (input.command !== "open") return

      // No args: open the cwd in Finder.
      // With args: treat as a path (strip a leading @ from file references)
      // and open with the system default program.
      const raw = input.arguments?.trim() ?? ""
      const arg = raw.replace(/^@/, "")
      const target = arg === "" ? directory : isAbsolute(arg) ? arg : resolve(directory, arg)

      await $`open ${target}`.nothrow().quiet()

      // Short-circuit so the command template isn't sent to the LLM.
      throw new Error("opened")
    },
  }
}
