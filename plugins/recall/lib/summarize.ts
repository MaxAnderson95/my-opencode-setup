/**
 * The escalation rung: whole-session summarisation offloaded to a cheap worker
 * model in an ephemeral, tool-less session, cached permanently in the sidecar.
 *
 * Summaries are generated lazily, only for sessions someone actually asks
 * about, and are invalidated only by the source session changing.
 */
import type { Database } from "bun:sqlite"
import type { Config } from "./config.ts"
import { summaryModelTag } from "./config.ts"
import type { Source, SessionRow } from "./source.ts"
import { clean, fmtDate, middleOut, shortDir } from "./text.ts"

export type SummaryResult = { summary: string; cachedAt?: number; secs?: number; messages?: number }

export const WORKER_PREFIX = "recall-summarizer worker: "

const SYSTEM_FOCUSED =
  "You answer questions about a recorded OpenCode agent session transcript. Answer ONLY from the transcript. Be specific: name files, commands, ids, and decisions. If the transcript does not contain the answer, say so plainly. No preamble."

const SYSTEM_GENERAL =
  "You summarize recorded OpenCode agent session transcripts. Produce a tight summary structured as: Goal; What was done (bullets); Key decisions & why; Gotchas/discoveries; Final state; Loose ends. Be specific — name files, commands, and ids. At most 350 words. No preamble."

export type SummarizerDeps = {
  idx: Database
  source: Source
  config: Config
  client: any
  home: string
  log: (...args: unknown[]) => void
}

export class Summarizer {
  private inFlight = new Map<string, Promise<SummaryResult>>()
  readonly modelTag: string

  constructor(private d: SummarizerDeps) {
    this.modelTag = summaryModelTag(d.config)
  }

  get available(): boolean {
    return this.d.config.summary.enabled && !!this.d.client?.session
  }

  cachedCount(): number {
    return (this.d.idx.query(`SELECT count(*) c FROM summaries`).get() as { c: number }).c
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

  summarize(s: SessionRow, focus: string, refresh: boolean, abort?: AbortSignal): Promise<SummaryResult> {
    const key = `${s.id}\u0000${focus}`
    if (!refresh) {
      const cached = this.d.idx
        .query(`SELECT time_updated, summary, created FROM summaries WHERE session_id=? AND model=? AND focus=?`)
        .get(s.id, this.modelTag, focus) as
        | { time_updated: number; summary: string; created: number }
        | null
      if (cached && cached.time_updated === s.time_updated)
        return Promise.resolve({ summary: cached.summary, cachedAt: cached.created })
      const inflight = this.inFlight.get(key)
      if (inflight) return inflight
    }
    const p = this.run(s, focus, abort)
    this.inFlight.set(key, p)
    p.catch(() => {}).finally(() => {
      if (this.inFlight.get(key) === p) this.inFlight.delete(key)
    })
    return p
  }

  private async run(s: SessionRow, focus: string, abort?: AbortSignal): Promise<SummaryResult> {
    const cfg = this.d.config.summary
    const { text: transcript, messages } = this.transcript(s.id)
    if (!transcript) throw new Error("session has no transcript content")
    const system = focus ? SYSTEM_FOCUSED : SYSTEM_GENERAL
    const task = `${focus ? `QUESTION: ${focus}` : "Summarize this session."}\n\nSESSION: ${s.title} (${shortDir(s.directory, this.d.home)}, ${fmtDate(s.time_created)})\nTRANSCRIPT:\n${transcript}`

    if (abort?.aborted) throw new Error("aborted")
    const t0 = performance.now()
    const created = await this.d.client.session.create({ body: { title: `${WORKER_PREFIX}${s.id}` } })
    const worker: string | undefined = created?.data?.id
    if (!worker)
      throw new Error(
        `failed to create worker session: ${clean(JSON.stringify(created?.error ?? created ?? null), 300)}`,
      )
    try {
      const racers: Promise<any>[] = [
        this.d.client.session.prompt({
          path: { id: worker },
          body: { agent: cfg.agent, system, tools: { "*": false }, parts: [{ type: "text", text: task }] },
        }),
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
      const res: any = await Promise.race(racers)
      if (res?.error) throw new Error(clean(JSON.stringify(res.error), 300))
      const parts: any[] = res?.data?.parts ?? []
      const summary = parts
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text)
        .join("\n")
        .trim()
      if (!summary) {
        const err = res?.data?.info?.error
        throw new Error(err ? clean(JSON.stringify(err), 300) : "summarizer returned no text")
      }
      this.d.idx.run(
        `INSERT INTO summaries(session_id,model,focus,time_updated,summary,created) VALUES (?,?,?,?,?,?)
         ON CONFLICT(session_id,model,focus) DO UPDATE SET time_updated=excluded.time_updated,
           summary=excluded.summary, created=excluded.created`,
        [s.id, this.modelTag, focus, s.time_updated, summary, Date.now()],
      )
      return { summary, secs: (performance.now() - t0) / 1000, messages }
    } finally {
      void this.d.client.session
        .delete({ path: { id: worker } })
        .catch((e: unknown) => this.d.log("summarizer worker delete failed", worker, e))
    }
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
