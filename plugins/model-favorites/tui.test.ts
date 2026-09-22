import { describe, expect, test } from "bun:test"
import { listRows, neighborFavorite } from "./tui"

const model = (
  providerID: string,
  id: string,
  name: string,
  released: number,
  status: "active" | "deprecated" = "active",
) => ({
  providerID,
  id,
  name,
  status,
  time: { released },
})

const models = [
  model("openai", "sol", "GPT Sol", 2),
  model("openai", "astra", "GPT Astra", 3),
  model("anthropic", "opus", "Claude Opus", 1),
  model("anthropic", "old", "Claude Old", 0, "deprecated"),
  model("xai", "grok", "Grok", 1),
]
const providers = [
  { id: "openai", name: "OpenAI" },
  { id: "anthropic", name: "Anthropic" },
  { id: "xai", name: "xAI" },
]

describe("listRows", () => {
  test("lists favorites in saved order, then other models by provider and newest first", () => {
    const rows = listRows({
      models,
      providers,
      favorites: [
        { providerID: "xai", modelID: "grok" },
        { providerID: "gone", modelID: "missing" },
        { providerID: "openai", modelID: "sol" },
      ],
      query: "",
    })

    expect(rows.map((row) => [row.category, row.key])).toEqual([
      ["Favorites", "xai/grok"],
      ["Favorites", "openai/sol"],
      ["Anthropic", "anthropic/opus"],
      ["OpenAI", "openai/astra"],
    ])
  })

  test("moves the cursor to the favorite below a removed one, else the one above", () => {
    const rows = listRows({
      models,
      providers,
      favorites: [
        { providerID: "xai", modelID: "grok" },
        { providerID: "openai", modelID: "sol" },
      ],
      query: "",
    })

    expect(neighborFavorite(rows, 0)?.key).toBe("openai/sol")
    expect(neighborFavorite(rows, 1)?.key).toBe("xai/grok")
    expect(neighborFavorite(rows.slice(1), 0)).toBeUndefined()
  })

  test("filters by every search term across title, provider, and ID", () => {
    const rows = listRows({ models, providers, favorites: [{ providerID: "openai", modelID: "sol" }], query: "open astra" })
    expect(rows.map((row) => row.key)).toEqual(["openai/astra"])
  })
})
