import { Plugin } from "@opencode-ai/plugin"
import { appendFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createLoop } from "./lib/loop.ts"
import { Refresher } from "./lib/refresher.ts"

// Core refreshes when under five minutes remain, so ticking every two
// minutes keeps every token inside its validity window.
const TICK_MS = 2 * 60_000
// Every opencode server process runs this loop against the same database.
// Random per-tick jitter spreads their ticks apart so that, when a token
// falls due, one process almost always refreshes it before the others look.
const JITTER_MS = 60_000

const LOG = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "opencode/token-refresh.log")

const log = (line: string) => {
  try {
    appendFileSync(LOG, `${new Date().toISOString()} pid=${process.pid} ${line}\n`)
  } catch {}
}

type Context = Parameters<Plugin.Plugin["setup"]>[0]

const refresher = new Refresher({ now: Date.now, log })

const loop = createLoop<Context>({
  tick: (ctx) =>
    refresher.tick({
      list: async () => (await ctx.integration.list()).data,
      resolve: (connection) => ctx.integration.connection.resolve(connection),
    }),
  tickMs: TICK_MS,
  jitterMs: JITTER_MS,
  random: Math.random,
  timer: { set: setTimeout, clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
  log,
})

export default Plugin.define({
  id: "token-refresh",
  setup: (ctx) => loop.attach(ctx),
})
