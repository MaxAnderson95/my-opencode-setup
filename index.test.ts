import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import type { SessionContext } from "@opencode/plugin/promise/session"
import plugin from "./index.js"

test("injects each request's session ID while preserving existing context", async () => {
  let hook: ((event: SessionContext) => void) | undefined
  await plugin.setup({
    session: {
      hook: async (name: string, handler: typeof hook) => {
        expect(name).toBe("context")
        hook = handler
      },
    },
  } as unknown as Plugin.Context)
  expect(hook).toBeDefined()

  for (const sessionID of ["ses_parent", "ses_child", "ses_parent"]) {
    const event: SessionContext = {
      sessionID: sessionID as SessionContext["sessionID"],
      model: { providerID: "test", id: "test" } as SessionContext["model"],
      agent: "build" as SessionContext["agent"],
      system: [{ type: "text", text: "Existing system instructions" }],
      messages: [],
      tools: {},
      options: {},
    }

    hook!(event)

    expect(event.system).toEqual([
      { type: "text", text: "Existing system instructions" },
      { type: "text", text: `Current OpenCode session ID: ${sessionID}` },
    ])
  }
})
