import { Rpc } from "@opencode-ai/plugin/rpc"

export const Ultra = Rpc.define({
  id: "ultra",
  methods: {
    status: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { enabled: { type: "boolean" } },
        required: ["enabled"],
        additionalProperties: false,
      },
    },
  },
  events: {
    status: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          enabled: { type: "boolean" },
        },
        required: ["sessionID", "enabled"],
        additionalProperties: false,
      },
    },
  },
})
