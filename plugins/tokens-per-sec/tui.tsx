// @ts-nocheck
/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal } from "solid-js"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"

const id = "tokens-per-sec"

// ── Live meter tuning ─────────────────────────────────────────────────────────
// Sliding window length for live TPS. Chars in the window are divided by the
// window's ELAPSED time (not the first→last delta span), so bursty event
// delivery averages out instead of spiking.
const WINDOW_MS = 1500
// UI refresh rate.
const HEARTBEAT_MS = 100
// If no delta arrives for longer than this, live TPS snaps to 0 (nothing is
// visibly streaming — e.g. hidden reasoning, tool wait, network stall).
const STALE_DELTA_MS = 2000
// Floor on elapsed time right after a stream(-streak) starts, so the first few
// deltas can't divide by a near-zero interval.
const MIN_ELAPSED_MS = 400
// Exponential smoothing time constant for the displayed live value.
const EMA_TC_MS = 500
// Fallback chars/token for models with no calibration or seed. Overridable via
// { charsPerToken }.
const DEFAULT_CHARS_PER_TOKEN = 2.8

// ── Avg (provider ground truth) tuning ────────────────────────────────────────
// A step needs at least this much generation wall time / this many tokens
// before its rate contributes to the turn average.
const MIN_STEP_GEN_MS = 400
const MIN_STEP_TOKENS = 15

// ── Calibration ───────────────────────────────────────────────────────────────
// We learn "tokens per visible char" per model from ground truth: every
// `session.next.step.ended` carries provider-billed token counts for that LLM
// call. The key insight (verified against 60 days of local history) is that
// billed counts must be matched to the RIGHT chars:
//
//   * OpenAI-style providers report reasoning tokens SEPARATELY from output,
//     and `tokens.output` covers exactly the visible text + tool-arg stream.
//     → calibrate output tokens against non-reasoning chars.
//   * Anthropic folds thinking into `tokens.output` (reasoning is always 0)
//     while streaming only a thinking summary. Those steps' billed counts are
//     NOT explainable by streamed chars → skip any step that streamed
//     reasoning parts when the provider reported reasoning = 0.
//
// Parts are classified at step END (using the accumulated partID→type map), so
// the "delta arrived before the part's type was known" race can't misbucket
// reasoning chars into the visible pool.
const CAL_MIN_STEP_VISIBLE_CHARS = 300
const CAL_MIN_STEP_TOKENS = 25
// Plausibility guard for a single observation (retries / dropped deltas
// produce garbage). Real ratios: Anthropic ~1/2.1, OpenAI ~1/3.4.
const CAL_TPC_MIN = 0.1
const CAL_TPC_MAX = 0.8
// EMA weight cap: keeps old data from freezing the ratio if a provider changes
// tokenizers.
const CAL_WEIGHT_CAP = 20000
// Weight granted to seeds / a single step's contribution.
const CAL_SEED_WEIGHT = 2000
const CAL_STEP_WEIGHT_CAP = 4000
const SAVE_INTERVAL_MS = 15000

// Seed ratios (tokens per visible char) measured from 60 days of local
// opencode history: provider-billed OUTPUT tokens (reasoning excluded where
// reported; steps that streamed reasoning skipped for Anthropic-style
// providers) divided by streamed text + tool-arg chars. Used until live
// calibration takes over.
const SEED_TPC: Record<string, number> = {
  "anthropic/claude-opus-4-8": 1 / 2.13,
  "anthropic/claude-opus-4-7": 1 / 2.13,
  "anthropic/claude-fable-5": 1 / 2.1,
  "anthropic/claude-sonnet-4-6": 1 / 2.74,
  "openai/gpt-5.6-sol": 1 / 3.21,
  "openai/gpt-5.5": 1 / 3.44,
  "openai/gpt-5.5-fast": 1 / 3.32,
  "openai/gpt-5.4": 1 / 3.04,
  "github-copilot/gpt-5.5": 1 / 3.38,
  "opencode-go/kimi-k3": 1 / 2.86,
  "opencode-go/glm-5.2": 1 / 3.46,
}

// Where learned ratios persist. The old plugin-dir-relative path silently
// failed to write (import.meta.url resolves into opencode's bundle cache), so
// calibration never survived a restart. The opencode data dir always exists
// and is writable.
const CAL_PATH = join(
  process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
  "opencode",
  "tokens-per-sec-calibration.json",
)

