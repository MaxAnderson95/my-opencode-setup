import type { Plugin } from "@opencode-ai/plugin"

// Reports tool calls that start and then never reach a terminal state, which is
// what a "stuck session" looks like from the inside.
//
// This exists because neither of the two obvious signals can answer the
// question on its own:
//
//   - The `tool.execute.before` / `tool.execute.after` hook pair only records
//     tool calls that finish NORMALLY. There is no error or abort hook, so a
//     call that throws, is interrupted, or dies with the process simply never
//     fires `after`. A missing `after` therefore conflates four different
//     outcomes and cannot be read as "it hung".
//   - OTLP traces do capture the real span tree, but a span that never ends is
//     never exported by the batch span processor. A genuine hang shows up in
//     Tempo as an absence, which is exactly the shape that is hard to alert on.
//
// The bus event stream is the one place a hang is observable as a positive
// fact: `message.part.updated` carries the authoritative tool state machine
// (pending -> running -> completed | error), so a part sitting in `running`
// past a threshold is a hang and can be reported while it is still happening.
//
// WHY IT ALSO WATCHES THE CHILD SESSION
//
// "Parent has been waiting 15 minutes" is not by itself a fault. Subagents
// legitimately run for 8-25 minutes, and reporting elapsed time alone fires
// identically for a healthy long task and a wedged one. The 2026-08-05 incident
// made the distinction concrete: three subagents were cancelled and logged
// `error=Aborted` at 19:16:41, yet their parent's `task` parts sat in `running`
// for a further 22 minutes because BackgroundJob.wait parks on a Deferred that
// nothing fulfils once the child dies outside the interrupt path. The parent
// never learned its children were gone.
//
// The child's own part activity separates the two cases, so this tracks
// per-session recency and classifies each overdue call:
//
//   child-active  - child produced output recently. Slow, not stuck.
//   child-silent  - child has produced nothing for a while. THIS is the bug;
//                   reported at ERROR because the parent will now wait forever.
//   child-unknown - no child session id in the tool metadata yet.
//   no-child-work - a child session exists but has never produced anything,
//                   i.e. the subagent never started at all.
//
// Output goes through `client.app.log`, so it lands in opencode.log and — when
// OTEL_EXPORTER_OTLP_ENDPOINT is set — is exported as an OTLP log record
// carrying trace_id/span_id and the same resource attributes as the traces,
// which is what lets a report be tied back to the process, client, and trace
// that produced it.

const SERVICE = "stuck-watchdog"

/** How often to sweep for overdue calls. */
const SWEEP_MS = num("OPENCODE_WATCHDOG_SWEEP_MS", 60_000)

/**
 * Elapsed times at which an in-flight call is reported. Re-reporting at
 * widening intervals distinguishes "slow" from "wedged" without one stuck call
 * producing a line every sweep for the rest of the process's life.
 */
const REPORT_AFTER_MS = list("OPENCODE_WATCHDOG_THRESHOLDS_MS", [
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
  4 * 60 * 60_000,
])

/**
 * How long a child session must be quiet before its parent's wait is treated as
 * a hang rather than slowness. Generous: a subagent can legitimately sit inside
 * one long tool call (a big test run, a slow fetch) without emitting parts.
 */
const CHILD_SILENT_MS = num("OPENCODE_WATCHDOG_CHILD_SILENT_MS", 180_000)

/**
 * Safety valves. A tracker leak in a diagnostic plugin would be its own
 * incident, so both maps are bounded and evict rather than growing without
 * limit.
 */
const MAX_TRACKED = num("OPENCODE_WATCHDOG_MAX_TRACKED", 5_000)
const MAX_SESSIONS = num("OPENCODE_WATCHDOG_MAX_SESSIONS", 1_000)

