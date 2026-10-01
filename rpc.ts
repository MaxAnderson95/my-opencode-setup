import { Rpc } from "@opencode/plugin/rpc"
import type { StandardSchemaV1 } from "@standard-schema/spec"

/** Whether the decision model is answering. While unavailable, every `ask` goes to the human. */
export type Health = { readonly available: true } | { readonly available: false; readonly reason: string; readonly since: number }

function schema<T extends object>(name: string, check: (value: unknown) => value is T): StandardSchemaV1<T, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "permission-judge",
      validate: (value) => (check(value) ? { value } : { issues: [{ message: `Invalid ${name}` }] }),
    },
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null
const isHealth = (value: unknown): value is Health =>
  isRecord(value) &&
  (value.available === true ||
    (value.available === false && typeof value.reason === "string" && typeof value.since === "number"))

const health = schema("health", isHealth)

export const Judge = Rpc.define({
  id: "max.permission-judge",
  methods: {
    health: { input: schema("input", (value): value is Record<string, never> => isRecord(value)), output: health },
  },
  events: { health: { schema: health } },
})
