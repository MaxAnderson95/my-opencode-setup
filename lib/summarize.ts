/**
 * The escalation rung: whole-session summarisation offloaded to a cheap worker
 * model, cached permanently in the sidecar.
 *
 * Mechanism (v2): `session.generate` runs one stateless completion in the
 * context of a session without mutating it. The summarizer keeps one empty,
 * hidden worker session per model tag (created once, id remembered in the
 * sidecar meta table, reused forever) whose only job is to carry the model
 * selection and the tool-less summarizer agent; the transcript and the
 * instructions travel in the prompt. Unlike the v1 flow there is nothing to
 * delete afterwards — generate leaves the worker session empty.
 *
 * Summaries are generated lazily, only for sessions someone actually asks
 * about, and are invalidated only by the source session changing.
 */
import type { Database } from "bun:sqlite"
import type { Config, SummaryModel } from "./config.ts"
import { summaryModelTag } from "./config.ts"
import type { DirectoryExclusions } from "./exclusions.ts"
import { getMeta, setMeta } from "./schema.ts"
import type { Source, SessionRow } from "./source.ts"
import { fmtDate, middleOut, shortDir } from "./text.ts"

export type SummaryResult = { summary: string; cachedAt?: number; secs?: number; messages?: number }

export const WORKER_PREFIX = "recall-summarizer worker: "

/** Static system prompt for the hidden worker agent; the per-call instructions ride in the prompt. */
export const WORKER_SYSTEM =
  "You analyze recorded OpenCode agent session transcripts. Follow the task instructions in the user message exactly, and answer ONLY from the transcript provided. No preamble."

const TASK_FOCUSED =
  "Answer the question below using only the transcript. Be specific: name files, commands, ids, and decisions. If the transcript does not contain the answer, say so plainly."

const TASK_GENERAL =
  "Produce a tight summary of the transcript structured as: Goal; What was done (bullets); Key decisions & why; Gotchas/discoveries; Final state; Loose ends. Be specific — name files, commands, and ids. At most 350 words."

/**
 * The slice of the v2 plugin session API the summarizer needs. Structural so
 * tests can stub it; `ctx.session` satisfies it directly.
 */
export type SessionClient = {
  create(input: {
    title?: string | null
    agent?: string | null
    model?: { id: string; providerID: string; variant?: string } | null
  }): Promise<{ id: string }>
  get(input: { sessionID: string }): Promise<unknown>
  generate(input: { sessionID: string; prompt: string }): Promise<{ text: string }>
}

export type SummarizerDeps = {
  idx: Database
  source: Source
  config: Config
  exclusions: DirectoryExclusions
  sessions: SessionClient | null
  home: string
  log: (...args: unknown[]) => void
}

export class Summarizer {
  private inFlight = new Map<string, Promise<SummaryResult>>()
  private workers = new Map<string, Promise<string>>()
  readonly modelTag: string

  constructor(private d: SummarizerDeps) {
    this.modelTag = summaryModelTag(d.config)
  }

  get available(): boolean {
    return this.d.config.summary.enabled && this.d.sessions !== null
  }

  cachedCount(): number {
    return (this.d.idx.query(`SELECT count(*) c FROM summaries`).get() as { c: number }).c
  }

  /**
   * The empty worker session that carries a model selection. One per model
   * tag, created lazily, remembered across restarts in the sidecar meta table
   * and re-verified against the server before reuse (it may have been deleted).
   */
  private workerSession(sessions: SessionClient, model: SummaryModel, modelTag: string): Promise<string> {
    const pending = this.workers.get(modelTag)
    if (pending) return pending
    const acquire = (async () => {
      const metaKey = `summary_worker:${modelTag}`
      const stored = getMeta(this.d.idx, metaKey)
      if (stored) {
        try {
          await sessions.get({ sessionID: stored })
          return stored
        } catch {
          this.d.log("summarizer worker session gone, recreating", stored)
        }
      }
      const created = await sessions.create({
        title: `${WORKER_PREFIX}${modelTag}`,
        agent: this.d.config.summary.agent,
        model: { id: model.modelID, providerID: model.providerID, ...(model.variant ? { variant: model.variant } : {}) },
      })
      setMeta(this.d.idx, metaKey, created.id)
      this.d.log("summarizer worker session created", modelTag, created.id)
      return created.id
    })()
    this.workers.set(modelTag, acquire)
    acquire.catch(() => {
      if (this.workers.get(modelTag) === acquire) this.workers.delete(modelTag)
    })
    return acquire
  }

