import { expect, test } from "bun:test"
import plugin from "./index.js"

test("renames the current session through the 2.0.4 update method", async () => {
  let execute: ((input: { title: string }, tool: { sessionID?: string }) => Promise<{ content: string }>) | undefined
  const updates: Array<{ sessionID: string; title: string }> = []

  await plugin.setup({
    tool: {
      transform: async (register: (editor: { add: (tool: { execute: typeof execute }) => void }) => void) => {
        register({ add: (tool) => (execute = tool.execute) })
      },
    },
    session: {
      update: async (input: { sessionID: string; title: string }) => {
        updates.push(input)
      },
    },
  })

  expect(execute).toBeDefined()
  const result = await execute!({ title: "  Updated title  " }, { sessionID: "ses_test" })

  expect(updates).toEqual([{ sessionID: "ses_test", title: "Updated title" }])
  expect(JSON.parse(result.content)).toEqual({ title: "Updated title" })
})
