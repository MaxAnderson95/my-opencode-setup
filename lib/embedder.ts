/**
 * Lazily loaded sentence embedder backed by in-process transformers.js.
 *
 * The ONNX session costs roughly 300 MB resident, so it is loaded on first use
 * and released after an idle period rather than held for the life of the
 * process.
 */
import fs from "node:fs"
import path from "node:path"
import { noopNotify, type Notify } from "./notify.ts"

export type Vectors = Float32Array[]

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
  type Loaded = { embed(texts: string[]): Promise<Vectors>; release(): Promise<void> }
  let loading: Promise<Loaded> | null = null
  let lastUse = 0

  const load = (): Promise<Loaded> => {
    lastUse = Date.now()
    if (loading) return loading
    const p = (async (): Promise<Loaded> => {
      // Dynamic import: Bun caches failed static import resolution for the life
      // of the process, so a missing dependency here would permanently poison
      // module load for the whole plugin rather than just disabling search.
      const { pipeline, env } = await import("@huggingface/transformers")
      const models = path.join(opts.cacheDir, "models")
      env.cacheDir = models
      // The first load fetches ~33 MB from the Hugging Face hub with no other
      // visible sign, which reads as a hang on a slow connection.
      const cached = fs.existsSync(path.join(models, opts.model))
      if (!cached)
        (opts.notify ?? noopNotify)({
          message: `Downloading the embedding model (${opts.model}, ~33 MB). One time only; semantic search is unavailable until it lands.`,
          variant: "info",
        })
      const t0 = performance.now()
      const pipe = await pipeline("feature-extraction", opts.model, { dtype: "q8" })
      opts.log(`embedder loaded in ${Math.round(performance.now() - t0)}ms`)
      if (!cached)
        (opts.notify ?? noopNotify)({ message: "Embedding model ready — semantic search is live.", variant: "success" })
      return {
        async embed(texts: string[]): Promise<Vectors> {
          lastUse = Date.now()
          const out: Vectors = []
          for (let i = 0; i < texts.length; i += opts.batch) {
            const batch = texts.slice(i, i + opts.batch)
            const tensor = await pipe(batch, { pooling: "mean", normalize: true })
            const data = tensor.data as Float32Array
            for (let j = 0; j < batch.length; j++) out.push(data.slice(j * opts.dims, (j + 1) * opts.dims))
            tensor.dispose?.()
            lastUse = Date.now()
          }
          return out
        },
        release: async () => {
          await pipe.dispose?.()
        },
      }
    })()
    loading = p
    p.catch((e) => {
      opts.log("embedder load failed", e)
      if (loading === p) loading = null // allow a retry on next use
    })
    return p
  }

  const reaper = setInterval(() => {
    if (!loading || Date.now() - lastUse < opts.idleMs) return
    const p = loading
    loading = null
    p.then((e) => e.release()).catch(() => {})
    opts.log("embedder disposed after idle")
  }, 60_000)
  reaper.unref?.()

  return {
    async embed(texts) {
      if (!texts.length) return []
      return (await load()).embed(texts)
    },
    loaded: () => loading !== null,
    async dispose() {
      const p = loading
      loading = null
      if (p) await p.then((e) => e.release()).catch(() => {})
    },
    shutdown() {
      clearInterval(reaper)
      // Deliberately do NOT release the ONNX session here. shutdown() runs as
      // the process is exiting, and onnxruntime-node's teardown calls back into
      // a half-dead NAPI env; when it tries to raise an error there,
      // napi_create_error fails and Bun hard-panics ("NAPI FATAL ERROR:
      // Error::New napi_create_error"). The OS reclaims the session on exit
      // regardless, and the idle reaper still releases it mid-process where
      // NAPI is healthy.
      //
      // Caveats, if this needs revisiting:
      // - This is a workaround, not a fix. The underlying bug is
      //   onnxruntime-node raising a NAPI error during env teardown; it belongs
      //   upstream in Bun / onnxruntime-node, not here.
      // - A narrow race remains: if the reaper's 60s tick releases at the same
      //   moment the process exits, the panic can still happen. If it recurs,
      //   the durable fix is to move embedding into a subprocess so the NAPI
      //   addon never shares a VM with the TUI lifecycle.
      loading = null
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
