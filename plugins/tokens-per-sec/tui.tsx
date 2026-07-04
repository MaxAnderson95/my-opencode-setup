// @ts-nocheck
/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal } from "solid-js"
import { readFileSync, writeFileSync } from "node:fs"

const id = "tokens-per-sec"

// Sliding window length for live TPS. Short = responsive but jittery; long = smooth but laggy.
const WINDOW_MS = 1500
// UI refresh rate.
const HEARTBEAT_MS = 100
// If no delta arrives for longer than this, force live TPS to 0 (we're not generating right now).
const STALE_DELTA_MS = 2000
// Fallback chars/token for models we have no calibration or seed for. Overridable via { charsPerToken }.
const DEFAULT_CHARS_PER_TOKEN = 2.5

// ── Calibration ────────────────────────────────────────────────────────────────
// Instead of a fixed chars/token constant, we learn tokens-per-char per model from
// ground truth: every `session.next.step.ended` event carries the provider-billed
// token count for that LLM call. Dividing by the chars we saw streamed during the
// step gives the true ratio. A weighted EMA converges within a few steps and is
// persisted across restarts.
//
// Steps dominated by reasoning are EXCLUDED from calibration: Anthropic bills full
// thinking but streams only a summary, and OpenAI hides reasoning entirely, so
// those steps' token counts are not explainable by streamed chars. The live meter
// therefore measures the rate of what is actually streaming; the per-step ground
// truth (also computed here) captures billed reality at every tool boundary.
const CAL_MIN_STEP_CHARS = 300
const CAL_MIN_STEP_TOKENS = 25
const CAL_MAX_REASONING_FRAC = 0.15
// Plausibility guard for a single observation (retries / dropped deltas produce garbage).
const CAL_TPC_MIN = 0.08
const CAL_TPC_MAX = 1.5
// EMA weight cap: keeps old data from freezing the ratio if a provider changes tokenizers.
const CAL_WEIGHT_CAP = 20000
// Weight granted to seeds / a single step's contribution.
const CAL_SEED_WEIGHT = 2000
const CAL_STEP_WEIGHT_CAP = 4000
// A step needs this much active streaming time before its real TPS is trustworthy.
const MIN_STEP_ACTIVE_MS = 500
const SAVE_INTERVAL_MS = 15000

// Seed ratios (tokens per char) measured from local opencode history (30 days,
// text-only steps, provider-billed counts). Used until live calibration takes over.
const SEED_TPC: Record<string, number> = {
  "anthropic/claude-opus-4-8": 1 / 2.19,
  "anthropic/claude-opus-4-7": 1 / 2.19,
  "anthropic/claude-fable-5": 1 / 2.12,
  "openai/gpt-5.5": 1 / 3.61,
  "openai/gpt-5.5-fast": 1 / 3.81,
  "github-copilot/gpt-5.5": 1 / 3.48,
  "opencode-go/kimi-k2.7-code": 1 / 3.87,
}

type WindowEntry = { t: number; chars: number }
type TurnState = {
  firstDeltaTime: number
  lastDeltaTime: number
  totalChars: number
  // Sum of intervals between consecutive deltas that were closer than STALE_DELTA_MS apart.
  // This excludes time spent waiting on tools, network stalls, etc.
  activeMs: number
}
// Per-step accumulator, reset at every session.next.step.ended (i.e. per LLM call).
type StepState = {
  chars: number
  reasoningChars: number
  lastDeltaTime: number
  activeMs: number
}
type AvgDisplay = {
  tps: number
  // True when computed from provider-billed tokens, false when char-heuristic fallback.
  fromProvider: boolean
}
type Ratio = { tpc: number; weight: number }

