import { describe, expect, test } from "bun:test"
import type { ToolContext } from "@opencode-ai/plugin"
import { runWithPermissionBridge, SubagentModelPlugin } from "./subagent-model"

function permissionEvent(sessionID: string, id = "per_1") {
  return {
    type: "permission.asked" as const,
    properties: {
      id,
      sessionID,
      permission: "external_directory",
      patterns: ["/tmp/example/*"],
      metadata: { path: "/tmp/example/file.txt" },
      always: ["/tmp/example/*"],
    },
  }
}

function setup(options?: { ask?: ToolContext["ask"]; events?: unknown[] }) {
  const abort = new AbortController()
  const asks: Parameters<ToolContext["ask"]>[0][] = []
  const replies: Array<{ permissionID: string; response: string }> = []
  const aborted: string[] = []
  let listenerRemoved = false
  let finishRun!: () => void
  const runFinished = new Promise<void>((resolve) => {
    finishRun = resolve
  })
  const ask = options?.ask ?? (async () => {})

  const context = {
    sessionID: "ses_parent",
    messageID: "msg_1",
    agent: "build",
    directory: "/workspace",
    worktree: "/workspace",
    abort: abort.signal,
    metadata() {},
    async ask(input) {
      asks.push(input)
      await ask(input)
    },
  } satisfies ToolContext

  const client = {
    postSessionIdPermissionsPermissionId: async (input: {
      path: { permissionID: string }
      body?: { response: string }
    }) => {
      replies.push({ permissionID: input.path.permissionID, response: input.body!.response })
      finishRun()
      return { data: true }
    },
    session: {
      async abort(input: { path: { id: string } }) {
        aborted.push(input.path.id)
        return { data: true }
      },
    },
  }

  const subscribe = (listener: (event: unknown) => void) => {
    queueMicrotask(() => {
      for (const event of options?.events ?? [permissionEvent("ses_child")]) listener(event)
    })
    return () => {
      listenerRemoved = true
    }
  }

  return { abort, aborted, asks, client, context, replies, runFinished, subscribe, listenerRemoved: () => listenerRemoved }
}

describe("runWithPermissionBridge", () => {
  test("forwards child permissions and approves the original request once", async () => {
    const fixture = setup({
      events: [permissionEvent("ses_other", "per_other"), permissionEvent("ses_child")],
    })

    const result = await runWithPermissionBridge({
      client: fixture.client as never,
      context: fixture.context,
      childSessionID: "ses_child",
      subscribe: fixture.subscribe,
      run: async () => {
        await fixture.runFinished
        return "complete"
      },
    })

    expect(result).toBe("complete")
    expect(fixture.asks).toEqual([
      {
        permission: "external_directory",
        patterns: ["/tmp/example/*"],
        always: ["/tmp/example/*"],
        metadata: { path: "/tmp/example/file.txt" },
      },
    ])
    expect(fixture.replies).toEqual([{ permissionID: "per_1", response: "once" }])
    expect(fixture.aborted).toEqual([])
    expect(fixture.listenerRemoved()).toBe(true)
  })

  test("rejects the original permission and aborts the child when the caller rejects", async () => {
    const rejection = new Error("Permission rejected")
    const fixture = setup({ ask: async () => Promise.reject(rejection) })

    await expect(
      runWithPermissionBridge({
        client: fixture.client as never,
        context: fixture.context,
        childSessionID: "ses_child",
        subscribe: fixture.subscribe,
        run: () => new Promise<never>(() => {}),
      }),
    ).rejects.toBe(rejection)

    expect(fixture.replies).toEqual([{ permissionID: "per_1", response: "reject" }])
    expect(fixture.aborted).toEqual(["ses_child"])
    expect(fixture.listenerRemoved()).toBe(true)
  })

  test("rejects a pending permission and aborts the child when the caller aborts", async () => {
    let askStarted!: () => void
    const started = new Promise<void>((resolve) => {
      askStarted = resolve
    })
    const fixture = setup({
      ask: async () => {
        askStarted()
        await new Promise(() => {})
      },
    })

    const result = runWithPermissionBridge({
      client: fixture.client as never,
      context: fixture.context,
      childSessionID: "ses_child",
      subscribe: fixture.subscribe,
      run: () => new Promise<never>(() => {}),
    })
    await started
    fixture.abort.abort(new Error("Caller aborted"))

    await expect(result).rejects.toThrow("Caller aborted")
    expect(fixture.replies).toEqual([{ permissionID: "per_1", response: "reject" }])
    expect(fixture.aborted).toEqual(["ses_child"])
    expect(fixture.listenerRemoved()).toBe(true)
  })
})

test("publishes the child session ID before prompting the child", async () => {
  const order: string[] = []
  const abort = new AbortController()
  const metadata: Array<Parameters<ToolContext["metadata"]>[0]> = []
  const client = {
    config: {
      async providers() {
        return {
          data: {
            providers: [{ id: "test-provider", models: { "test-model": { id: "test-model" } } }],
          },
        }
      },
    },
    app: {
      async agents() {
        return { data: [{ name: "general", mode: "subagent" }] }
      },
    },
    postSessionIdPermissionsPermissionId: async () => ({ data: true }),
    session: {
      async create() {
        order.push("create")
        return { data: { id: "ses_child" } }
      },
      async prompt() {
        order.push("prompt")
        return { data: { parts: [{ type: "text", text: "complete" }], info: {} } }
      },
      async abort() {
        return { data: true }
      },
    },
  }
  const plugin = await SubagentModelPlugin({ client, directory: "/workspace" } as never)
  const context = {
    sessionID: "ses_parent",
    messageID: "msg_1",
    agent: "build",
    directory: "/workspace",
    worktree: "/workspace",
    abort: abort.signal,
    metadata(input) {
      order.push("metadata")
      metadata.push(input)
    },
    async ask() {},
  } satisfies ToolContext

  await plugin.tool!.task_with_model.execute(
    {
      description: "Test child",
      prompt: "Return complete",
      providerID: "test-provider",
      modelID: "test-model",
    },
    context,
  )

  expect(order).toEqual(["create", "metadata", "prompt"])
  expect(metadata).toEqual([{ metadata: { childSessionID: "ses_child" } }])
})