function num(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function list(name: string, fallback: number[]): number[] {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = raw
    .split(",")
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isFinite(entry) && entry > 0)
  return parsed.length > 0 ? parsed.sort((a, b) => a - b) : fallback
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

/**
 * Identity of the process doing the reporting. `opencode.client` alone is not
 * enough to place a report: several servers can share one client label, and the
 * port is what maps a report back to a specific process in `ps` or `lsof`.
 */
function processIdentity() {
  const port = process.argv.join(" ").match(/--port[= ](\d+)/)?.[1]
  return {
    pid: process.pid,
    port: port ? Number(port) : undefined,
    client: process.env["OPENCODE_CLIENT"] ?? "cli",
  }
}

type Tracked = {
  tool: string
  callID: string
  sessionID: string
  /** Subagent session this call is waiting on, once the tool reports it. */
  childSessionID?: string
  startedAt: number
  /** Index into REPORT_AFTER_MS of the next threshold still to be reported. */
  nextThreshold: number
  reported: boolean
}

export const StuckWatchdogPlugin: Plugin = async ({ client }) => {
  const identity = processIdentity()
  const inflight = new Map<string, Tracked>()
  /**
   * sessionID -> last time that session produced any part. Re-inserted on every
   * update so Map iteration order is least-recently-active first, which makes
   * eviction from the front an LRU eviction.
   */
  const lastActivity = new Map<string, number>()

  const log = (level: "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) =>
    client.app
      .log({ body: { service: SERVICE, level, message, extra: { ...identity, ...extra } } })
      .catch(() => {})

  const touch = (sessionID: string, at: number) => {
    lastActivity.delete(sessionID)
    lastActivity.set(sessionID, at)
    while (lastActivity.size > MAX_SESSIONS) {
      const oldest = lastActivity.keys().next().value
      if (oldest === undefined) break
      lastActivity.delete(oldest)
    }
  }

  /** Classify why a call is overdue, which is the part that makes a report actionable. */
  const assess = (entry: Tracked, now: number) => {
    if (!entry.childSessionID) return { verdict: "child-unknown" as const }
    const seen = lastActivity.get(entry.childSessionID)
    if (seen === undefined) {
      // Tool metadata named a child, but that session has never emitted a part.
      // The subagent never got off the ground.
      return { verdict: "no-child-work" as const, childSessionID: entry.childSessionID }
    }
    const silentMs = now - seen
    return {
      verdict: silentMs >= CHILD_SILENT_MS ? ("child-silent" as const) : ("child-active" as const),
      childSessionID: entry.childSessionID,
      childSilentMs: silentMs,
      childSilent: formatDuration(silentMs),
    }
  }

  const sweep = () => {
    const now = Date.now()
    for (const entry of inflight.values()) {
      const elapsed = now - entry.startedAt
      // Report at most one threshold per sweep so a long-idle process waking up
      // does not emit the whole ladder for a single call at once.
      if (entry.nextThreshold >= REPORT_AFTER_MS.length) continue
      if (elapsed < REPORT_AFTER_MS[entry.nextThreshold]!) continue
      entry.nextThreshold++
      entry.reported = true
      const assessment = assess(entry, now)
      // A silent or never-started child means the parent is waiting on something
      // that is already gone, so it deserves more than a warning.
      const level =
        assessment.verdict === "child-silent" || assessment.verdict === "no-child-work" ? "error" : "warn"
      void log(level, "tool call still running", {
        tool: entry.tool,
        callID: entry.callID,
        sessionID: entry.sessionID,
        elapsedMs: elapsed,
        elapsed: formatDuration(elapsed),
        ...assessment,
      })
    }
  }

  const timer = setInterval(sweep, SWEEP_MS)
  // Never hold the process open on account of the watchdog.
  timer.unref?.()

  return {
    dispose: async () => {
      clearInterval(timer)
    },

    event: async ({ event }) => {
      if (event.type !== "message.part.updated") return
      const part = (event as { properties?: { part?: any } }).properties?.part
      if (!part || typeof part.sessionID !== "string") return

      const now = Date.now()
      // Every part from any session, not just tool parts — this is the liveness
      // signal a parent's wait gets assessed against.
      touch(part.sessionID, now)

      if (part.type !== "tool" || typeof part.callID !== "string") return

      const status: string | undefined = part.state?.status
      const key = `${part.sessionID}:${part.callID}`
      // The task tool publishes the subagent's session id through ctx.metadata,
      // which lands here. It is absent on the first event and appears shortly
      // after, so it is refreshed on every update rather than read once.
      const childSessionID: string | undefined =
        typeof part.state?.metadata?.childSessionID === "string" ? part.state.metadata.childSessionID : undefined

      if (status === "running" || status === "pending") {
        const existing = inflight.get(key)
        if (existing) {
          if (childSessionID) existing.childSessionID = childSessionID
          return
        }
        if (inflight.size >= MAX_TRACKED) {
          const oldest = inflight.keys().next().value
          if (oldest !== undefined) inflight.delete(oldest)
        }
        // Prefer the state's own start time over Date.now(): replayed or
        // late-delivered events would otherwise reset a call's apparent age.
        const started = Number(part.state?.time?.start)
        inflight.set(key, {
          tool: part.tool ?? "unknown",
          callID: part.callID,
          sessionID: part.sessionID,
          childSessionID,
          startedAt: Number.isFinite(started) && started > 0 ? started : now,
          nextThreshold: 0,
          reported: false,
        })
        return
      }

      if (status !== "completed" && status !== "error") return
      const entry = inflight.get(key)
      inflight.delete(key)
      // Only worth a line if we had already complained about it — this is the
      // record that a call recovered rather than stayed wedged, and it is the
      // terminal state the `tool.execute.after` hook would have missed on the
      // error path.
      if (!entry?.reported) return
      const elapsed = now - entry.startedAt
      void log("info", "previously stuck tool call resolved", {
        tool: entry.tool,
        callID: entry.callID,
        sessionID: entry.sessionID,
        ...(entry.childSessionID ? { childSessionID: entry.childSessionID } : {}),
        status,
        elapsedMs: elapsed,
        elapsed: formatDuration(elapsed),
      })
    },
  }
}
