import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { parseEnv } from "node:util"

// TypeSafe's System One API and OpenRouter's Decisions API share one request and answer shape.
export const providers = {
  typesafe: { url: "https://api.typesafe.ai/v1/systemone", keyVariable: "TYPESAFE_API_KEY", model: "jev-latest" },
  openrouter: {
    url: "https://openrouter.ai/api/alpha/decisions",
    keyVariable: "OPENROUTER_API_KEY",
    model: "~typesafe/jev-latest",
  },
} as const

export type Provider = keyof typeof providers

export type NoulQuestion = {
  readonly type: "noul"
  readonly instructions: string
  readonly criteria?: { readonly true: string; readonly false: string }
}
export type ScoreQuestion = { readonly type: "score"; readonly instructions: string; readonly criteria: readonly string[] }
export type Question = NoulQuestion | ScoreQuestion

export type NoulAnswer = { readonly type: "noul"; readonly noul: number }
/** `probabilities[i]` is the probability of `criteria[i]`. */
export type ScoreAnswer = {
  readonly type: "score"
  readonly score: number
  readonly probabilities: readonly number[]
  readonly confidence: number
}
export type Answers<Questions extends Record<string, Question>> = {
  readonly [Key in keyof Questions]: Questions[Key] extends NoulQuestion ? NoulAnswer : ScoreAnswer
}

export type Decide = <Questions extends Record<string, Question>>(
  state: unknown,
  questions: Questions,
) => Promise<Answers<Questions>>

export class DecisionError extends Error {}

export function decisionClient(options: {
  readonly provider: Provider
  readonly model: string
  readonly apiKey: string
  readonly timeoutMs: number
  readonly fetch?: typeof fetch
}): Decide {
  const { url } = providers[options.provider]
  const send = options.fetch ?? fetch
  return async (state, questions) => {
    const response = await send(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: options.model, state, questions }),
      signal: AbortSignal.timeout(options.timeoutMs),
    })
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300)
      throw new DecisionError(`${options.provider} returned HTTP ${response.status}: ${detail}`)
    }
    const body: unknown = await response.json()
    const raw = isRecord(body) && isRecord(body.answers) ? body.answers : undefined
    if (!raw) throw new DecisionError(`${options.provider} response has no answers`)
    const answers: Record<string, NoulAnswer | ScoreAnswer> = {}
    for (const [key, question] of Object.entries(questions)) {
      answers[key] = question.type === "noul" ? noul(key, raw[key]) : score(key, raw[key], question.criteria.length)
    }
    return answers as Answers<typeof questions>
  }
}

function noul(key: string, value: unknown): NoulAnswer {
  if (!isRecord(value) || value.type !== "noul" || !isProbability(value.noul))
    throw new DecisionError(`Invalid noul answer for ${key}`)
  return { type: "noul", noul: value.noul }
}

function score(key: string, value: unknown, levels: number): ScoreAnswer {
  if (!isRecord(value) || value.type !== "score" || !isRecord(value.probabilities))
    throw new DecisionError(`Invalid score answer for ${key}`)
  const { probabilities } = value
  const ordered = Array.from({ length: levels }, (_, level) => probabilities[String(level)])
  if (!ordered.every(isProbability) || typeof value.score !== "number" || !isProbability(value.confidence))
    throw new DecisionError(`Invalid score answer for ${key}`)
  return { type: "score", score: value.score, probabilities: ordered, confidence: value.confidence }
}

const isProbability = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Reads the key from the server environment, falling back to `~/.env_private`. */
export async function readApiKey(variable: string, home = homedir()) {
  const fromEnv = process.env[variable]
  if (fromEnv) return fromEnv
  const file = await readFile(join(home, ".env_private"), "utf8").catch(() => "")
  const key = parseEnv(file)[variable]
  if (!key) throw new DecisionError(`Set ${variable} in the server environment or ~/.env_private`)
  return key
}
