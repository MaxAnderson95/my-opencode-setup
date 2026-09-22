import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

export type ModelRef = { providerID: string; modelID: string }

export type FavoriteFile = ReturnType<typeof createFavoriteFile>

export const modelKey = (model: ModelRef) => `${model.providerID}/${model.modelID}`

/** The TUI's model preference file (packages/tui/src/context/local.tsx, `paths.state/model.json`). */
export function defaultPreferenceFile() {
  const state = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state")
  return path.join(state, "opencode", "model.json")
}

export function toggleFavorite(favorites: readonly ModelRef[], model: ModelRef): ModelRef[] {
  const key = modelKey(model)
  const rest = favorites.filter((item) => modelKey(item) !== key)
  return rest.length === favorites.length ? [...favorites, model] : rest
}

/**
 * Swaps a favorite with the nearest shown favorite in `direction`. Entries the user cannot see
 * (filtered out, or no longer resolvable to a model) keep their slots instead of absorbing the move.
 */
export function moveFavorite(
  favorites: readonly ModelRef[],
  key: string,
  direction: -1 | 1,
  shown: ReadonlySet<string>,
): ModelRef[] {
  const next = [...favorites]
  const from = next.findIndex((item) => modelKey(item) === key)
  if (from === -1) return next
  let to = from + direction
  while (to >= 0 && to < next.length && !shown.has(modelKey(next[to]))) to += direction
  if (to < 0 || to >= next.length) return next
  ;[next[from], next[to]] = [next[to], next[from]]
  return next
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function favoritesOf(document: Record<string, unknown>): ModelRef[] {
  if (!Array.isArray(document.favorite)) return []
  return document.favorite.flatMap((item): ModelRef[] => {
    if (!isRecord(item)) return []
    const { providerID, modelID } = item
    if (typeof providerID !== "string" || !providerID) return []
    if (typeof modelID !== "string" || !modelID) return []
    return [{ providerID, modelID }]
  })
}

function errorCode(error: unknown) {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined
}

async function readDocument(file: string) {
  const text = await readFile(file, "utf8").catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return "{}"
    throw error
  })
  const value: unknown = JSON.parse(text)
  if (!isRecord(value)) throw new Error(`${file} does not contain a JSON object`)
  return value
}

async function writeAtomic(file: string, value: unknown) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(value))
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}

// Uses the lock directory OpenCode's Flock derives for this file (packages/util/src/flock.ts),
// so the TUI's own preference writes wait for ours instead of overwriting them.
async function withLock<T>(file: string, run: () => Promise<T>) {
  const directory = path.join(path.dirname(file), "locks")
  const lock = path.join(directory, createHash("sha1").update(file).digest("hex") + ".lock")
  await mkdir(directory, { recursive: true })
  const deadline = Date.now() + 5_000
  while (true) {
    try {
      await mkdir(lock, { mode: 0o700 })
      break
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error
      if (Date.now() > deadline) throw new Error(`Timed out waiting for the lock on ${file}`)
      await sleep(50)
    }
  }
  try {
    return await run()
  } finally {
    await rm(lock, { recursive: true, force: true })
  }
}

export function createFavoriteFile(file = defaultPreferenceFile()) {
  let pending: Promise<unknown> = Promise.resolve()

  return {
    async read() {
      return favoritesOf(await readDocument(file))
    },
    /** Applies `change` to the favorites on disk, preserving every other field. Calls run in order. */
    update(change: (favorites: ModelRef[]) => ModelRef[]) {
      const result = pending.then(() =>
        withLock(file, async () => {
          const document = await readDocument(file)
          const favorite = change(favoritesOf(document))
          await writeAtomic(file, { ...document, favorite })
          return favorite
        }),
      )
      pending = result.catch(() => undefined)
      return result
    },
  }
}
