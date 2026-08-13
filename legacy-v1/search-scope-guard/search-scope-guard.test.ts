import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import path from "node:path"
import { SearchScopeGuardPlugin, unsafeSearchRoot } from "./search-scope-guard"

const home = "/Users/max"

describe("unsafeSearchRoot", () => {
  test.each([
    ["/Users/max", "home"],
    ["/Users", "home-ancestor"],
    ["/", "home-ancestor"],
    ["/Users/max/Library", "library"],
    ["/Users/max/Library/Application Support", "library"],
  ] as const)("blocks %s", (root, reason) => {
    expect(unsafeSearchRoot(root, home)).toBe(reason)
  })

  test.each([
    "/Users/max/Projects/example",
    "/Users/max/Projects_personal/example",
    "/Users/max/.config/opencode",
    "/Users/max/scratch",
    "/tmp",
  ])("allows %s", (root) => {
    expect(unsafeSearchRoot(root, home)).toBeUndefined()
  })

  test("does not confuse sibling path prefixes with ancestors", () => {
    expect(unsafeSearchRoot("/Users/ma", home)).toBeUndefined()
    expect(unsafeSearchRoot("/Users/maxwell", home)).toBeUndefined()
  })
})

describe("SearchScopeGuardPlugin", () => {
  test("blocks broad glob and grep calls before execution", async () => {
    const hooks = await SearchScopeGuardPlugin({ directory: path.join(homedir(), "scratch") } as any)
    const before = hooks["tool.execute.before"]!

    await expect(
      before({ tool: "glob", sessionID: "test", callID: "glob" }, { args: { path: homedir() } }),
    ).rejects.toThrow("Broad filesystem search blocked")
    await expect(
      before(
        { tool: "grep", sessionID: "test", callID: "grep" },
        { args: { path: path.join(homedir(), "Library") } },
      ),
    ).rejects.toThrow("Broad filesystem search blocked")
  })

  test("uses the process directory when path is omitted", async () => {
    const hooks = await SearchScopeGuardPlugin({ directory: homedir() } as any)

    await expect(
      hooks["tool.execute.before"]!({ tool: "glob", sessionID: "test", callID: "glob" }, { args: {} }),
    ).rejects.toThrow("Broad filesystem search blocked")
  })

  test("allows scoped searches and unrelated tools", async () => {
    const hooks = await SearchScopeGuardPlugin({ directory: path.join(homedir(), "scratch") } as any)
    const before = hooks["tool.execute.before"]!

    await expect(
      before(
        { tool: "glob", sessionID: "test", callID: "glob" },
        { args: { path: path.join(homedir(), "scratch") } },
      ),
    ).resolves.toBeUndefined()
    await expect(
      before({ tool: "read", sessionID: "test", callID: "read" }, { args: { filePath: homedir() } }),
    ).resolves.toBeUndefined()
  })

  test("adds the scope rule to guarded tool descriptions once", async () => {
    const hooks = await SearchScopeGuardPlugin({ directory: path.join(homedir(), "scratch") } as any)
    const definition = hooks["tool.definition"]!
    const output = { description: "Match files", parameters: {} }

    await definition({ toolID: "glob" }, output)
    await definition({ toolID: "glob" }, output)

    expect(output.description.match(/home directory/g)).toHaveLength(1)
  })
})
