import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import type { Plugin } from "@opencode-ai/plugin"

const GUARDED_TOOLS = new Set(["glob", "grep"])
const DESCRIPTION_SUFFIX =
  " Use a project or configuration subdirectory as the search path. Searches rooted at the home directory, its ancestors, or the macOS Library directory are blocked."

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

export function unsafeSearchRoot(root: string, home: string): "home" | "home-ancestor" | "library" | undefined {
  if (root === home) return "home"
  if (isWithin(root, home)) return "home-ancestor"
  if (isWithin(path.join(home, "Library"), root)) return "library"
  return undefined
}

function canonicalize(value: string): string {
  try {
    return realpathSync.native(value)
  } catch {
    return path.resolve(value)
  }
}

function resolveSearchRoot(raw: unknown, directory: string, home: string): string {
  if (typeof raw !== "string" || raw.length === 0) return canonicalize(directory)
  const expanded = raw === "~" ? home : raw.startsWith(`~${path.sep}`) ? path.join(home, raw.slice(2)) : raw
  return canonicalize(path.isAbsolute(expanded) ? expanded : path.resolve(directory, expanded))
}

function blockedMessage(root: string, reason: NonNullable<ReturnType<typeof unsafeSearchRoot>>): string {
  const detail =
    reason === "library"
      ? "macOS Library trees contain protected and potentially blocking filesystem providers"
      : "a home-wide search can traverse protected and potentially blocking filesystem providers"
  return [
    `Broad filesystem search blocked: ${root}`,
    "",
    `${detail}. Choose a narrower project or configuration directory and retry.`,
    "If the file location is already known, read it directly instead of searching.",
  ].join("\n")
}

export const SearchScopeGuardPlugin: Plugin = async ({ directory }) => {
  const home = canonicalize(homedir())

  return {
    "tool.execute.before": async (input, output) => {
      if (!GUARDED_TOOLS.has(input.tool)) return
      const root = resolveSearchRoot(output.args?.path, directory, home)
      const reason = unsafeSearchRoot(root, home)
      if (reason) throw new Error(blockedMessage(root, reason))
    },

    "tool.definition": async (input, output) => {
      if (!GUARDED_TOOLS.has(input.toolID) || output.description.includes(DESCRIPTION_SUFFIX)) return
      output.description += DESCRIPTION_SUFFIX
    },
  }
}

export default SearchScopeGuardPlugin
