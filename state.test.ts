import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "bun:test"
import { applyTodos } from "./todo"
import { createStore, parseTodos, renderTodos } from "./state"

const sessionID = "ses_testtodo01"

test("rejects a payload that is not a full list", () => {
  expect(() => parseTodos({})).toThrow("todowrite requires")
  expect(() => parseTodos({ todos: [{ content: "  ", status: "pending", priority: "low" }] })).toThrow("content")
  expect(() => parseTodos({ todos: [{ content: "Ship it", status: "done", priority: "low" }] })).toThrow("status")
})

test("replaces the session list and clears it with an empty write", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-todo-"))
  try {
    const store = createStore(root)
    const written = await applyTodos(store, sessionID, {
      todos: [
        { content: "Write the tool", status: "completed", priority: "high" },
        { content: "Show the dock", status: "in_progress", priority: "medium" },
      ],
    })

    expect(written.content).toBe("1 open\n- [x] high: Write the tool\n- [>] medium: Show the dock")
    expect((await store.read(sessionID))?.todos).toEqual([
      { content: "Write the tool", status: "completed", priority: "high" },
      { content: "Show the dock", status: "in_progress", priority: "medium" },
    ])

    const cleared = await applyTodos(store, sessionID, { todos: [] })
    expect(cleared.content).toBe("Todo list cleared.")
    expect(await store.read(sessionID)).toBeUndefined()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("renderTodos reports no open work when every item is finished", () => {
  expect(
    renderTodos([{ content: "Done", status: "completed", priority: "low" }]),
  ).toBe("0 open\n- [x] low: Done")
})
