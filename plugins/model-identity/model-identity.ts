import { Plugin } from "@opencode-ai/plugin"

// Stamps the resolved model slug and reasoning variant onto every user
// message so the model always knows what it is:
//
//   <model-slug>provider/model</model-slug>
//   <model-effort>high</model-effort>
//
// v2 has no persisted synthetic parts in the context pipeline, so the tags
// are appended at dispatch time via the session context hook. Stamping EVERY
// user message (not just the newest) is what keeps the prompt prefix
// byte-identical across dispatches: a tag that appeared only on the last
// message would vanish from it on the next turn and bust the prompt cache.
export default Plugin.define({
  id: "model-identity",
  setup: async (ctx) => {
    await ctx.session.hook("context", (input) => {
      const slug = `${input.model.providerID}/${input.model.id}`
      const tag = `<model-slug>${slug}</model-slug>\n<model-effort>${input.model.variant ?? "default"}</model-effort>`
      for (let index = 0; index < input.messages.length; index++) {
        const message = input.messages[index]
        if (message.role !== "user") continue
        // Skip messages that already carry a tag (e.g. persisted synthetic
        // parts written by the v1 plugin in pre-v2 sessions).
        if (message.content.some((part) => part.type === "text" && part.text.startsWith("<model-slug>"))) continue
        input.messages[index] = {
          ...message,
          content: [...message.content, { type: "text", text: tag }],
        }
      }
    })
  },
})
