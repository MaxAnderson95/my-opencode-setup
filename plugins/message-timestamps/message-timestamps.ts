import { Plugin } from "@opencode-ai/plugin"

// Gives the model a clock. Two surfaces:
//
//   1. Every user prompt is stamped with the wall-clock time it was sent. An
//      idle-gap marker and the previous turn's duration are added when either
//      is large enough to matter.
//   2. Tool results are stamped selectively, so that a long agentic turn keeps
//      reporting the time instead of leaving the model stuck on the reading it
//      got when the turn started.
//
// Without this the model has only "Today's date" from the system prompt and
// treats a three-day-old resumed session as if the last tool call just ran.
//
// Why the session "context" hook (v2) instead of persisting parts (v1):
//   - v1 wrote a synthetic part once at message creation via chat.message,
//     which does not exist in v2. The context hook instead rewrites the
//     outbound request on every dispatch, so nothing is persisted and nothing
//     appears in the transcript.
//   - Prompt caching is exact-prefix matching, so the transform MUST be
//     deterministic: identical stored history has to produce byte-identical
//     context on every dispatch. Every stamp here is therefore derived from
//     each message's persisted, immutable identifier - never from Date.now()
//     applied to old messages. A message's stamp depends only on itself and
//     the messages before it, so appending new turns never rewrites the
//     prefix.
//   - Message ids ("msg_" + ascending()) encode their creation instant:
//     12 hex chars carrying the low 48 bits of (epoch_ms << 12 | counter),
//     i.e. the low 36 bits of epoch milliseconds (~795-day window). The
//     current clock only anchors which window a message falls in; the
//     recovered instant itself is exact and stable across dispatches.
//
// Tool-result stamps still use Date.now(), which is safe for caching because
// the execute.after mutation happens exactly once and the mutated content is
// persisted with the message, then replayed verbatim on later dispatches.
//
// Assistant messages are deliberately left alone. Their parts are replayed
// verbatim and are position-sensitive for signed reasoning blocks, so
// injecting text into them risks provider rejection for no information the
// surrounding user stamps do not already carry.

const DEFAULT_GAP_MINUTES = 30
const DEFAULT_TURN_MINUTES = 2
const DEFAULT_TOOL_SECONDS = 30
const DEFAULT_INTERVAL_MINUTES = 10

// The id timestamp keeps only the low 36 bits of epoch milliseconds.
const ID_ERA_MS = 2n ** 36n

