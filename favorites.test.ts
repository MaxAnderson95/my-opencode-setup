import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createFavoriteFile, modelKey, moveFavorite, toggleFavorite, type ModelRef } from "./favorites"

const a = { providerID: "anthropic", modelID: "opus" }
const b = { providerID: "openai", modelID: "sol" }
const c = { providerID: "xai", modelID: "grok" }
const keys = (list: ModelRef[]) => list.map(modelKey)

describe("moveFavorite", () => {
  const all = new Set(keys([a, b, c]))

  test("swaps with the neighbour in the given direction", () => {
    expect(keys(moveFavorite([a, b, c], modelKey(b), -1, all))).toEqual(keys([b, a, c]))
    expect(keys(moveFavorite([a, b, c], modelKey(b), 1, all))).toEqual(keys([a, c, b]))
  })

  test("stays put at either end", () => {
    expect(keys(moveFavorite([a, b, c], modelKey(a), -1, all))).toEqual(keys([a, b, c]))
    expect(keys(moveFavorite([a, b, c], modelKey(c), 1, all))).toEqual(keys([a, b, c]))
  })

  test("skips entries that are not shown", () => {
    const shown = new Set(keys([a, c]))
    expect(keys(moveFavorite([a, b, c], modelKey(c), -1, shown))).toEqual(keys([c, b, a]))
  })
})

describe("toggleFavorite", () => {
  test("appends a new favorite and removes an existing one", () => {
    expect(keys(toggleFavorite([a], b))).toEqual(keys([a, b]))
    expect(keys(toggleFavorite([a, b], { ...a }))).toEqual(keys([b]))
  })
})

describe("createFavoriteFile", () => {
  let directory: string | undefined

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
    directory = undefined
  })

  async function setup(document: unknown) {
    directory = await mkdtemp(path.join(os.tmpdir(), "model-favorites-"))
    const file = path.join(directory, "model.json")
    await writeFile(file, JSON.stringify(document))
    return file
  }

  test("rewrites only the favorite list", async () => {
    const file = await setup({ recent: [c], favorite: [a, b], variant: { "openai/sol": "high" }, extra: 1 })
    const store = createFavoriteFile(file)

    await store.update((list) => moveFavorite(list, modelKey(b), -1, new Set(keys(list))))

    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      recent: [c],
      favorite: [b, a],
      variant: { "openai/sol": "high" },
      extra: 1,
    })
    expect(keys(await store.read())).toEqual(keys([b, a]))
  })

  test("waits for OpenCode's lock on the file", async () => {
    const file = await setup({ favorite: [a] })
    const lock = path.join(path.dirname(file), "locks", createHash("sha1").update(file).digest("hex") + ".lock")
    await mkdir(lock, { recursive: true })

    let done = false
    const update = createFavoriteFile(file)
      .update((list) => toggleFavorite(list, b))
      .then(() => (done = true))
    await Bun.sleep(150)
    expect(done).toBe(false)

    await rm(lock, { recursive: true })
    await update
    expect(keys(await createFavoriteFile(file).read())).toEqual(keys([a, b]))
  })

  test("refuses to overwrite a file that is not a JSON object", async () => {
    const file = await setup([a])
    await expect(createFavoriteFile(file).update((list) => list)).rejects.toThrow("does not contain a JSON object")
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual([a])
  })
})
