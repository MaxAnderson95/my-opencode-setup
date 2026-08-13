/**
 * Notifications for recall's background work.
 *
 * recall indexes silently, which is right for the steady state (a handful of
 * stale sessions at startup, a single session after each idle) but wrong for
 * the rare long operation: a schema reset followed by a full rebuild can run
 * for twenty minutes with no sign that anything is happening.
 *
 * The gate below is the whole design: stay silent for routine work, speak up
 * only for runs big enough that a user would otherwise wonder.
 *
 * The v2 plugin API has no server-side toast surface (toasts belong to TUI
 * plugins), so announcements currently land in recall.log via `logNotifier`.
 * The announcer/policy split is kept so a visible channel can be swapped in
 * without touching the policy.
 */

export type ToastVariant = "info" | "success" | "warning" | "error"

export type Toast = {
  title?: string
  message: string
  variant?: ToastVariant
  duration?: number
}

export type Notify = (t: Toast) => void

export const noopNotify: Notify = () => {}

/** Routes announcements into recall's own log file. Never throws. */
export function logNotifier(log: (...args: unknown[]) => void): Notify {
  return (t) => {
    try {
      log(`[notify:${t.variant ?? "info"}] ${t.message}`)
    } catch {}
  }
}

export type BackfillNotifyConfig = {
  enabled: boolean
  /** Runs smaller than this are entirely silent, start and finish. */
  announceMin: number
  /** Runs at least this large also report progress at 25/50/75%. */
  progressMin: number
}

function human(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return s % 60 ? `${m}m${s % 60}s` : `${m}m`
}

/**
 * Decides what a backfill run should announce.
 *
 * Kept as a separate object with no I/O so the policy can be tested directly:
 * getting this wrong in either direction (silent 20-minute rebuild, or a toast
 * every time a session goes idle) is the failure mode that matters.
 */
export class BackfillAnnouncer {
  private announced = false
  private nextMilestone = 0
  private startedAt = 0
  private total = 0

  constructor(
    private notify: Notify,
    private cfg: BackfillNotifyConfig,
    private now: () => number = Date.now,
  ) {}

  start(total: number, opts: { afterReset?: boolean } = {}): void {
    this.total = total
    this.startedAt = this.now()
    this.announced = this.cfg.enabled && total >= this.cfg.announceMin
    this.nextMilestone = this.cfg.enabled && total >= this.cfg.progressMin ? 25 : Infinity
    if (!this.announced) return
    this.notify({
      message: opts.afterReset
        ? `Rebuilding the conversation index — ${total.toLocaleString()} sessions. Search will be incomplete until it finishes.`
        : `Indexing ${total.toLocaleString()} conversations in the background.`,
      variant: "info",
    })
  }

  progress(done: number): void {
    if (!this.announced || this.total <= 0) return
    const pct = (100 * done) / this.total
    if (pct < this.nextMilestone) return
    while (this.nextMilestone <= pct) this.nextMilestone += 25
    if (this.nextMilestone > 100) this.nextMilestone = Infinity
    const elapsed = this.now() - this.startedAt
    const remaining = done > 0 ? (elapsed / done) * (this.total - done) : 0
    this.notify({
      message: `Indexing conversations: ${Math.round(pct)}% (${done.toLocaleString()}/${this.total.toLocaleString()}) · ~${human(remaining)} left`,
      variant: "info",
    })
  }

  finish(done: number, chunks: number, lastError: string): void {
    if (!this.announced) return
    const elapsed = human(this.now() - this.startedAt)
    if (lastError) {
      this.notify({
        message: `Indexed ${done.toLocaleString()} conversations in ${elapsed}, with errors. See recall_status.`,
        variant: "warning",
      })
      return
    }
    this.notify({
      message: `Indexed ${done.toLocaleString()} conversations in ${elapsed} · ${chunks.toLocaleString()} chunks. Recall is up to date.`,
      variant: "success",
    })
  }
}
