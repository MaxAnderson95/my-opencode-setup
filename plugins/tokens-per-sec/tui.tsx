/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode-ai/plugin/tui"
import { Show, createMemo, createSignal } from "solid-js"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

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
// `session.step.ended` carries provider-billed token counts for that LLM
// call. The key insight (verified against 60 days of local history) is that
// billed counts must be matched to the RIGHT chars:
//
//   * OpenAI-style providers report reasoning tokens SEPARATELY from output,
//     and `tokens.output` covers exactly the visible text + tool-arg stream.
//     → calibrate output tokens against non-reasoning chars.
//   * Anthropic folds thinking into `tokens.output` (reasoning is always 0)
//     while streaming only a thinking summary. Those steps' billed counts are
//     NOT explainable by streamed chars → skip any step that streamed
//     reasoning deltas when the provider reported reasoning = 0.
//
// Unlike v1's part-type map (which raced against delta delivery), the v2
// event stream types every delta at the source — session.reasoning.delta vs
// session.text.delta / session.tool.input.delta — so chars are bucketed
// correctly the moment they arrive.
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

// Where the v1 plugin persisted learned ratios. Read once to migrate into the
// v2 storage API, never written again.
const LEGACY_CAL_PATH = join(
  process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
  "opencode",
  "tokens-per-sec-calibration.json",
)

