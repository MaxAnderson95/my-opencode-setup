import { Plugin } from "@opencode/plugin"
import type { PermissionEvaluation } from "@opencode/plugin/promise/permission"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { appendFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { type Decide, decisionClient, type Provider, providers, readApiKey } from "./decisions"
import {
  collectEvidence,
  createBreaker,
  defaultThresholds,
  denialMessage,
  judge,
  latestUserMessageID,
  type Thresholds,
  type Verdict,
} from "./judge"

type Config = {
  readonly provider: Provider
  readonly model: string
  readonly timeoutMs: number
  readonly thresholds: Thresholds
  readonly skip: readonly string[]
  readonly defaultAuto: boolean
  readonly breaker: { readonly consecutive: number; readonly total: number }
  readonly logFile: string | false
}

export function parseOptions(options: Readonly<Record<string, unknown>>): Config {
  const provider = options.provider ?? "typesafe"
  if (provider !== "typesafe" && provider !== "openrouter")
    throw new Error(`permission-judge: provider must be "typesafe" or "openrouter", got ${JSON.stringify(provider)}`)
  return {
    provider,
    model: string(options.model, "model") ?? providers[provider].model,
    timeoutMs: number(options.timeoutMs, "timeoutMs") ?? 4_000,
    thresholds: numbers(defaultThresholds, options.thresholds, "thresholds", (value) => value >= 0 && value <= 1),
    skip: stringArray(options.skip, "skip") ?? ["question"],
    defaultAuto: boolean(options.defaultAuto, "defaultAuto") ?? false,
    breaker: numbers({ consecutive: 3, total: 20 }, options.breaker, "breaker", Number.isInteger),
    logFile:
      options.logFile === false
        ? false
        : (string(options.logFile, "logFile") ?? join(homedir(), ".local", "state", "opencode", "permission-judge.jsonl")),
  }
}

export default Plugin.define({
  id: "max.permission-judge",
  async setup(ctx) {
    const config = parseOptions(ctx.options)
    let client: Promise<Decide> | undefined
    const decide = () =>
      (client ??= readApiKey(providers[config.provider].keyVariable).then((apiKey) =>
        decisionClient({ provider: config.provider, model: config.model, apiKey, timeoutMs: config.timeoutMs }),
      ).catch((error) => {
        client = undefined
        throw error
      }))
    const breaker = createBreaker(config.breaker)
    const roots = new Map<string, string>()
    // Only "ask" verdicts are re-evaluated (core re-runs the hook for pending requests after an "always" reply).
    const verdicts = new BoundedMap<string, Verdict>(200)
    // Tool call ID -> denial text, consumed by execute.after so the model sees why it was blocked.
    const denials = new BoundedMap<string, string>(200)

    const log = async (entry: Record<string, unknown>) => {
      if (!config.logFile) return
      const line = `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`
      await mkdir(dirname(config.logFile), { recursive: true })
        .then(() => appendFile(config.logFile as string, line, { mode: 0o600 }))
        .catch(() => {})
    }

    const rootOf = async (sessionID: string): Promise<string> => {
      const known = roots.get(sessionID)
      if (known) return known
      const session = await ctx.session.get({ sessionID })
      const root = session.parentID ? await rootOf(session.parentID) : sessionID
      roots.set(sessionID, root)
      return root
    }
    const autoKey = (rootID: string) => `auto/${rootID}`
    const isAuto = async (rootID: string) => {
      const stored = await ctx.storage.get(autoKey(rootID))
      return typeof stored === "boolean" ? stored : config.defaultAuto
    }

    await ctx.permission.hook("evaluate", async (event) => {
      if (event.effect !== "ask") return
      const base = { sessionID: event.sessionID, action: event.action, resources: event.resources }
      try {
        const rootID = await rootOf(event.sessionID)
        if (await isAuto(rootID)) {
          event.effect = "allow"
          await log({ ...base, rule: "auto", effect: "allow" })
          return
        }
        if (config.skip.includes(event.action)) return
        const key = JSON.stringify([event.sessionID, event.source?.id, event.action, event.resources])
        const cached = verdicts.get(key)
        if (cached) return apply(event, cached)

        const started = performance.now()
        const [messages, rootMessages] = await Promise.all([
          ctx.session.context({ sessionID: event.sessionID }),
          rootID === event.sessionID ? undefined : ctx.session.context({ sessionID: rootID }),
        ])
        const evidence = collectEvidence({
          action: event.action,
          resources: event.resources,
          source: event.source,
          messages,
          rootMessages,
          directory: ctx.location.project.directory,
          home: homedir(),
        })
        const { answers, verdict: judged } = await judge(evidence, await decide(), config.thresholds)
        const verdict = breaker(rootID, latestUserMessageID(rootMessages ?? messages), judged)
        if (verdict.effect === "ask") verdicts.set(key, verdict)
        apply(event, verdict)
        await log({
          ...base,
          rule: verdict.rule,
          effect: verdict.effect,
          input: evidence.request.input,
          risk: answers.risk.probabilities,
          authorized: answers.authorized.noul,
          forbidden: answers.forbidden.noul,
          model: config.model,
          ms: Math.round(performance.now() - started),
        })
      } catch (error) {
        await log({ ...base, rule: "error", effect: "ask", error: String(error) })
      }
    })

    function apply(event: PermissionEvaluation, verdict: Verdict) {
      if (verdict.effect === "ask") return
      event.effect = verdict.effect
      if (verdict.effect !== "deny") return
      event.message = denialMessage(verdict.reason)
      if (event.source) denials.set(event.source.id, event.message)
    }

    await ctx.tool.hook("execute.after", (event) => {
      const message = denials.get(event.id)
      if (message === undefined) return
      denials.delete(event.id)
      if (event.status === "error") event.error = new ToolError({ message })
    })

    await ctx.command.transform((editor) =>
      editor.add({
        name: "auto",
        description: "permission judge: toggle auto mode for this session (on, off, or no argument to toggle)",
        async execute({ sessionID, prompt }) {
          const rootID = await rootOf(sessionID)
          const argument = prompt.text.trim().toLowerCase()
          const next = argument === "on" ? true : argument === "off" ? false : !(await isAuto(rootID))
          await ctx.storage.set(autoKey(rootID), next)
          await log({ sessionID, rule: "auto-toggle", auto: next })
          await ctx.session.synthetic({
            sessionID,
            resume: false,
            text: next
              ? "Permission judge: auto mode is on for this session. Every permission prompt is approved without review."
              : "Permission judge: auto mode is off for this session. Jev reviews permission prompts.",
          })
        },
      }),
    )
  },
})

class BoundedMap<K, V> extends Map<K, V> {
  constructor(private readonly limit: number) {
    super()
  }
  override set(key: K, value: V) {
    super.delete(key)
    super.set(key, value)
    if (this.size > this.limit) this.delete(this.keys().next().value as K)
    return this
  }
}

function numbers<T extends Record<string, number>>(
  defaults: T,
  value: unknown,
  name: string,
  valid: (value: number) => boolean,
): T {
  if (value === undefined) return defaults
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`permission-judge: ${name} must be an object`)
  const merged: Record<string, number> = { ...defaults }
  for (const [key, item] of Object.entries(value)) {
    if (!(key in defaults)) throw new Error(`permission-judge: unknown option ${name}.${key}`)
    if (typeof item !== "number" || !valid(item)) throw new Error(`permission-judge: invalid ${name}.${key}`)
    merged[key] = item
  }
  return merged as T
}
function string(value: unknown, name: string) {
  if (value === undefined) return undefined
  if (typeof value !== "string" || !value) throw new Error(`permission-judge: ${name} must be a non-empty string`)
  return value
}
function number(value: unknown, name: string) {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !(value > 0)) throw new Error(`permission-judge: ${name} must be a positive number`)
  return value
}
function boolean(value: unknown, name: string) {
  if (value === undefined) return undefined
  if (typeof value !== "boolean") throw new Error(`permission-judge: ${name} must be a boolean`)
  return value
}
function stringArray(value: unknown, name: string) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    throw new Error(`permission-judge: ${name} must be an array of strings`)
  return value as string[]
}
