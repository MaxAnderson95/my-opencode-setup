import { describe, expect, test } from "bun:test"

import { advertiseModelParameter, derivedAgentID, resolveModel, singleFlight } from "./selector.ts"

const models = [
  {
    id: "claude-opus-5",
    providerID: "anthropic",
    variants: [{ id: "low" }, { id: "high" }],
  },
  {
    id: "gpt-5.6-sol",
    providerID: "openai",
    variants: [],
  },
]

describe("resolveModel", () => {
  test("resolves a catalog model and variant", () => {
    expect(resolveModel("anthropic/claude-opus-5#low", models)).toEqual({
      ok: true,
      ref: { providerID: "anthropic", id: "claude-opus-5", variant: "low" },
      label: "anthropic/claude-opus-5#low",
    })
  })

  test("rejects unavailable models and variants", () => {
    expect(resolveModel("anthropic/missing", models)).toEqual({
      ok: false,
      error: 'Provider "anthropic" has no available model "missing".',
    })
    expect(resolveModel("openai/gpt-5.6-sol#high", models)).toEqual({
      ok: false,
      error: 'Model "openai/gpt-5.6-sol" exposes no variants. Omit "#high".',
    })
  })
})

test("derived agent IDs are stable and scoped by base agent", async () => {
  const first = await derivedAgentID("general", "openai/gpt-5.6-sol#low")
  expect(await derivedAgentID("general", "openai/gpt-5.6-sol#low")).toBe(first)
  expect(await derivedAgentID("explore", "openai/gpt-5.6-sol#low")).not.toBe(first)
  expect(first).toMatch(/^general--model-[a-f0-9]{16}$/)
})

test("concurrent callers wait for one initialization", async () => {
  const readiness = new Map<string, Promise<void>>()
  let initializeCount = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const initialize = async () => {
    initializeCount++
    await gate
  }

  let firstFinished = false
  let secondFinished = false
  const first = singleFlight(readiness, "agent", initialize).then(() => {
    firstFinished = true
  })
  const second = singleFlight(readiness, "agent", initialize).then(() => {
    secondFinished = true
  })

  await Promise.resolve()
  expect(initializeCount).toBe(1)
  expect(firstFinished).toBeFalse()
  expect(secondFinished).toBeFalse()

  release()
  await Promise.all([first, second])
  expect(firstFinished).toBeTrue()
  expect(secondFinished).toBeTrue()

  await singleFlight(readiness, "agent", initialize)
  expect(initializeCount).toBe(1)
})

test("failed initialization can be retried", async () => {
  const readiness = new Map<string, Promise<void>>()
  let attempts = 0
  const initialize = async () => {
    attempts++
    if (attempts === 1) throw new Error("reload failed")
  }

  await expect(singleFlight(readiness, "agent", initialize)).rejects.toThrow("reload failed")
  await singleFlight(readiness, "agent", initialize)
  expect(attempts).toBe(2)
})

test("advertises an optional model parameter", () => {
  const tool = {
    description: "Spawn a subagent.",
    input: { type: "object", properties: { agent: { type: "string" } }, required: ["agent"] },
  }

  expect(advertiseModelParameter(tool)).toBeTrue()
  expect(tool.input.properties).toHaveProperty("model")
  expect(tool.input.required).toEqual(["agent"])
  expect(tool.description).toContain("provider/model#variant")
})
