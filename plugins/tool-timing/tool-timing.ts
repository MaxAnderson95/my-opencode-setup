import type { Plugin } from "@opencode-ai/plugin"

// Records wall-clock duration of every tool call and appends it to the tool's
// `title`, which OpenCode's TUI renders as the header of the tool-call box.
//
// Why title (not output)?
//   - For native tools, mutating `output.output` works, but the TUI for some
//     tools (bash) reads `metadata.output` — a pre-hook snapshot — so the
//     appended text never appears. See opencode issues #13573, #13575.
//   - For MCP tools, the hook receives the raw CallToolResult and text is
//     re-assembled from `result.content[]` after the hook returns, so
//     `output.output` mutations are discarded. See issue #25918.
//   - `output.title` is the single field that survives for both code paths
//     and is always shown in the TUI tool-call box header.

const startTimes = new Map<string, number>()

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(2)}s`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  return mins === 0 ? `${hours}h` : `${hours}h ${mins}m`
}

export const ToolTimingPlugin: Plugin = async ({ client }) => {
  const log = (level: "info" | "warn" | "error", message: string, extra?: any) =>
    client.app.log({ body: { service: "tool-timing", level, message, extra } }).catch(() => {})

  return {
    "tool.execute.before": async (input) => {
      startTimes.set(input.callID, Date.now())
      await log("info", "before", { tool: input.tool, callID: input.callID })
    },

    "tool.execute.after": async (input, output) => {
      const started = startTimes.get(input.callID)
      startTimes.delete(input.callID)
      if (started === undefined) {
        await log("warn", "after with no start", { tool: input.tool, callID: input.callID })
        return
      }

      const ms = Date.now() - started
      const duration = formatDuration(ms)
      const suffix = ` (${duration})`
      const originalTitle = output.title

      const appendOnce = (val: unknown): string =>
        typeof val === "string"
          ? val.endsWith(suffix)
            ? val
            : `${val || input.tool}${suffix}`
          : `${input.tool}${suffix}`

      output.title = appendOnce(output.title)

      // The TUI for some tools (notably bash) renders from a pre-hook snapshot
      // stored on metadata rather than from `title`. Mirror the duration there.
      if (output.metadata && typeof output.metadata === "object") {
        if ("description" in output.metadata)
          output.metadata.description = appendOnce(output.metadata.description)
        if ("title" in output.metadata)
          output.metadata.title = appendOnce(output.metadata.title)
        output.metadata.durationMs = ms
      }

      await log("info", "after", {
        tool: input.tool,
        callID: input.callID,
        ms,
        originalTitle,
        mutatedTitle: output.title,
        outputKeys: Object.keys(output ?? {}),
        metadataKeys: output.metadata ? Object.keys(output.metadata) : [],
      })
    },
  }
}
