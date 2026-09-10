import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import type { MCPEditor } from "@opencode/plugin/promise/mcp"
import type { ToolEditor, Info } from "@opencode/plugin/promise/tool"
import plugin from "./mcp-lazy"

async function location(disabled = true, registerTools = true) {
  const source = { type: "remote" as const, url: "https://example.com/mcp", disabled }
  let current = { ...source }
  let mcpTransform: (editor: MCPEditor) => void = () => {}
  let toolTransform: (editor: ToolEditor) => void = () => {}
  const tools = new Map<string, Info>()
  const registration = { dispose: async () => {} }
  const rebuildTools = () => {
    tools.clear()
    if (!current.disabled && registerTools) tools.set("docs_read", {
      name: "read",
      options: { namespace: "docs" },
      description: "test tool",
      input: { type: "object" },
      execute: async () => ({ content: "ok" }),
    })
    toolTransform({
      list: () => [...tools].map(([id, tool]) => ({ ...tool, id })),
      add: (tool) => { tools.set(tool.name, tool) },
      get: () => { throw new Error("Unexpected get") },
      namespace: () => { throw new Error("Unexpected namespace") },
      update: () => { throw new Error("Unexpected update") },
      remove: () => { throw new Error("Unexpected remove") },
    })
  }
  const reload = async () => {
    current = { ...source }
    mcpTransform({
      list: () => [["docs", current]],
      update: (_name, update) => update(current),
      get: () => { throw new Error("Unexpected get") },
      set: () => { throw new Error("Unexpected set") },
      remove: () => { throw new Error("Unexpected remove") },
    })
    // Core refreshes tools after the connection state changes.
    setTimeout(rebuildTools, 10)
  }
  await plugin.setup({
    location: { directory: "/test" },
    mcp: {
      transform: async (callback: typeof mcpTransform) => {
        mcpTransform = callback
        await reload()
        return registration
      },
      reload,
      list: async () => ({ data: [{ name: "docs", status: { status: current.disabled ? "disabled" : "connected" } }] }),
    },
    session: { hook: async () => registration },
    tool: {
      transform: async (callback: typeof toolTransform) => {
        toolTransform = callback
        rebuildTools()
        return registration
      },
    },
  } as unknown as Plugin.Context)
  return {
    source,
    reload,
    async run(active: boolean) {
      const tool = tools.get(active ? "mcp_enable" : "mcp_disable")!
      return tool.execute({ servers: ["docs"] }, {} as Parameters<Info["execute"]>[1])
    },
  }
}

test("enable waits for delayed registry refresh and disable waits for removal", async () => {
  const instance = await location()
  expect((await instance.run(true)).content).toContain("1 registered tools")
  expect((await instance.run(false)).content).toContain("tools removed from the registry")
})

test("separate locations keep independent protection and recompute it on config reload", async () => {
  const lazy = await location()
  const alwaysOn = await location(false)
  expect((await lazy.run(true)).content).toContain("registered tools")
  expect((await alwaysOn.run(false)).content).toContain("always-on, cannot be disabled")
  expect((await lazy.run(false)).content).toContain("tools removed")
  lazy.source.disabled = false
  await lazy.reload()
  expect((await lazy.run(false)).content).toContain("always-on, cannot be disabled")
})

test("connected without registered tools does not report readiness", async () => {
  const instance = await location(true, false)
  expect((await instance.run(true)).content).toContain("Tool readiness is unverified")
})