type WindowEntry = { t: number; chars: number }
// Per-step accumulator, reset at every session.next.step.ended (one LLM call).
type StepState = {
  startedAt: number
  firstDeltaAt: number
  lastDeltaAt: number
  chars: number
  // partID → chars streamed for that part; classified reasoning-vs-visible at
  // step end, once part types are reliably known.
  parts: Map<string, number>
}
// Whole-turn accumulator across steps; reset at session.idle.
type TurnAcc = {
  tokens: number
  genMs: number
  // False if any step lacked provider-billed counts and used the char
  // heuristic instead.
  fromProvider: boolean
}
type AvgDisplay = {
  tps: number
  // True when computed from provider-billed tokens, false when char-heuristic
  // fallback.
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
  const ratios = new Map<string, Ratio>()
  let calDirty = false
  let lastSave = 0

  try {
    const saved = JSON.parse(readFileSync(CAL_PATH, "utf8"))
    for (const [key, val] of Object.entries(saved?.models ?? {})) {
      if (typeof val?.tpc === "number" && val.tpc > 0) {
        ratios.set(key, { tpc: val.tpc, weight: typeof val.weight === "number" ? val.weight : CAL_SEED_WEIGHT })
      }
    }
  } catch {
    // No calibration file yet — seeds cover us.
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
      mkdirSync(dirname(CAL_PATH), { recursive: true })
      writeFileSync(CAL_PATH, JSON.stringify({ version: 2, models }, null, 2))
      calDirty = false
    } catch {
      // Read-only FS or similar — calibration still works in-memory for this run.
    }
  }

  // ── Per-session state ──
  const windows = new Map<string, WindowEntry[]>()
  // Start of the current uninterrupted delta streak (resets after a stale gap).
  const streakStart = new Map<string, number>()
  const lastDelta = new Map<string, number>()
  // Smoothed live TPS actually displayed.
  const liveEma = new Map<string, number>()
  const steps = new Map<string, StepState>()
  const turnAcc = new Map<string, TurnAcc>()
  const avgMap = new Map<string, AvgDisplay>()
  // Latest provider/model per session, keyed from step.started (authoritative, per LLM call).
  const sessionModel = new Map<string, string>()
  // partID → part type, so step chars can be split into reasoning vs visible buckets.
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
      if (pruned.length === 0) {
        windows.delete(sid)
        liveEma.set(sid, 0)
        continue
      }
      windows.set(sid, pruned)

      let rate = 0
      const last = lastDelta.get(sid) ?? 0
      if (now - last <= STALE_DELTA_MS) {
        // Elapsed time the window actually covers: from either the window's
        // trailing edge or the start of the current streak, whichever is later.
        const start = Math.max(now - WINDOW_MS, streakStart.get(sid) ?? 0)
        const elapsed = Math.max(now - start, MIN_ELAPSED_MS) / 1000
        const chars = pruned.reduce((s, e) => s + e.chars, 0)
        rate = (chars * tpcFor(sid)) / elapsed
      }

      // Smooth ramps and residual bursts; snap to 0 instantly when the stream
      // goes quiet so the meter doesn't show phantom decay.
      if (rate === 0) {
        liveEma.set(sid, 0)
      } else {
        const prev = liveEma.get(sid) ?? 0
        const alpha = Math.min(HEARTBEAT_MS / EMA_TC_MS, 1)
        liveEma.set(sid, prev + alpha * (rate - prev))
      }
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

  // One LLM call begins: reset the per-step accumulator and note the model.
  api.event.on("session.next.step.started", (event) => {
    const p = event.properties
    if (!p?.sessionID) return
    if (p.model) sessionModel.set(p.sessionID, `${p.model.providerID}/${p.model.id}`)
    steps.set(p.sessionID, {
      startedAt: Date.now(),
      firstDeltaAt: 0,
      lastDeltaAt: 0,
      chars: 0,
      parts: new Map(),
    })
  })

  // Every streamed delta feeds the live window and the step accumulator.
  api.event.on("message.part.delta", (event) => {
    const sid = event.properties.sessionID
    const delta = event.properties.delta
    if (!sid || typeof delta !== "string" || delta.length === 0) return
    const now = Date.now()

    const win = windows.get(sid) ?? []
    win.push({ t: now, chars: delta.length })
    windows.set(sid, win)

    const last = lastDelta.get(sid) ?? 0
    if (now - last > STALE_DELTA_MS) streakStart.set(sid, now)
    lastDelta.set(sid, now)

    let step = steps.get(sid)
    if (!step) {
      // step.started event missed (e.g. plugin loaded mid-call) — synthesize.
      step = { startedAt: now, firstDeltaAt: 0, lastDeltaAt: 0, chars: 0, parts: new Map() }
      steps.set(sid, step)
    }
    if (step.firstDeltaAt === 0) step.firstDeltaAt = now
    step.lastDeltaAt = now
    step.chars += delta.length
    const pid = event.properties.partID
    if (pid) step.parts.set(pid, (step.parts.get(pid) ?? 0) + delta.length)

    // A new turn invalidates any previously shown avg.
    if (avgMap.has(sid)) avgMap.delete(sid)
  })

  // Ground truth arrives here: provider-billed tokens for the LLM call that
  // just finished. Update the turn average and feed the calibrator.
  api.event.on("session.next.step.ended", (event) => {
    const p = event.properties
    const sid = p?.sessionID
    if (!sid) return
    const step = steps.get(sid)
    steps.delete(sid)
    if (!step) return

    // Split the step's chars now that part types are reliably known.
    let visibleChars = 0
    let reasoningChars = 0
    for (const [pid, chars] of step.parts) {
      if (partTypes.get(pid) === "reasoning") reasoningChars += chars
      else visibleChars += chars
    }

    const outTokens = p?.tokens?.output ?? 0
    const reasoningTokens = p?.tokens?.reasoning ?? 0
    // OpenAI-style providers bill reasoning separately; Anthropic folds
    // thinking into output. Sum is total generated either way.
    const billed = outTokens + reasoningTokens

    // ── Turn average ──
    // Generation wall time: first streamed delta → step end. This includes
    // silent thinking gaps (which really are generation time) and excludes
    // time-to-first-token and tool execution (which happen outside the step
    // or before streaming begins).
    const genMs = step.firstDeltaAt > 0 ? Date.now() - step.firstDeltaAt : Date.now() - step.startedAt
    const stepTokens = billed > 0 ? billed : Math.round(step.chars * tpcFor(sid))
    if (genMs >= MIN_STEP_GEN_MS && stepTokens >= MIN_STEP_TOKENS) {
      const acc = turnAcc.get(sid) ?? { tokens: 0, genMs: 0, fromProvider: true }
      acc.tokens += stepTokens
      acc.genMs += genMs
      if (billed <= 0) acc.fromProvider = false
      turnAcc.set(sid, acc)
      avgMap.set(sid, { tps: Math.round(acc.tokens / (acc.genMs / 1000)), fromProvider: acc.fromProvider })
    }

    // ── Calibration ──
    const modelKey = sessionModel.get(sid)
    if (!modelKey || outTokens < CAL_MIN_STEP_TOKENS || visibleChars < CAL_MIN_STEP_VISIBLE_CHARS) return
    // If the provider reported no reasoning tokens but reasoning parts
    // streamed, thinking is folded into `output` (Anthropic-style) and the
    // billed count is not explainable by visible chars — skip.
    if (reasoningTokens === 0 && reasoningChars > 0) return

    const observed = outTokens / visibleChars
    if (observed < CAL_TPC_MIN || observed > CAL_TPC_MAX) return
    const w = Math.min(outTokens, CAL_STEP_WEIGHT_CAP)
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

  // Fallback: if step events never fired (older server, missed events), derive
  // an avg from the completed assistant message's billed tokens and wall time.
  api.event.on("message.updated", (event) => {
    const info = event.properties?.info
    if (!info || info.role !== "assistant") return
    if (!info.time?.completed) return
    const sid = info.sessionID
    if (!sid || turnAcc.has(sid)) return
    const providerTokens = (info.tokens?.output ?? 0) + (info.tokens?.reasoning ?? 0)
    if (providerTokens <= 0 || !info.time.created) return
    const seconds = Math.max((info.time.completed - info.time.created) / 1000, 0.25)
    avgMap.set(sid, { tps: Math.round(providerTokens / seconds), fromProvider: true })
  })

  // Reset live/turn state when the turn finishes; keep avg so the user can see it.
  api.event.on("session.idle", (event) => {
    const sid = event.properties?.sessionID
    if (!sid) return
    windows.delete(sid)
    streakStart.delete(sid)
    lastDelta.delete(sid)
    liveEma.set(sid, 0)
    steps.delete(sid)
    turnAcc.delete(sid)
    // Keep the part-type cache from growing without bound across long-lived TUIs.
    if (partTypes.size > 4000) partTypes.clear()
  })

  api.slots.register({
    slots: {
      session_prompt_right(ctx, props) {
        const status = createMemo(() => api.state.session.status(props.session_id))
        const live = createMemo(() => {
          tick()
          return Math.round(liveEma.get(props.session_id) ?? 0)
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
