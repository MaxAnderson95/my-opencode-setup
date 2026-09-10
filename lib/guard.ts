import { randomUUID } from "node:crypto"

export const RESUME = "resume"
export const ALLOW = "allow"
export const STOP = "stop"

/** A guarded subscription credential, keyed by the provider that owns it. */
export interface Account {
  provider: string
  id: string
}

/**
 * What one provider response says about billing. `using` is true when the
 * response was billed beyond the subscription, false when the provider
 * confirmed subscription usage, and undefined when the response carries no
 * usable signal. `reset` is the epoch-millisecond time the allowance renews.
 */
export interface Reading {
  using?: boolean
  reset?: number
}

export interface SavedGate {
  root: string
  provider: string
  account: string
  reset?: number
  allowedUntil?: number
  form?: string
}

export interface GuardHost {
  load(): Promise<SavedGate[]>
  save(gates: SavedGate[]): Promise<void>
  session(id: string): Promise<{ id: string; parentID?: string }>
  children(id: string): Promise<string[]>
  interrupt(id: string): Promise<void>
  form(root: string, id: string, provider: string, reset?: number): Promise<void>
  state(
    root: string,
    id: string,
  ): Promise<
    | { status: "pending" }
    | { status: "answered"; answer: Record<string, unknown> }
    | { status: "cancelled" }
    | undefined
  >
  cancel(root: string, id: string): Promise<void>
  error(error: unknown): void
}

interface Gate extends SavedGate {
  phase: "open" | "blocked" | "checking" | "allowed"
  epoch: number
  waiters: Set<{ session: string; wake(): void; reject(error: Error): void }>
  creating?: Promise<void>
  probe?: Ticket
  timer?: ReturnType<typeof setTimeout>
  stopping?: Promise<void>
}

export interface Ticket {
  root: string
  epoch: number
  session: string
  account?: Account
}

const stopped = (gate: Gate) => new Error(`Session stopped at the ${gate.provider} overage limit`)

/**
 * One gate per session family, shared by every location in the server process.
 * Whichever guarded provider first reports overage owns the family's question;
 * every request in the family, on any provider, waits while the gate is closed.
 */
export class OverageGuard {
  private gates = new Map<string, Gate>()
  private roots = new Map<string, Promise<string>>()
  private ready: Promise<void>
  private writes = Promise.resolve()
  private closed = false
  private host: GuardHost
  private now: () => number
  private probeTimeout: number

  constructor(host: GuardHost, now = Date.now, probeTimeout = 60_000) {
    this.host = host
    this.now = now
    this.probeTimeout = probeTimeout
    this.ready = host.load().then((saved) => {
      for (const item of saved) {
        this.gates.set(item.root, {
          ...item,
          phase: item.allowedUntil && item.allowedUntil > this.now() ? "allowed" : "blocked",
          epoch: 0,
          waiters: new Set(),
        })
      }
    })
    void this.ready.catch((error) => this.host.error(error))
  }

  private root(session: string): Promise<string> {
    let pending = this.roots.get(session)
    if (!pending) {
      pending = this.host.session(session).then((info) => (info.parentID ? this.root(info.parentID) : info.id))
      this.roots.set(session, pending)
      void pending.catch(() => this.roots.delete(session))
    }
    return pending
  }

  private persist(): Promise<void> {
    const saved = [...this.gates.values()]
      .filter((gate) => gate.phase !== "open")
      .map(({ root, provider, account, reset, allowedUntil, form }) => ({
        root,
        provider,
        account,
        reset,
        allowedUntil,
        form,
      }))
    // A failed write must not prevent a later stop from being persisted.
    this.writes = this.writes.catch(() => {}).then(() => this.host.save(saved))
    return this.writes
  }

  private wake(gate: Gate) {
    for (const waiter of gate.waiters) waiter.wake()
    gate.waiters.clear()
  }

