import type { Plugin } from "@opencode-ai/plugin"

// Gives the model a clock. Two surfaces:
//
//   1. Every user message is stamped with the wall-clock time it was sent. An
//      idle-gap marker and the previous turn's duration are added as visible
//      context when either is large enough to matter.
//   2. Tool results are stamped selectively, so that a long agentic turn keeps
//      reporting the time instead of leaving the model stuck on the reading it
//      got when the turn started.
//
// Without this the model has only "Today's date" from the system prompt and
// treats a three-day-old resumed session as if the last tool call just ran.
//
// Note that the durations the tool-timing plugin writes are NOT a substitute:
// it writes `output.title`, and titles never reach the model. Tool results are
// assembled from `part.state.output` alone (session/message-v2.ts).
//
// Why chat.message (and not the system prompt or a per-request transform):
//   - The stamp is written once, at message creation, and persisted with the
//     message. It never changes afterwards, so the request prefix stays
//     byte-identical across turns and prompt caching keeps working.
//   - Injecting the current time into the system prompt would invalidate the
//     whole cache on every single request, since caching is exact-prefix
//     matching. Upstream deliberately keeps only day-granularity there
//     (session/system.ts, `Today's date:`).
//   - Stamping only the newest message and dropping it next turn would rewrite
//     history and invalidate everything from that point on.
//
// The part is marked `synthetic`, which keeps it out of the TUI transcript
// while still sending it to the model, matching how opencode injects its own
// reminders (session/reminders.ts).
//
// Assistant messages are deliberately left alone. Their parts are replayed
// verbatim and are position-sensitive for signed reasoning blocks, so injecting
// text into them risks provider rejection for no information the surrounding
// user stamps do not already carry.

const DEFAULT_GAP_MINUTES = 30
const DEFAULT_TURN_MINUTES = 2
const DEFAULT_TOOL_SECONDS = 30
const DEFAULT_INTERVAL_MINUTES = 10

const ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

let lastTimestamp = 0
let counter = 0

// Mirrors opencode's ascending identifier format (packages/schema/src/identifier.ts):
// 12 hex chars of (epoch_ms << 12 | counter) followed by 14 random chars.
function partID(): string {
  const timestamp = Date.now()
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp
    counter = 0
  }
  counter++

  const value = BigInt(timestamp) * 0x1000n + BigInt(counter)
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0"),
  ).join("")
  const bytes = crypto.getRandomValues(new Uint8Array(14))
  return "prt_" + time + Array.from(bytes, (byte) => ID_CHARS[byte % 62]).join("")
}

function pad(value: number): string {
  return String(value).padStart(2, "0")
}

