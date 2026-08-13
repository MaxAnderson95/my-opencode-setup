import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

export type CalloutState = {
  content: string
  updatedAt: number
}

const dataDir = join(process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? ".", ".local", "share"), "opencode", "callout")

function statePath(sessionID: string) {
  return join(dataDir, `${sessionID}.json`)
}

export async function readCallout(sessionID: string): Promise<CalloutState | undefined> {
  try {
    return JSON.parse(await readFile(statePath(sessionID), "utf8")) as CalloutState
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
}

export async function writeCallout(sessionID: string, content: string): Promise<void> {
  await mkdir(dataDir, { recursive: true })
  if (!content) {
    await rm(statePath(sessionID), { force: true })
    return
  }

  const path = statePath(sessionID)
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify({ content, updatedAt: Date.now() }), "utf8")
  await rename(temporary, path)
}