  /** Compact whole-session transcript, middle-out truncated to the char budget. */
  private transcript(sessionId: string): { text: string; messages: number } {
    const messages = this.d.source.messages(sessionId)
    const blocks: string[] = []
    for (const m of messages) {
      const b = this.d.source.renderMessage(m, this.d.config.summary.msgChars)
      if (b) blocks.push(b)
    }
    return {
      text: middleOut(
        blocks,
        this.d.config.summary.charBudget,
        (omitted, total) => `[... ${omitted} of ${total} messages omitted ...]`,
      ),
      messages: messages.length,
    }
  }

  summarize(
    s: SessionRow,
    focus: string,
    refresh: boolean,
    abort?: AbortSignal,
    model: SummaryModel = this.d.config.summary.model,
  ): Promise<SummaryResult> {
    if (this.d.exclusions.matches(s.directory)) return Promise.reject(new Error("session is excluded from recall"))
    const modelTag = summaryModelTag({ summary: { model } })
    const key = `${s.id}\u0000${modelTag}\u0000${focus}`
    if (!refresh) {
      const cached = this.d.idx
        .query(`SELECT time_updated, summary, created FROM summaries WHERE session_id=? AND model=? AND focus=?`)
        .get(s.id, modelTag, focus) as
        | { time_updated: number; summary: string; created: number }
        | null
      if (cached && cached.time_updated === s.time_updated)
        return Promise.resolve({ summary: cached.summary, cachedAt: cached.created })
      const inflight = this.inFlight.get(key)
      if (inflight) return inflight
    }
    const p = this.run(s, focus, modelTag, model, abort)
    this.inFlight.set(key, p)
    p.catch(() => {}).finally(() => {
      if (this.inFlight.get(key) === p) this.inFlight.delete(key)
    })
    return p
  }

  private async run(
    s: SessionRow,
    focus: string,
    modelTag: string,
    model: SummaryModel,
    abort?: AbortSignal,
  ): Promise<SummaryResult> {
    const sessions = this.d.sessions
    if (!sessions) throw new Error("no opencode session client in this context")
    const cfg = this.d.config.summary
    const { text: transcript, messages } = this.transcript(s.id)
    if (!transcript) throw new Error("session has no transcript content")
    const prompt = [
      focus ? TASK_FOCUSED : TASK_GENERAL,
      "",
      ...(focus ? [`QUESTION: ${focus}`, ""] : []),
      `SESSION: ${s.title} (${shortDir(s.directory, this.d.home)}, ${fmtDate(s.time_created)})`,
      "TRANSCRIPT:",
      transcript,
    ].join("\n")

    if (abort?.aborted) throw new Error("aborted")
    const t0 = performance.now()
    const worker = await this.workerSession(sessions, model, modelTag)
    const racers: Promise<{ text: string }>[] = [
      sessions.generate({ sessionID: worker, prompt }),
      Bun.sleep(cfg.timeoutMs).then(() => {
        throw new Error(`summarizer timed out after ${cfg.timeoutMs / 1000}s`)
      }),
    ]
    if (abort)
      racers.push(
        new Promise<never>((_, reject) =>
          abort.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
        ),
      )
    const res = await Promise.race(racers)
    const summary = res.text.trim()
    if (!summary) throw new Error("summarizer returned no text")
    if (this.d.exclusions.matches(s.directory)) throw new Error("session was excluded while summarization was running")
    this.d.idx.run(
      `INSERT INTO summaries(session_id,model,focus,time_updated,summary,created) VALUES (?,?,?,?,?,?)
       ON CONFLICT(session_id,model,focus) DO UPDATE SET time_updated=excluded.time_updated,
         summary=excluded.summary, created=excluded.created`,
      [s.id, modelTag, focus, s.time_updated, summary, Date.now()],
    )
    return { summary, secs: (performance.now() - t0) / 1000, messages }
  }
}

/** Bounded-concurrency map. JS is single-threaded, so the shared cursor is safe. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i])
      }
    }),
  )
  return out
}
