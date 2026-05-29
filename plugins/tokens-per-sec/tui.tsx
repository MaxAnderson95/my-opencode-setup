// @ts-nocheck
/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal } from "solid-js"

const id = "tokens-per-sec"

// Sliding window length for live TPS. Short = responsive but jittery; long = smooth but laggy.
const WINDOW_MS = 1500
// UI refresh rate.
const HEARTBEAT_MS = 100
// If no delta arrives for longer than this, force live TPS to 0 (we're not generating right now).
const STALE_DELTA_MS = 2000
// Rough tokenizer approximation when the provider doesn't give us a token count.
// Claude/GPT English prose ~4, code ~3, DeepSeek ~2-3. Configurable via { charsPerToken }.
const DEFAULT_CHARS_PER_TOKEN = 3

type WindowEntry = { t: number; chars: number }
type TurnState = {
  firstDeltaTime: number
  lastDeltaTime: number
  totalChars: number
  // Sum of intervals between consecutive deltas that were closer than STALE_DELTA_MS apart.
  // This excludes time spent waiting on tools, network stalls, etc.
  activeMs: number
}
type AvgDisplay = {
  tps: number
  // True when we used the provider's token count, false when we fell back to the char heuristic.
  fromProvider: boolean
}

const tui: TuiPlugin = async (api, options) => {
  if (options && options.enabled === false) return

  const charsPerToken =
    typeof options?.charsPerToken === "number" && options.charsPerToken > 0
      ? options.charsPerToken
      : DEFAULT_CHARS_PER_TOKEN

  // Per-session sliding window of delta arrivals (live TPS).
  const windows = new Map<string, WindowEntry[]>()
  // Per-session latest live TPS value.
  const tpsMap = new Map<string, number>()
  // Per-session in-progress turn accounting (for fallback avg + denominator).
  const turns = new Map<string, TurnState>()
  // Per-session most recent completed-turn average. Persists until a new turn starts.
  const avgMap = new Map<string, AvgDisplay>()
  // Bumped once per heartbeat so slot memos re-evaluate.
  const [tick, setTick] = createSignal(0)

  const recomputeLive = (now: number) => {
    for (const [sid, win] of windows) {
      const pruned = win.filter((e) => now - e.t < WINDOW_MS)
      if (pruned.length < 2) {
        if (pruned.length === 0) windows.delete(sid)
        tpsMap.set(sid, 0)
        continue
      }
      windows.set(sid, pruned)
      if (now - pruned[pruned.length - 1].t > STALE_DELTA_MS) {
        tpsMap.set(sid, 0)
        continue
      }
      const totalChars = pruned.reduce((s, e) => s + e.chars, 0)
      const span = (pruned[pruned.length - 1].t - pruned[0].t) / 1000
      const effectiveSpan = Math.max(span, 0.25)
      const tps = Math.round(totalChars / charsPerToken / effectiveSpan)
      tpsMap.set(sid, tps)
    }
  }

  const heartbeat = setInterval(() => {
    recomputeLive(Date.now())
    setTick((t) => t + 1)
  }, HEARTBEAT_MS)
  api.lifecycle.onDispose(() => clearInterval(heartbeat))

  // Every streamed delta contributes to throughput and to the turn's active time budget.
  api.event.on("message.part.delta", (event) => {
    const sid = event.properties.sessionID
    const delta = event.properties.delta
    if (!sid || typeof delta !== "string" || delta.length === 0) return
    const now = Date.now()

    const win = windows.get(sid) ?? []
    win.push({ t: now, chars: delta.length })
    windows.set(sid, win)

    let turn = turns.get(sid)
    if (!turn) {
      turn = { firstDeltaTime: now, lastDeltaTime: now, totalChars: delta.length, activeMs: 0 }
    } else {
      const gap = now - turn.lastDeltaTime
      if (gap > 0 && gap < STALE_DELTA_MS) turn.activeMs += gap
      turn.lastDeltaTime = now
      turn.totalChars += delta.length
    }
    turns.set(sid, turn)
    // A new turn invalidates any previously shown avg.
    if (avgMap.has(sid)) avgMap.delete(sid)
  })

  // When the assistant message finalizes, lock in the provider-reported avg if we can.
  api.event.on("message.updated", (event) => {
    const info = event.properties?.info
    if (!info || info.role !== "assistant") return
    if (!info.time?.completed) return
    const sid = info.sessionID
    if (!sid) return
    const turn = turns.get(sid)

    // Prefer provider token count over our char heuristic.
    const providerOutput = info.tokens?.output ?? 0
    let tps = 0
    let fromProvider = false

    if (turn && turn.activeMs > 250) {
      const seconds = turn.activeMs / 1000
      if (providerOutput > 0) {
        tps = Math.round(providerOutput / seconds)
        fromProvider = true
      } else {
        tps = Math.round(turn.totalChars / charsPerToken / seconds)
      }
    } else if (providerOutput > 0 && info.time.created) {
      // No streaming deltas tracked (e.g. cached/instant response) — fall back to wall time.
      const seconds = Math.max((info.time.completed - info.time.created) / 1000, 0.25)
      tps = Math.round(providerOutput / seconds)
      fromProvider = true
    }

    if (tps > 0) avgMap.set(sid, { tps, fromProvider })
    turns.delete(sid)
  })

  // Reset live window state when the turn finishes; keep avg so the user can see it.
  api.event.on("session.idle", (event) => {
    const sid = event.properties?.sessionID
    if (!sid) return
    windows.delete(sid)
    tpsMap.set(sid, 0)
    turns.delete(sid)
  })

  api.slots.register({
    slots: {
      session_prompt_right(ctx, props) {
        const status = createMemo(() => api.state.session.status(props.session_id))
        const live = createMemo(() => {
          tick()
          return tpsMap.get(props.session_id) ?? 0
        })
        const avg = createMemo(() => {
          tick()
          return avgMap.get(props.session_id)
        })
        const label = createMemo(() => {
          const busy = status()?.type === "busy"
          if (busy) return `${live()} tok/s`
          const a = avg()
          if (a) return `${a.tps} tok/s avg`
          return `0 tok/s`
        })
        return <text fg={ctx.theme.current.textMuted}> {label()}</text>
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