type WindowEntry = { t: number; chars: number }
// Per-step accumulator, reset at every session.step.ended (one LLM call).
type StepState = {
  startedAt: number
  firstDeltaAt: number
  visibleChars: number
  reasoningChars: number
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
type CalibrationState = {
  models: Record<string, Ratio & { updated: string }>
}

export default Plugin.define({
  id: "tokens-per-sec",
  setup(context) {
    if (context.options.enabled === false) return

    const fallbackTpc =
      1 /
      (typeof context.options.charsPerToken === "number" && context.options.charsPerToken > 0
        ? context.options.charsPerToken
        : DEFAULT_CHARS_PER_TOKEN)

    // ── Calibration store ──
    // Durable v2 plugin storage: persisted to disk, survives restarts, and
    // live-syncs across TUI instances, replacing v1's hand-rolled JSON file
    // and 15s dirty-save loop.
    const [calibration, mutateCalibration] = context.storage.store<CalibrationState>("calibration", {
      initial: { models: {} },
    })

    // One-time migration of ratios learned by the v1 plugin.
    if (Object.keys(calibration.models).length === 0) {
      try {
        const saved: unknown = JSON.parse(readFileSync(LEGACY_CAL_PATH, "utf8"))
        const models = (saved as { models?: Record<string, { tpc?: unknown; weight?: unknown }> })?.models ?? {}
        const imported: Record<string, Ratio & { updated: string }> = {}
        for (const [key, val] of Object.entries(models)) {
          if (typeof val?.tpc === "number" && val.tpc > 0) {
            imported[key] = {
              tpc: val.tpc,
              weight: typeof val.weight === "number" ? val.weight : CAL_SEED_WEIGHT,
              updated: new Date().toISOString(),
            }
          }
        }
        if (Object.keys(imported).length > 0) {
          void mutateCalibration((draft) => {
            for (const [key, ratio] of Object.entries(imported)) draft.models[key] = ratio
          })
        }
      } catch {
        // No v1 calibration file — seeds cover us.
      }
    }

    const ratioFor = (key: string): Ratio | undefined => {
      const stored = calibration.models[key]
      if (stored) return stored
      const seed = SEED_TPC[key]
      return seed === undefined ? undefined : { tpc: seed, weight: CAL_SEED_WEIGHT }
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
    // Bumped once per heartbeat so slot memos re-evaluate.
    const [tick, setTick] = createSignal(0)

    const tpcFor = (sid: string): number => {
      const key = sessionModel.get(sid)
      if (key) {
        const r = ratioFor(key)
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
      recomputeLive(Date.now())
      setTick((t) => t + 1)
    }, HEARTBEAT_MS)

    const disposers: Array<() => void> = [() => clearInterval(heartbeat)]

    // One LLM call begins: reset the per-step accumulator and note the model.
    disposers.push(
      context.data.on("session.step.started", (event) => {
        const sid = event.data.sessionID
        sessionModel.set(sid, `${event.data.model.providerID}/${event.data.model.id}`)
        steps.set(sid, {
          startedAt: Date.now(),
          firstDeltaAt: 0,
          visibleChars: 0,
          reasoningChars: 0,
        })
      }),
    )

    // Every streamed delta feeds the live window and the step accumulator.
    // The event type is the reasoning-vs-visible classification.
    const onDelta = (sid: string, delta: string, kind: "visible" | "reasoning") => {
      if (delta.length === 0) return
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
        step = { startedAt: now, firstDeltaAt: 0, visibleChars: 0, reasoningChars: 0 }
        steps.set(sid, step)
      }
      if (step.firstDeltaAt === 0) step.firstDeltaAt = now
      if (kind === "reasoning") step.reasoningChars += delta.length
      else step.visibleChars += delta.length

      // A new turn invalidates any previously shown avg.
      if (avgMap.has(sid)) avgMap.delete(sid)
    }

    disposers.push(
      context.data.on("session.text.delta", (event) => {
        onDelta(event.data.sessionID, event.data.delta, "visible")
      }),
      context.data.on("session.tool.input.delta", (event) => {
        onDelta(event.data.sessionID, event.data.delta, "visible")
      }),
      context.data.on("session.reasoning.delta", (event) => {
        onDelta(event.data.sessionID, event.data.delta, "reasoning")
      }),
    )

    // Ground truth arrives here: provider-billed tokens for the LLM call that
    // just finished. Update the turn average and feed the calibrator.
    disposers.push(
      context.data.on("session.step.ended", (event) => {
        const sid = event.data.sessionID
        const step = steps.get(sid)
        steps.delete(sid)
        if (!step) return

        const outTokens = event.data.tokens.output
        const reasoningTokens = event.data.tokens.reasoning
        // OpenAI-style providers bill reasoning separately; Anthropic folds
        // thinking into output. Sum is total generated either way.
        const billed = outTokens + reasoningTokens

        // ── Turn average ──
        // Generation wall time: first streamed delta → step end. This includes
        // silent thinking gaps (which really are generation time) and excludes
        // time-to-first-token and tool execution (which happen outside the step
        // or before streaming begins).
        const genMs = step.firstDeltaAt > 0 ? Date.now() - step.firstDeltaAt : Date.now() - step.startedAt
        const streamedChars = step.visibleChars + step.reasoningChars
        const stepTokens = billed > 0 ? billed : Math.round(streamedChars * tpcFor(sid))
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
        if (!modelKey || outTokens < CAL_MIN_STEP_TOKENS || step.visibleChars < CAL_MIN_STEP_VISIBLE_CHARS) return
        // If the provider reported no reasoning tokens but reasoning deltas
        // streamed, thinking is folded into `output` (Anthropic-style) and the
        // billed count is not explainable by visible chars — skip.
        if (reasoningTokens === 0 && step.reasoningChars > 0) return

        const observed = outTokens / step.visibleChars
        if (observed < CAL_TPC_MIN || observed > CAL_TPC_MAX) return
        const w = Math.min(outTokens, CAL_STEP_WEIGHT_CAP)
        const prev = ratioFor(modelKey)
        const next: Ratio = prev
          ? {
              tpc: (prev.tpc * Math.min(prev.weight, CAL_WEIGHT_CAP) + observed * w) / (Math.min(prev.weight, CAL_WEIGHT_CAP) + w),
              weight: Math.min(Math.min(prev.weight, CAL_WEIGHT_CAP) + w, CAL_WEIGHT_CAP),
            }
          : { tpc: observed, weight: w }
        void mutateCalibration((draft) => {
          draft.models[modelKey] = {
            tpc: Number(next.tpc.toFixed(6)),
            weight: Math.round(next.weight),
            updated: new Date().toISOString(),
          }
        })
      }),
    )

    // Reset live/turn state when the turn finishes; keep avg so the user can see it.
    disposers.push(
      context.data.on("session.idle", (event) => {
        const sid = event.data.sessionID
        windows.delete(sid)
        streakStart.delete(sid)
        lastDelta.delete(sid)
        liveEma.set(sid, 0)
        steps.delete(sid)
        turnAcc.delete(sid)
      }),
    )

    function Meter(props: { sessionID?: string; mode: "normal" | "shell" }) {
      const live = createMemo(() => {
        tick()
        return props.sessionID ? Math.round(liveEma.get(props.sessionID) ?? 0) : 0
      })
      const avg = createMemo(() => {
        tick()
        return props.sessionID ? avgMap.get(props.sessionID) : undefined
      })
      const label = createMemo(() => {
        const sid = props.sessionID
        const busy = sid !== undefined && context.data.session.status(sid) === "running"
        if (busy) return `${live()} tok/s`
        const a = avg()
        // "~" marks a char-heuristic estimate; unmarked values are provider-billed.
        if (a) return `${a.fromProvider ? "" : "~"}${a.tps} tok/s avg`
        return `0 tok/s`
      })
      return (
        <Show when={props.mode === "normal" && props.sessionID}>
          <text fg={context.theme.text.subdued} flexShrink={0}>
            {label()}
          </text>
        </Show>
      )
    }

    // Far right of the prompt footer row — the v2 position closest to v1's
    // session_prompt_right slot.
    disposers.push(
      context.ui.slot({
        append: "prompt.footer",
        render: (input) => <Meter sessionID={input.sessionID} mode={input.mode} />,
      }),
    )

    return () => {
      for (const dispose of disposers) dispose()
    }
  },
})
