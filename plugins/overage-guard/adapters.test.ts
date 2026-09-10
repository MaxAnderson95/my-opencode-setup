import { describe, expect, it } from "bun:test"
import { anthropic, openai } from "./lib/adapters.ts"

const response = (headers: Record<string, string>, status = 200) => new Response("", { status, headers })

describe("anthropic adapter", () => {
  it("reports overage from the explicit in-use header", () => {
    expect(
      anthropic.read(
        response({
          "anthropic-ratelimit-unified-overage-in-use": "true",
          "anthropic-ratelimit-unified-status": "rejected",
          "anthropic-ratelimit-unified-reset": "2000",
        }),
      ),
    ).toEqual({ using: true, reset: 2_000_000 })
  })

  it("confirms subscription usage from in-use false or an allowed status", () => {
    expect(anthropic.read(response({ "anthropic-ratelimit-unified-overage-in-use": "false" }))).toEqual({
      using: false,
      reset: undefined,
    })
    expect(anthropic.read(response({ "anthropic-ratelimit-unified-status": "allowed_warning" })).using).toBe(false)
  })

  it("does not mistake overage availability or an error response for a signal", () => {
    expect(anthropic.read(response({ "anthropic-ratelimit-unified-overage-status": "allowed" })).using).toBeUndefined()
    expect(anthropic.read(response({ "anthropic-ratelimit-unified-status": "allowed" }, 429)).using).toBeUndefined()
  })
})

describe("openai codex adapter", () => {
  const base = {
    "x-codex-credits-has-credits": "True",
    "x-codex-credits-unlimited": "False",
    "x-codex-primary-used-percent": "93",
    "x-codex-primary-reset-at": "1789438901",
    "x-codex-secondary-used-percent": "0",
    "x-codex-secondary-reset-after-seconds": "0",
  }

  it("confirms subscription usage while every window is under 100%", () => {
    expect(openai.read(response(base))).toEqual({ using: false, reset: undefined })
  })

  it("reports overage when an exhausted window is served with credits", () => {
    expect(
      openai.read(
        response({
          ...base,
          "x-codex-primary-used-percent": "100",
          "x-codex-secondary-used-percent": "100.0",
          "x-codex-secondary-reset-at": "1789470073",
        }),
      ),
    ).toEqual({ using: true, reset: 1_789_470_073_000 })
  })

  it("does not report overage without credits or on a rejected request", () => {
    expect(
      openai.read(
        response({ ...base, "x-codex-primary-used-percent": "100", "x-codex-credits-has-credits": "False" }),
      ).using,
    ).toBe(false)
    expect(openai.read(response({ ...base, "x-codex-primary-used-percent": "100" }, 429))).toEqual({})
  })

  it("has no signal when the header family is absent", () => {
    expect(openai.read(response({ "x-codex-credits-has-credits": "True" }))).toEqual({})
  })
})
