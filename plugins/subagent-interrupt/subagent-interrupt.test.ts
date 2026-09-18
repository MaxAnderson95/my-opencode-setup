import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import plugin from "./subagent-interrupt"

type Execute = (
  input: { sessionID?: string },
  context: { sessionID: string },
) => Promise<{ content: string }>

async function register(options: {
  sessions: Record<string, { id: string; parentID?: string }>
  interrupted: boolean
}) {
  let execute: Execute | undefined
  const calls: string[] = []
  await plugin.setup({
    tool: {
      transform: async (edit: (editor: { add: (tool: { execute: Execute }) => void }) => void) => {
        edit({ add: (tool) => (execute = tool.execute) })
      },
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        const found = options.sessions[sessionID]
        if (!found) throw new Error("not found")
        return found
      },
      interrupt: async ({ sessionID }: { sessionID: string }) => {
        calls.push(sessionID)
        return { interrupted: options.interrupted }
      },
    },
  } as unknown as Plugin.Context)
  if (!execute) throw new Error("tool was not registered")
  return { execute, calls }
}

const child = { id: "ses_child", parentID: "ses_parent" }

test("interrupts a child session and reports the stop", async () => {
  const { execute, calls } = await register({ sessions: { ses_child: child }, interrupted: true })

  const result = await execute({ sessionID: "  ses_child  " }, { sessionID: "ses_parent" })

  expect(calls).toEqual(["ses_child"])
  expect(result.content).toContain("Interrupted subagent ses_child")
})

test("reports an idle no-op without claiming a stop", async () => {
  const { execute } = await register({ sessions: { ses_child: child }, interrupted: false })

  const result = await execute({ sessionID: "ses_child" }, { sessionID: "ses_parent" })

  expect(result.content).toContain("was not running")
})

test("refuses sessions that are not children of the caller", async () => {
  const { execute, calls } = await register({
    sessions: { ses_other: { id: "ses_other", parentID: "ses_elsewhere" }, ses_root: { id: "ses_root" } },
    interrupted: true,
  })

  await expect(execute({ sessionID: "ses_other" }, { sessionID: "ses_parent" })).rejects.toThrow(
    "not a subagent of this session",
  )
  await expect(execute({ sessionID: "ses_root" }, { sessionID: "ses_parent" })).rejects.toThrow(
    "not a subagent of this session",
  )
  await expect(execute({ sessionID: "ses_missing" }, { sessionID: "ses_parent" })).rejects.toThrow("not found")
  await expect(execute({ sessionID: "   " }, { sessionID: "ses_parent" })).rejects.toThrow("sessionID is required")
  expect(calls).toEqual([])
})
