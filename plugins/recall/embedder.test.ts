import { expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { createEmbedder } from "./lib/embedder.ts"

const CACHE_DIR = path.join(os.homedir(), ".local", "share", "opencode-recall")

test(
  "isolates ONNX from a terminating Bun host worker",
  async () => {
    const source = `
      import { createEmbedder } from ${JSON.stringify(import.meta.dir + "/lib/embedder.ts")}
      const embedder = createEmbedder({
        model: "Xenova/bge-small-en-v1.5",
        dims: 384,
        batch: 8,
        idleMs: 0,
        cacheDir: ${JSON.stringify(CACHE_DIR)},
        log: () => {},
      })
      const [vector] = await embedder.embed(["worker shutdown crash regression"])
      const result = { length: vector.length, loaded: embedder.loaded() }
      embedder.shutdown()
      postMessage(result)
      setInterval(() => {}, 1000)
    `
    const host = new Worker(`data:text/javascript,${encodeURIComponent(source)}`)
    const result = await new Promise<{ length: number; loaded: boolean }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("host worker timed out")), 10_000)
      host.onmessage = (event) => {
        clearTimeout(timer)
        resolve(event.data)
      }
      host.onerror = (event) => {
        clearTimeout(timer)
        reject(event.error ?? new Error(event.message))
      }
    })
    host.terminate()
    expect(result).toEqual({ length: 384, loaded: true })
  },
  15_000,
)

test("releases an idle embedding subprocess", async () => {
  const embedder = createEmbedder({
    model: "Xenova/bge-small-en-v1.5",
    dims: 384,
    batch: 8,
    idleMs: 25,
    cacheDir: CACHE_DIR,
    log: () => {},
  })
  const [vector] = await embedder.embed(["idle worker regression"])
  expect(vector.length).toBe(384)
  expect(embedder.loaded()).toBe(true)
  await Bun.sleep(75)
  expect(embedder.loaded()).toBe(false)
  const [again] = await embedder.embed(["idle worker restart regression"])
  expect(again.length).toBe(384)
  await embedder.dispose()
})