  private async question(gate: Gate): Promise<void> {
    if (gate.creating) return gate.creating
    gate.creating = (async () => {
      if (gate.form) {
        const id = gate.form
        const state = await this.host.state(gate.root, id)
        if (state) {
          if (state.status !== "pending") await this.answer(id, state)
          return
        }
      }
      if (gate.phase !== "blocked" || this.closed) return
      const id = `frm_${randomUUID().replaceAll("-", "")}`
      gate.form = id
      await this.persist()
      await this.host.form(gate.root, id, gate.provider, gate.reset)
      // Reconcile an answer delivered between create and event subscription.
      const state = await this.host.state(gate.root, id)
      if (state && state.status !== "pending") await this.answer(id, state)
    })().finally(() => {
      gate.creating = undefined
    })
    return gate.creating
  }

  /**
   * Waits until the session's family may send a request. Pass the account only
   * for requests whose response will be handed back through `observe`.
   */
  async before(session: string, account?: Account, signal?: AbortSignal): Promise<Ticket> {
    await this.ready
    const root = await this.root(session)
    let gate = this.gates.get(root)
    if (!gate) {
      gate = {
        root,
        provider: account?.provider ?? "",
        account: account?.id ?? "",
        phase: "open",
        epoch: 0,
        waiters: new Set(),
      }
      this.gates.set(root, gate)
    }
    // Switching credentials on the provider that owns the gate discards its
    // state: a decision about one account never carries to another.
    if (account && gate.account && account.provider === gate.provider && account.id !== gate.account) {
      gate.account = account.id
      gate.epoch++
      gate.phase = "open"
      gate.allowedUntil = undefined
      clearTimeout(gate.timer)
      const form = gate.form
      gate.form = undefined
      await this.persist()
      if (form) await this.host.cancel(root, form)
      this.wake(gate)
    }
    for (;;) {
      if (this.closed || signal?.aborted) throw new Error("Overage wait interrupted")
      if (gate.stopping) {
        await gate.stopping
        throw stopped(gate)
      }
      if (gate.phase === "allowed" && (gate.allowedUntil ?? 0) <= this.now()) {
        gate.phase = "blocked"
        gate.allowedUntil = undefined
        gate.epoch++
        await this.persist()
      }
      const ticket: Ticket = { root, epoch: gate.epoch, session, account }
      if (gate.phase === "open" || gate.phase === "allowed") return ticket
      if (gate.phase === "checking" && account && !gate.probe) {
        gate.probe = ticket
        return ticket
      }
      if (gate.phase === "blocked") {
        await this.question(gate)
        if (gate.phase !== "blocked") continue
        if (!gate.form) throw stopped(gate)
      }
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          gate.waiters.delete(waiter)
          signal?.removeEventListener("abort", abort)
        }
        const waiter = {
          session,
          wake: () => {
            finish()
            resolve()
          },
          reject: (error: Error) => {
            finish()
            reject(error)
          },
        }
        const abort = () => waiter.reject(new Error("Overage wait interrupted"))
        gate.waiters.add(waiter)
        signal?.addEventListener("abort", abort, { once: true })
        if (signal?.aborted) abort()
      })
    }
  }

  async observe(ticket: Ticket, reading: Reading): Promise<void> {
    await this.ready
    const gate = this.gates.get(ticket.root)
    if (!gate || gate.epoch !== ticket.epoch || !ticket.account || this.closed) return
    const using = reading.using === true
    if (gate.phase === "checking") {
      if (gate.probe !== ticket) return
      clearTimeout(gate.timer)
      gate.probe = undefined
      if (reading.using === false) {
        gate.phase = "open"
        gate.epoch++
        await this.persist()
        this.wake(gate)
        return
      }
    } else if (!using || (gate.phase === "allowed" && (gate.allowedUntil ?? 0) > this.now())) {
      return
    }
    if (reading.reset !== undefined && Number.isFinite(reading.reset) && reading.reset > 0)
      gate.reset = reading.reset
    gate.provider = ticket.account.provider
    gate.account = ticket.account.id
    await this.block(gate)
  }

  private async block(gate: Gate) {
    gate.phase = "blocked"
    gate.epoch++
    gate.probe = undefined
    gate.allowedUntil = undefined
    await this.persist()
    try {
      await this.question(gate)
    } catch (error) {
      // An invisible question must not leave a running family spending freely.
      await this.stop(gate)
      throw error
    }
  }

  private async answer(
    id: string,
    state: { status: "cancelled" } | { status: "answered"; answer: Record<string, unknown> },
  ) {
    const gate = [...this.gates.values()].find((item) => item.form === id)
    if (!gate) return
    gate.form = undefined
    const choice = state.status === "answered" ? state.answer.decision : STOP
    if (choice === RESUME) {
      gate.phase = "checking"
      gate.epoch++
      gate.probe = undefined
      gate.timer = setTimeout(() => {
        void this.block(gate).catch((error) => this.host.error(error))
      }, this.probeTimeout)
      gate.timer.unref?.()
      await this.persist()
      this.wake(gate)
    } else if (choice === ALLOW) {
      gate.phase = "allowed"
      gate.epoch++
      // Missing/past reset times never grant an unbounded spending exception.
      gate.allowedUntil = gate.reset && gate.reset > this.now() ? gate.reset : this.now() + 5 * 60_000
      await this.persist()
      this.wake(gate)
    } else {
      await this.stop(gate)
    }
  }

  private async stop(gate: Gate): Promise<void> {
    if (gate.stopping) return gate.stopping
    gate.phase = "blocked"
    gate.epoch++
    gate.allowedUntil = undefined
    gate.probe = undefined
    clearTimeout(gate.timer)
    const form = gate.form
    gate.form = undefined
    gate.stopping = (async () => {
      const visit = async (id: string): Promise<void> => {
        await this.host.interrupt(id)
        const children = await this.host.children(id)
        await Promise.all(children.map(visit))
      }
      // Keep waiters blocked until interruption has been accepted by the host.
      try {
        try {
          await this.persist()
        } finally {
          await visit(gate.root)
        }
      } finally {
        for (const waiter of gate.waiters) waiter.reject(stopped(gate))
        gate.waiters.clear()
        if (form) await this.host.cancel(gate.root, form)
      }
    })()
    try {
      await gate.stopping
    } finally {
      gate.stopping = undefined
    }
  }

  async event(event: { type: string; data: unknown }): Promise<void> {
    await this.ready
    if (this.closed) return
    if (event.type === "server.connected") {
      for (const gate of this.gates.values()) {
        if (gate.phase === "blocked" && gate.form) await this.question(gate)
      }
      return
    }
    const data = event.data as {
      id?: string
      sessionID?: string
      reason?: string
      answer?: Record<string, unknown>
    }
    if (event.type === "form.replied" && data.id && data.answer) {
      await this.answer(data.id, { status: "answered", answer: data.answer })
    } else if (event.type === "form.cancelled" && data.id) {
      await this.answer(data.id, { status: "cancelled" })
    } else if (event.type === "session.execution.interrupted" && data.sessionID) {
      const gate = this.gates.get(await this.root(data.sessionID))
      if (!gate) return
      if (
        data.sessionID === gate.root &&
        data.reason !== "shutdown" &&
        gate.phase !== "open" &&
        !gate.stopping &&
        (gate.form || gate.phase === "allowed" || gate.phase === "checking" || gate.waiters.size > 0)
      ) {
        await this.stop(gate)
      } else {
        for (const waiter of gate.waiters) {
          if (waiter.session === data.sessionID) waiter.reject(new Error("Overage wait interrupted"))
        }
      }
    }
  }

  async close() {
    this.closed = true
    await this.ready
    for (const gate of this.gates.values()) {
      clearTimeout(gate.timer)
      for (const waiter of gate.waiters) waiter.reject(new Error("Overage guard unloaded"))
      gate.waiters.clear()
    }
    await this.writes
  }
}
