/**
 * Lazily loaded sentence embedder backed by transformers.js in a child process.
 *
 * OpenCode runs server plugins in a Bun worker and terminates that worker at
 * shutdown. Loading onnxruntime-node there makes Bun tear down NAPI on worker
 * termination, which can hard-crash the entire OpenCode process. Keeping the
 * native addon in a child confines that failure boundary and lets us reclaim
 * its roughly 300 MB RSS without touching the host's NAPI environment.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { noopNotify, type Notify } from "./notify.ts"

export type Vectors = Float32Array[]

export type EmbedWorkerRequest = {
  type: "embed"
  id: number
  options: { model: string; dims: number; batch: number; cacheDir: string }
  texts: string[]
}

export type EmbedWorkerResponse =
  | { type: "result"; id: number; vectors: Vectors; loadMs?: number }
  | { type: "error"; id: number; error: string }

export interface Embedder {
  embed(texts: string[]): Promise<Vectors>
  loaded(): boolean
  dispose(): Promise<void>
  shutdown(): void
}

export type EmbedderOpts = {
  model: string
  dims: number
  batch: number
  idleMs: number
  cacheDir: string
  log: (...args: unknown[]) => void
  notify?: Notify
}

export function createEmbedder(opts: EmbedderOpts): Embedder {
  type WorkerProcess = Bun.Subprocess<"ignore", "ignore", "pipe">
  type Pending = { resolve: (vectors: Vectors) => void; reject: (error: Error) => void }

  let worker: WorkerProcess | null = null
  let ready = false
  let nextId = 1
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let serial: Promise<unknown> = Promise.resolve()
  let downloadNotice = false
  let closed = false
  const pending = new Map<number, Pending>()
  const intentional = new WeakSet<WorkerProcess>()
  const notify = opts.notify ?? noopNotify

  const clearIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
  }

  const failPending = (error: Error) => {
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }

  const stop = (permanent = false) => {
    if (permanent) closed = true
    clearIdle()
    const proc = worker
    worker = null
    ready = false
    if (!proc) return null
    intentional.add(proc)
    failPending(new Error("embedder worker stopped"))
    try {
      // onnxruntime-node can panic during Bun teardown even in the child. SIGKILL
      // skips runtime teardown entirely; the OS safely reclaims the native state.
      proc.kill("SIGKILL")
    } catch {}
    return proc
  }

  const scheduleIdle = () => {
    clearIdle()
    if (opts.idleMs <= 0 || !worker) return
    idleTimer = setTimeout(stop, opts.idleMs)
    idleTimer.unref?.()
  }

  const onMessage = (message: EmbedWorkerResponse) => {
    if (!message || (message.type !== "result" && message.type !== "error")) return
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.type === "error") {
      request.reject(new Error(message.error))
    } else {
      ready = true
      if (message.loadMs !== undefined) opts.log(`embedder worker loaded in ${Math.round(message.loadMs)}ms`)
      if (downloadNotice) {
        downloadNotice = false
        notify({ message: "Embedding model ready — semantic search is live.", variant: "success" })
      }
      request.resolve(message.vectors)
    }
    scheduleIdle()
  }

  const start = (): WorkerProcess => {
    if (worker && !worker.killed) return worker
    clearIdle()
    ready = false
    const models = path.join(opts.cacheDir, "models")
    downloadNotice = !fs.existsSync(path.join(models, opts.model))
    if (downloadNotice)
      notify({
        message: `Downloading the embedding model (${opts.model}, ~33 MB). One time only; semantic search is unavailable until it lands.`,
        variant: "info",
      })

    const proc = Bun.spawn({
      cmd: [process.execPath, fileURLToPath(new URL("./embedder-worker.ts", import.meta.url))],
      env: { ...process.env, BUN_BE_BUN: "1" },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      ipc: onMessage,
      onExit(exited, code, signal, error) {
        const wasCurrent = worker === exited
        if (wasCurrent) {
          worker = null
          ready = false
          clearIdle()
          failPending(new Error(`embedder worker exited (code=${code}, signal=${signal})`))
        }
        if (!intentional.has(exited)) opts.log("embedder worker exited unexpectedly", { code, signal, error })
      },
    })
    worker = proc
    proc.unref()
    void new Response(proc.stderr)
      .text()
      .then((text) => {
        if (text.trim()) opts.log("embedder worker stderr", text.trim())
      })
      .catch(() => {})
    if (proc.exitCode !== null) worker = null
    return proc
  }

  const request = (texts: string[]): Promise<Vectors> => {
    if (closed) return Promise.reject(new Error("embedder is shut down"))
    clearIdle()
    const proc = start()
    const id = nextId++
    return new Promise<Vectors>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      try {
        proc.send({
          type: "embed",
          id,
          options: { model: opts.model, dims: opts.dims, batch: opts.batch, cacheDir: opts.cacheDir },
          texts,
        } satisfies EmbedWorkerRequest)
      } catch (error) {
        pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  return {
    embed(texts) {
      if (!texts.length) return Promise.resolve([])
      const result = serial.then(() => request(texts))
      serial = result.then(
        () => undefined,
        () => undefined,
      )
      return result
    },
    loaded: () => ready,
    async dispose() {
      const proc = stop(true)
      if (proc) await Promise.race([proc.exited, Bun.sleep(1_000)])
    },
    shutdown() {
      stop(true)
    },
  }
}

/** Deterministic stand-in used by tests so indexing can run without the ONNX model. */
export function createFakeEmbedder(dims: number): Embedder {
  const hash = (s: string, seed: number) => {
    let h = 2166136261 ^ seed
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    return (h >>> 0) / 4294967295
  }
  return {
    async embed(texts) {
      return texts.map((t) => {
        const v = new Float32Array(dims)
        const words = t.toLowerCase().match(/[a-z0-9]+/g) ?? []
        for (const w of words) v[Math.floor(hash(w, 7) * dims)] += 1
        let norm = 0
        for (let i = 0; i < dims; i++) norm += v[i] * v[i]
        norm = Math.sqrt(norm) || 1
        for (let i = 0; i < dims; i++) v[i] /= norm
        return v
      })
    },
    loaded: () => true,
    dispose: async () => {},
    shutdown: () => {},
  }
}