const tui: TuiPlugin = async (api, options) => {
  if (options && options.enabled === false) return

  const fallbackTpc =
    1 /
    (typeof options?.charsPerToken === "number" && options.charsPerToken > 0
      ? options.charsPerToken
      : DEFAULT_CHARS_PER_TOKEN)

  // ── Calibration store ──
  const calPath = new URL("./calibration.json", import.meta.url)
  const ratios = new Map<string, Ratio>()
  let calDirty = false
  let lastSave = 0

  try {
    const saved = JSON.parse(readFileSync(calPath, "utf8"))
    for (const [key, val] of Object.entries(saved?.models ?? {})) {
      if (typeof val?.tpc === "number" && val.tpc > 0) {
        ratios.set(key, { tpc: val.tpc, weight: typeof val.weight === "number" ? val.weight : CAL_SEED_WEIGHT })
      }
    }
  } catch {
    // No calibration file yet (or unreadable) — seeds cover us.
  }
  for (const [key, tpc] of Object.entries(SEED_TPC)) {
    if (!ratios.has(key)) ratios.set(key, { tpc, weight: CAL_SEED_WEIGHT })
  }

  const saveCalibration = () => {
    if (!calDirty) return
    try {
      const models: Record<string, unknown> = {}
      for (const [key, r] of ratios) {
        models[key] = { tpc: Number(r.tpc.toFixed(6)), weight: Math.round(r.weight), updated: new Date().toISOString() }
      }
      writeFileSync(calPath, JSON.stringify({ version: 1, models }, null, 2))
      calDirty = false
    } catch {
      // Read-only FS or similar — calibration still works in-memory for this run.
    }
  }

  // ── Per-session state ──
  const windows = new Map<string, WindowEntry[]>()
  const tpsMap = new Map<string, number>()
  const turns = new Map<string, TurnState>()
  const steps = new Map<string, StepState>()
  const avgMap = new Map<string, AvgDisplay>()
  // Latest provider/model per session, keyed from step.started (authoritative, per LLM call).
  const sessionModel = new Map<string, string>()
  // partID → part type, so delta chars can be split into reasoning vs text/tool buckets.
  const partTypes = new Map<string, string>()
  // Bumped once per heartbeat so slot memos re-evaluate.
  const [tick, setTick] = createSignal(0)

  const tpcFor = (sid: string): number => {
    const key = sessionModel.get(sid)
    if (key) {
      const r = ratios.get(key)
      if (r) return r.tpc
    }
    return fallbackTpc
  }

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
      const tps = Math.round((totalChars * tpcFor(sid)) / effectiveSpan)
      tpsMap.set(sid, tps)
    }
  }

  const heartbeat = setInterval(() => {
    const now = Date.now()
    recomputeLive(now)
    if (calDirty && now - lastSave > SAVE_INTERVAL_MS) {
      lastSave = now
      saveCalibration()
    }
    setTick((t) => t + 1)
  }, HEARTBEAT_MS)
  api.lifecycle.onDispose(() => {
    clearInterval(heartbeat)
    saveCalibration()
  })

  // Part types let us tell reasoning deltas apart from text/tool-arg deltas.
  api.event.on("message.part.updated", (event) => {
    const part = event.properties?.part
    if (part?.id && part.type) partTypes.set(part.id, part.type)
  })

  // Authoritative model per session, refreshed at every LLM call.
  api.event.on("session.next.step.started", (event) => {
    const p = event.properties
    if (!p?.sessionID || !p.model) return
    sessionModel.set(p.sessionID, `${p.model.providerID}/${p.model.id}`)
  })

  // Every streamed delta contributes to live throughput, step accounting, and the
  // turn's active time budget.
  api.event.on("message.part.delta", (event) => {
    const sid = event.properties.sessionID
    const delta = event.properties.delta
    if (!sid || typeof delta !== "string" || delta.length === 0) return
    const now = Date.now()

    const win = windows.get(sid) ?? []
    win.push({ t: now, chars: delta.length })
    windows.set(sid, win)

    const isReasoning = partTypes.get(event.properties.partID) === "reasoning"

    let step = steps.get(sid)
    if (!step) {
      step = { chars: 0, reasoningChars: 0, lastDeltaTime: now, activeMs: 0 }
    } else {
      const gap = now - step.lastDeltaTime
      if (gap > 0 && gap < STALE_DELTA_MS) step.activeMs += gap
      step.lastDeltaTime = now
    }
    step.chars += delta.length
    if (isReasoning) step.reasoningChars += delta.length
    steps.set(sid, step)

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

  // Ground truth arrives here: provider-billed tokens for the LLM call that just
  // finished. Feed the calibrator and refresh the displayed avg at every step
  // boundary instead of only at end of turn.
  api.event.on("session.next.step.ended", (event) => {
    const p = event.properties
    const sid = p?.sessionID
    if (!sid || !p.tokens) return
    // OpenAI-style providers report reasoning separately from output; Anthropic
    // folds thinking into output (reasoning=0). Sum is total generated either way.
    const tokens = (p.tokens.output ?? 0) + (p.tokens.reasoning ?? 0)
    const step = steps.get(sid)
    steps.delete(sid)
    if (!step || tokens < CAL_MIN_STEP_TOKENS) return

    if (step.activeMs >= MIN_STEP_ACTIVE_MS) {
      avgMap.set(sid, { tps: Math.round(tokens / (step.activeMs / 1000)), fromProvider: true })
    }

    const modelKey = sessionModel.get(sid)
    if (!modelKey || step.chars < CAL_MIN_STEP_CHARS) return
    const reasoningTokFrac = p.tokens.reasoning ? p.tokens.reasoning / tokens : 0
    const reasoningCharFrac = step.reasoningChars / step.chars
    // Reasoning-polluted steps carry billed tokens that never streamed — skip them.
    if (reasoningTokFrac >= CAL_MAX_REASONING_FRAC || reasoningCharFrac >= CAL_MAX_REASONING_FRAC) return

    const observed = tokens / step.chars
    if (observed < CAL_TPC_MIN || observed > CAL_TPC_MAX) return
    const w = Math.min(tokens, CAL_STEP_WEIGHT_CAP)
    const prev = ratios.get(modelKey)
    if (!prev) {
      ratios.set(modelKey, { tpc: observed, weight: w })
    } else {
      const W = Math.min(prev.weight, CAL_WEIGHT_CAP)
      ratios.set(modelKey, {
        tpc: (prev.tpc * W + observed * w) / (W + w),
        weight: Math.min(W + w, CAL_WEIGHT_CAP),
      })
    }
    calDirty = true
  })

  // When the assistant message finalizes, lock in the whole-turn provider avg.
  api.event.on("message.updated", (event) => {
    const info = event.properties?.info
    if (!info || info.role !== "assistant") return
    if (!info.time?.completed) return
    const sid = info.sessionID
    if (!sid) return
    const turn = turns.get(sid)

    const providerTokens = (info.tokens?.output ?? 0) + (info.tokens?.reasoning ?? 0)
    let tps = 0
    let fromProvider = false

    if (turn && turn.activeMs > 250) {
      const seconds = turn.activeMs / 1000
      if (providerTokens > 0) {
        tps = Math.round(providerTokens / seconds)
        fromProvider = true
      } else {
        tps = Math.round((turn.totalChars * tpcFor(sid)) / seconds)
      }
    } else if (providerTokens > 0 && info.time.created) {
      // No streaming deltas tracked (e.g. cached/instant response) — fall back to wall time.
      const seconds = Math.max((info.time.completed - info.time.created) / 1000, 0.25)
      tps = Math.round(providerTokens / seconds)
      fromProvider = true
    }

    if (tps > 0) avgMap.set(sid, { tps, fromProvider })
    turns.delete(sid)
    steps.delete(sid)
  })

  // Reset live window state when the turn finishes; keep avg so the user can see it.
  api.event.on("session.idle", (event) => {
    const sid = event.properties?.sessionID
    if (!sid) return
    windows.delete(sid)
    tpsMap.set(sid, 0)
    turns.delete(sid)
    steps.delete(sid)
    // Keep the part-type cache from growing without bound across long-lived TUIs.
    if (partTypes.size > 4000) partTypes.clear()
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
          // "~" marks a char-heuristic estimate; unmarked values are provider-billed.
          if (a) return `${a.fromProvider ? "" : "~"}${a.tps} tok/s avg`
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
