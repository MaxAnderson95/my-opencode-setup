import os from "node:os"
import path from "node:path"

function expandHome(value: string, home: string): string | null {
  if (value === "~") return home
  if (value.startsWith(`~${path.sep}`)) return path.join(home, value.slice(2))
  if (!path.isAbsolute(value)) return null
  return value
}

function contains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

export class DirectoryExclusions {
  private roots: string[] = []

  constructor(entries: readonly string[] = [], private home: string = os.homedir()) {
    this.update(entries)
  }

  update(entries: readonly string[]): void {
    this.roots = [
      ...new Set(
        entries
          .map((entry) => expandHome(entry.trim(), this.home))
          .filter((entry): entry is string => entry !== null)
          .map((entry) => path.resolve(entry)),
      ),
    ]
  }

  matches(directory: string): boolean {
    const candidate = path.resolve(directory)
    return this.roots.some((root) => contains(root, candidate))
  }

  entries(): readonly string[] {
    return this.roots
  }
}
