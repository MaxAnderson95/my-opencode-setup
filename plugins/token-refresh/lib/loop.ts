// One timer chain per server process. A process loads the plugin once per
// project instance, but the credentials being refreshed are global to the
// process's database, so extra loops only add resolve calls and log noise.
// The loop borrows whichever attached context is alive when a tick fires and
// stops when the last one detaches.

export type Timer = {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

export type Options<C> = {
  tick: (ctx: C) => Promise<void>
  tickMs: number
  jitterMs: number
  random: () => number
  timer: Timer
  log: (line: string) => void
}

export function createLoop<C>(options: Options<C>) {
  const contexts = new Set<C>()
  let handle: unknown

  const schedule = (delay: number) => {
    handle = options.timer.set(async () => {
      handle = undefined
      const ctx = contexts.values().next().value
      if (ctx === undefined) return
      try {
        await options.tick(ctx)
      } catch (err) {
        options.log(`tick failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      // A context attaching mid-tick after the last one left has already
      // started a new chain; don't start a second.
      if (contexts.size > 0 && handle === undefined) schedule(options.tickMs + options.random() * options.jitterMs)
    }, delay)
  }

  return {
    attach(ctx: C): () => void {
      contexts.add(ctx)
      // A random first delay keeps processes launched together out of phase.
      if (handle === undefined) schedule(options.random() * options.tickMs)
      return () => {
        contexts.delete(ctx)
        if (contexts.size === 0) {
          options.timer.clear(handle)
          handle = undefined
        }
      }
    },
  }
}