// ISO 8601 in local time with a real UTC offset, so the model can line the
// stamp up against log timestamps without guessing the timezone.
function formatLocal(date: Date): string {
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? "+" : "-"
  const abs = Math.abs(offset)
  const day = date.toLocaleDateString("en-US", { weekday: "short" })
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)} (${day})`
  )
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  if (hours < 24) return mins === 0 ? `${hours}h` : `${hours}h ${mins}m`
  const days = Math.floor(hours / 24)
  const hrs = hours % 24
  return hrs === 0 ? `${days}d` : `${days}d ${hrs}h`
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export const MessageTimestampsPlugin: Plugin = async ({ client }) => {
  const enabled = process.env["OPENCODE_MESSAGE_TIMESTAMPS"] !== "0"
  const toolsEnabled = process.env["OPENCODE_MESSAGE_TIMESTAMPS_TOOLS"] !== "0"
  const gapThresholdMs = envNumber("OPENCODE_MESSAGE_TIMESTAMP_GAP_MINUTES", DEFAULT_GAP_MINUTES) * 60_000
  const turnThresholdMs = envNumber("OPENCODE_MESSAGE_TIMESTAMP_TURN_MINUTES", DEFAULT_TURN_MINUTES) * 60_000
  const toolThresholdMs = envNumber("OPENCODE_MESSAGE_TIMESTAMP_TOOL_SECONDS", DEFAULT_TOOL_SECONDS) * 1_000
  const intervalMs = envNumber("OPENCODE_MESSAGE_TIMESTAMP_INTERVAL_MINUTES", DEFAULT_INTERVAL_MINUTES) * 60_000

  const log = (level: "info" | "warn" | "error", message: string, extra?: any) =>
    client.app.log({ body: { service: "message-timestamps", level, message, extra } }).catch(() => {})

  const toolStarts = new Map<string, number>()
  // When the model last saw a clock reading in a given session, so that tool
  // results only get stamped once the reading has gone stale.
  const lastReading = new Map<string, number>()
  // When the previous turn started, i.e. the last user message this process
  // saw. Turn duration cannot be read back from the last assistant message:
  // opencode creates a separate assistant message per step, so that would
  // measure the final step rather than the whole turn.
  const turnStarts = new Map<string, number>()

  // When the session was last active, used for the idle gap. Looked up from the
  // server rather than cached in memory so that a session resumed with
  // `opencode -s <id>` days later still reports the real gap.
  const lastActive = async (sessionID: string, currentMessageID: string): Promise<number | undefined> => {
    const result = await client.session.messages({ path: { id: sessionID }, query: { limit: 2 } })
    const messages = (result.data ?? []).filter((msg) => msg.info.id !== currentMessageID)
    if (messages.length === 0) return undefined

    return Math.max(
      ...messages.map((msg) =>
        msg.info.role === "assistant" ? (msg.info.time.completed ?? msg.info.time.created) : msg.info.time.created,
      ),
    )
  }

  return {
    "chat.message": async (_input, output) => {
      if (!enabled) return
      if (output.message.role !== "user") return
      // The hook can fire more than once for a message; never stamp twice.
      if (output.parts.some((part) => part.type === "text" && part.text.startsWith("<time>"))) return

      const created = output.message.time.created
      const stamp = `<time>${formatLocal(new Date(created))}</time>`
      let gap: string | undefined
      lastReading.set(output.message.sessionID, created)

      try {
        const active = await lastActive(output.message.sessionID, output.message.id)
        if (active !== undefined) {
          const notes: string[] = []
          const idleMs = created - active
          if (idleMs >= gapThresholdMs) notes.push(`Session resumed after ${formatDuration(idleMs)}`)

          const turnStart = turnStarts.get(output.message.sessionID)
          const turnMs = turnStart === undefined ? undefined : active - turnStart
          if (turnMs !== undefined && turnMs >= turnThresholdMs)
            notes.push(`Previous turn took ${formatDuration(turnMs)}`)

          if (notes.length > 0) gap = notes.join(" · ")
        }
      } catch (error) {
        await log("warn", "failed to resolve previous message time", { error: String(error) })
      }
      turnStarts.set(output.message.sessionID, created)

      output.parts.push({
        id: partID(),
        messageID: output.message.id,
        sessionID: output.message.sessionID,
        type: "text",
        text: stamp,
        synthetic: true,
      })
      if (gap) {
        const prompt = output.parts.find((part) => part.type === "text" && !part.synthetic)
        if (prompt?.type === "text") prompt.text = `${gap}\n\n${prompt.text}`
      }
    },

    "tool.execute.before": async (input) => {
      if (!enabled || !toolsEnabled) return
      toolStarts.set(input.callID, Date.now())
    },

    // Appends a clock reading to the tool's output, but only when the reading
    // is worth its tokens: the tool itself ran long, or enough time has passed
    // that the model's last reading has gone stale mid-turn.
    //
    // Cache-safe because tool output is persisted once and never rewritten.
    // Only native tools are covered: for MCP tools the result is reassembled
    // from `result.content[]` after this hook returns, so the mutation is
    // discarded (upstream issue #25918).
    "tool.execute.after": async (input, output) => {
      if (!enabled || !toolsEnabled) return
      const started = toolStarts.get(input.callID)
      toolStarts.delete(input.callID)
      if (typeof output.output !== "string") return

      const finished = Date.now()
      const durationMs = started === undefined ? undefined : finished - started
      const previousReading = lastReading.get(input.sessionID)
      const stale = previousReading === undefined || finished - previousReading >= intervalMs
      const slow = durationMs !== undefined && durationMs >= toolThresholdMs
      if (!stale && !slow) return

      const detail = durationMs === undefined ? "" : `, took ${formatDuration(durationMs)}`
      output.output = `${output.output}\n<time>${formatLocal(new Date(finished))}${detail}</time>`
      lastReading.set(input.sessionID, finished)
    },
  }
}
