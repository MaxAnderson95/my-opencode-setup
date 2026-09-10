import type { Reading } from "./guard.ts"

/**
 * One guarded provider. `providerID` matches OpenCode's model ref; `name` and
 * `term` feed the question copy ("Anthropic extra usage", "OpenAI credits").
 */
export interface Adapter {
  providerID: string
  name: string
  term: string
  read(response: Response): Reading
}

const number = (headers: Headers, name: string) => {
  const raw = headers.get(name)
  if (raw === null) return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

/**
 * Anthropic states overage explicitly: `anthropic-ratelimit-unified-overage-in-use`
 * is "true" on requests billed to extra usage. `anthropic-ratelimit-unified-status`
 * of allowed/allowed_warning also confirms subscription usage on responses that
 * omit the overage header. `anthropic-ratelimit-unified-overage-status` only says
 * whether extra usage is available, not whether it was used.
 */
export const anthropic: Adapter = {
  providerID: "anthropic",
  name: "Anthropic",
  term: "extra usage",
  read(response) {
    const headers = response.headers
    const overage = headers.get("anthropic-ratelimit-unified-overage-in-use")
    const status = headers.get("anthropic-ratelimit-unified-status")
    const reset = number(headers, "anthropic-ratelimit-unified-reset")
    const using =
      overage === "true"
        ? true
        : response.ok && (overage === "false" || status === "allowed" || status === "allowed_warning")
          ? false
          : undefined
    return { using, reset: reset === undefined ? undefined : reset * 1000 }
  },
}

/**
 * The ChatGPT Codex backend never states that a request was billed to credits.
 * It reports each rolling window's consumption (`x-codex-<window>-used-percent`,
 * `x-codex-<window>-reset-at` in epoch seconds) and whether the account holds
 * credits (`x-codex-credits-has-credits`, Python-style "True"/"False"). A 200 with
 * a window at or past 100% and credits available can only have been paid from
 * credits, which is what this adapter reports as overage. Without credits an
 * exhausted window returns 429, which OpenCode surfaces on its own.
 */
export const openai: Adapter = {
  providerID: "openai",
  name: "OpenAI",
  term: "credits",
  read(response) {
    const headers = response.headers
    const windows = ["primary", "secondary"].flatMap((window) => {
      const used = number(headers, `x-codex-${window}-used-percent`)
      return used === undefined ? [] : [{ used, reset: number(headers, `x-codex-${window}-reset-at`) }]
    })
    if (!response.ok || windows.length === 0) return {}
    const exhausted = windows.filter((window) => window.used >= 100)
    const credits = /^true$/i.test(headers.get("x-codex-credits-has-credits") ?? "")
    const resets = exhausted.flatMap((window) => (window.reset === undefined ? [] : [window.reset * 1000]))
    return {
      using: exhausted.length > 0 && credits,
      reset: resets.length ? Math.max(...resets) : undefined,
    }
  },
}

export const adapters: readonly Adapter[] = [anthropic, openai]
