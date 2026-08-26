import { Agent, Model, Plugin } from "@opencode-ai/plugin"
import { Error as ToolError } from "@opencode-ai/plugin/promise/tool"

import {
  advertiseModelParameter,
  derivedAgentID,
  isRecord,
  resolveModel,
  singleFlight,
} from "./lib/selector.ts"

const TOOL = "subagent"
const MODEL_ERROR = "__subagentModelError"
const INVALID_AGENT = "__invalid-subagent-model"

interface DerivedAgent {
  readonly id: string
  readonly baseAgent: string
  readonly model: Model.Ref
  readonly label: string
}

export default Plugin.define({
  id: "subagent-model",
  setup: async (ctx) => {
    const derived = new Map<string, DerivedAgent>()
    const readiness = new Map<string, Promise<void>>()

    await ctx.agent.transform((draft) => {
      for (const entry of derived.values()) {
        const base = draft.get(entry.baseAgent)
        if (!base || base.mode === "primary") continue
        const copy = structuredClone(base)
        draft.update(entry.id, (agent) => {
          Object.assign(agent, copy)
          agent.id = Agent.ID.make(entry.id)
          agent.name = Agent.Name.make(`${base.name} (${entry.label})`)
          agent.model = entry.model
          agent.mode = "subagent"
          agent.hidden = true
        })
      }
    })

    await ctx.session.hook("context", (event) => {
      const tool = event.tools[TOOL]
      if (tool) advertiseModelParameter(tool)
    })

    await ctx.tool.hook("execute.before", async (event) => {
      if (event.tool !== TOOL || !isRecord(event.input)) return
      const requestedModel = event.input.model
      if (typeof requestedModel !== "string") return

      const input = event.input
      const baseAgent = input.agent
      if (typeof baseAgent !== "string") return

      const withoutModel = { ...input }
      delete withoutModel.model

      let base
      try {
        base = (await ctx.agent.get({ agentID: baseAgent })).data
      } catch {
        event.input = withoutModel
        return
      }
      if (base.mode === "primary") {
        event.input = withoutModel
        return
      }

      const selection = resolveModel(requestedModel, (await ctx.catalog.model.list()).data)
      if (!selection.ok) {
        event.input = { ...withoutModel, agent: INVALID_AGENT, [MODEL_ERROR]: selection.error }
        return
      }

      const id = await derivedAgentID(baseAgent, selection.label)
      if (!derived.has(id)) {
        derived.set(id, { id, baseAgent, model: Model.Ref.parse(selection.label), label: selection.label })
      }
      await singleFlight(readiness, id, () => ctx.agent.reload())
      event.input = { ...withoutModel, agent: id }
    })

    await ctx.tool.hook("execute.after", (event) => {
      if (event.tool !== TOOL || event.status !== "error" || !isRecord(event.input)) return
      const message = event.input[MODEL_ERROR]
      if (typeof message === "string") event.error = new ToolError({ message })
    })
  },
})
