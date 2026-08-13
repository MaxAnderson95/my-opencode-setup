import { describe, expect, test } from "bun:test"
import { isOAuth, isProtected, renderBlock, unknownMsg } from "./inventory"
import type { McpServerConfig, McpServerRow } from "./server"

const cfg: Record<string, McpServerConfig> = {
  exa: { type: "remote" },
  atlassian: { type: "remote", disabled: true },
  dash0: { type: "remote", disabled: true, oauth: false },
  playwright: { type: "local", disabled: true },
}

function row(name: string, status: McpServerRow["status"]): McpServerRow {
  return { name, status }
}

describe("isProtected", () => {
  test("config entry without disabled is always-on", () => {
    expect(isProtected(cfg, "exa")).toBe(true)
  })
  test("disabled: true is toggleable", () => {
    expect(isProtected(cfg, "atlassian")).toBe(false)
  })
  test("runtime-added server (absent from config) is toggleable", () => {
    expect(isProtected(cfg, "ephemeral")).toBe(false)
  })
})

describe("isOAuth", () => {
  test("remote defaults to oauth", () => {
    expect(isOAuth(cfg, "atlassian")).toBe(true)
  })
  test("oauth: false opts out", () => {
    expect(isOAuth(cfg, "dash0")).toBe(false)
  })
  test("local servers are never oauth", () => {
    expect(isOAuth(cfg, "playwright")).toBe(false)
  })
})

describe("renderBlock", () => {
  test("classifies servers and tags session-enabled ones", () => {
    const block = renderBlock(
      [
        row("exa", { status: "connected" }),
        row("atlassian", { status: "connected" }),
        row("dash0", { status: "disabled" }),
        row("playwright", { status: "failed", error: "spawn failed" }),
      ],
      cfg,
    )
    expect(block).toContain("- exa (always-on)")
    expect(block).toContain("- atlassian (enabled this session)")
    expect(block).toContain("- dash0")
    expect(block).toContain("- playwright — currently unavailable")
    expect(block).toContain('mcp_disable(["atlassian"])')
  })

  test("needs_auth renders the auth hint with the oauth tag", () => {
    const block = renderBlock([row("atlassian", { status: "needs_auth" })], cfg)
    expect(block).toContain("- atlassian (OAuth) — needs auth (have the user run: opencode mcp auth atlassian)")
  })

  test("no cleanup nudge when nothing is session-enabled", () => {
    const block = renderBlock([row("exa", { status: "connected" })], cfg)
    expect(block).not.toContain("You currently have these enabled")
    expect(block).toContain("Available (enable on demand):\n- (none)")
  })
})

describe("unknownMsg", () => {
  test("lists valid names", () => {
    expect(unknownMsg(["exa", "dash0"], "nope")).toBe("- nope: unknown server (valid: exa, dash0)")
  })
  test("handles empty inventory", () => {
    expect(unknownMsg([], "nope")).toBe("- nope: unknown server (valid: none configured)")
  })
})
