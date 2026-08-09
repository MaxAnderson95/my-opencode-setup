/** Native embedding runtime isolated from OpenCode's Bun worker. */
import path from "node:path"
import type { EmbedWorkerRequest, EmbedWorkerResponse, Vectors } from "./embedder.ts"

type FeaturePipeline = (
  texts: string[],
  options: { pooling: "mean"; normalize: true },
) => Promise<{ data: Float32Array; dispose?: () => void }>

let loading: Promise<FeaturePipeline> | null = null
let loadMs: number | undefined
let queue: Promise<void> = Promise.resolve()

async function load(options: EmbedWorkerRequest["options"]): Promise<FeaturePipeline> {
  if (loading) return loading
  loading = (async () => {
    const { pipeline, env } = await import("@huggingface/transformers")
    const createPipeline = pipeline as unknown as (
      task: string,
      model: string,
      options: { dtype: "q8" },
    ) => Promise<FeaturePipeline>
    env.cacheDir = path.join(options.cacheDir, "models")
    const started = performance.now()
    const pipe = await createPipeline("feature-extraction", options.model, { dtype: "q8" })
    loadMs = performance.now() - started
    return pipe
  })()
  loading.catch(() => {
    loading = null
  })
  return loading
}

async function handle(request: EmbedWorkerRequest): Promise<void> {
  if (!request || request.type !== "embed" || !Array.isArray(request.texts)) return
  try {
    const pipe = await load(request.options)
    const vectors: Vectors = []
    for (let i = 0; i < request.texts.length; i += request.options.batch) {
      const batch = request.texts.slice(i, i + request.options.batch)
      const tensor = await pipe(batch, { pooling: "mean", normalize: true })
      const data = tensor.data as Float32Array
      for (let j = 0; j < batch.length; j++) {
        vectors.push(data.slice(j * request.options.dims, (j + 1) * request.options.dims))
      }
      tensor.dispose?.()
    }
    const response: EmbedWorkerResponse = { type: "result", id: request.id, vectors, loadMs }
    loadMs = undefined
    process.send?.(response)
  } catch (error) {
    const response: EmbedWorkerResponse = {
      type: "error",
      id: request.id,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    }
    process.send?.(response)
  }
}

process.on("message", (message) => {
  queue = queue.then(() => handle(message as EmbedWorkerRequest))
})

// If the host disappears before its dispose hook runs, avoid native teardown in
// this process too. The host never inherits stderr from this private worker.
process.on("disconnect", () => process.kill(process.pid, "SIGKILL"))
process.on("SIGTERM", () => process.kill(process.pid, "SIGKILL"))