// Recovers the creation instant encoded in an ascending message id. `now`
// anchors the 36-bit window; any reference clock at or after the message's
// creation (and within ~795 days of it) recovers the exact original instant,
// so the result is deterministic across dispatches.
function messageCreatedMs(id: string | undefined, now: number): number | undefined {
  if (id === undefined || !id.startsWith("msg_")) return undefined
  const hex = id.slice(4, 16)
  if (!/^[0-9a-f]{12}$/.test(hex)) return undefined
  const low = BigInt("0x" + hex) >> 12n
  const candidate = (BigInt(now) / ID_ERA_MS) * ID_ERA_MS + low
  return Number(candidate > BigInt(now) ? candidate - ID_ERA_MS : candidate)
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

type TextPart = { type: "text"; text: string }

// The context hook hands over @opencode-ai/ai Message class instances, but
// that package is not resolvable from this plugin's node_modules. Rebuilding
// through the instance's own constructor keeps the result a real Message
// (schema fields are own enumerable properties, so the spread carries them
// all) without adding the dependency.
function appendText<M extends { readonly content: ReadonlyArray<unknown> }>(message: M, parts: readonly TextPart[]): M {
  const ctor = message.constructor as new (fields: Record<string, unknown>) => M
  return new ctor({ ...message, content: [...message.content, ...parts] })
}

export default Plugin.define({
  id: "message-timestamps",
  setup: async (ctx) => {
    const enabled = process.env["OPENCODE_MESSAGE_TIMESTAMPS"] !== "0"
    const toolsEnabled = process.env["OPENCODE_MESSAGE_TIMESTAMPS_TOOLS"] !== "0"
    const gapThresholdMs = envNumber("OPENCODE_MESSAGE_TIMESTAMP_GAP_MINUTES", DEFAULT_GAP_MINUTES) * 60_000
    const turnThresholdMs = envNumber("OPENCODE_MESSAGE_TIMESTAMP_TURN_MINUTES", DEFAULT_TURN_MINUTES) * 60_000
    const toolThresholdMs = envNumber("OPENCODE_MESSAGE_TIMESTAMP_TOOL_SECONDS", DEFAULT_TOOL_SECONDS) * 1_000
    const intervalMs = envNumber("OPENCODE_MESSAGE_TIMESTAMP_INTERVAL_MINUTES", DEFAULT_INTERVAL_MINUTES) * 60_000
    if (!enabled) return

    const toolStarts = new Map<string, number>()
    // When the model last saw a clock reading in a given session, so that tool
    // results only get stamped once the reading has gone stale. Runtime
    // bookkeeping only - it never feeds the context transform, so it cannot
    // break determinism. Lost on restart, which merely means the next
    // qualifying tool result is stamped a little early (same as v1).
    const lastReading = new Map<string, number>()

    await ctx.session.hook("context", (event) => {
      const now = Date.now()
      // Creation instant of the message preceding the one being examined, and
      // of the user prompt that opened the previous turn. Both come from ids,
      // so recomputing them every dispatch yields identical stamps.
      let previous: number | undefined
      let turnStart: number | undefined
      let newestPrompt: number | undefined

      event.messages = event.messages.map((message) => {
        const created = messageCreatedMs(message.id, now)
        if (created === undefined) return message
        // Real user prompts carry a metadata object (opencode always spreads
        // one in); synthetic reminders, compaction checkpoints, and shell
        // records are user-role but leave metadata undefined. Only real
        // prompts get stamped, matching v1's chat.message coverage.
        const prompt = message.role === "user" && message.metadata !== undefined

        let next = message
        const stamped = message.content.some((part) => part.type === "text" && part.text.startsWith("<time>"))
        if (prompt && !stamped) {
          const parts: TextPart[] = [{ type: "text", text: `<time>${formatLocal(new Date(created))}</time>` }]
          const notes: string[] = []
          if (previous !== undefined) {
            const idleMs = created - previous
            if (idleMs >= gapThresholdMs) notes.push(`Session resumed after ${formatDuration(idleMs)}`)
            if (turnStart !== undefined) {
              const turnMs = previous - turnStart
              if (turnMs >= turnThresholdMs) notes.push(`Previous turn took ${formatDuration(turnMs)}`)
            }
          }
          if (notes.length > 0) parts.push({ type: "text", text: `<time-gap>${notes.join(" · ")}</time-gap>` })
          next = appendText(message, parts)
        }

        if (prompt) {
          turnStart = created
          newestPrompt = created
        }
        previous = created
        return next
      })

      if (newestPrompt !== undefined) {
        const current = lastReading.get(event.sessionID)
        if (current === undefined || newestPrompt > current) lastReading.set(event.sessionID, newestPrompt)
      }
    })

    if (!toolsEnabled) return

    await ctx.tool.hook("execute.before", (event) => {
      toolStarts.set(event.id, Date.now())
    })

    // Appends a clock reading to the tool's model-visible content, but only
    // when the reading is worth its tokens: the tool itself ran long, or
    // enough time has passed that the model's last reading has gone stale
    // mid-turn. Cache-safe because the mutated result is persisted once with
    // the message and replayed verbatim afterwards.
    await ctx.tool.hook("execute.after", (event) => {
      const started = toolStarts.get(event.id)
      toolStarts.delete(event.id)
      if (event.status !== "completed") return

      const finished = Date.now()
      const durationMs = started === undefined ? undefined : finished - started
      const previousReading = lastReading.get(event.sessionID)
      const stale = previousReading === undefined || finished - previousReading >= intervalMs
      const slow = durationMs !== undefined && durationMs >= toolThresholdMs
      if (!stale && !slow) return

      const detail = durationMs === undefined ? "" : `, took ${formatDuration(durationMs)}`
      const stamp = `\n<time>${formatLocal(new Date(finished))}${detail}</time>`

      // Only extend trailing text, mirroring v1's string-output-only rule:
      // results ending in a file (image) are left untouched rather than
      // reshaping their content.
      const content = event.result.content
      if (typeof content === "string") {
        event.result = { ...event.result, content: content + stamp }
      } else if (content !== undefined && content.length > 0) {
        const last = content.at(-1)
        if (last === undefined || last.type !== "text") return
        event.result = { ...event.result, content: [...content.slice(0, -1), { type: "text", text: last.text + stamp }] }
      } else if (typeof event.result.output === "string") {
        // With no explicit content the model sees the stringified output, so
        // materialize that string plus the stamp; `output` itself is untouched.
        event.result = { ...event.result, content: event.result.output + stamp }
      } else {
        return
      }
      lastReading.set(event.sessionID, finished)
    })
  },
})
