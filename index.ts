import { Plugin } from "@opencode-ai/plugin"
import { Ultra } from "./rpc.js"

const guidance = [
  "Ultra mode is enabled for this session: proactively delegate independent tasks when doing so can save time or improve quality.",
  "Give each worker a narrowly scoped task and clear ownership. Continue useful, non-overlapping work while workers run, coordinate shared changes, and verify their results before reporting completion.",
  "Avoid unnecessary delegation, duplicate work, and recursive agent spawning. Follow all applicable instructions, user requests, and tool permissions; this mode does not override them.",
].join("\n")

export default Plugin.define({
  id: "ultra",
  async setup(ctx) {
    const pending = new Map<string, Promise<void>>()
    const enabled = async (sessionID: string) => (await ctx.storage.get(`session:${sessionID}`)) === true
    const rpc = await ctx.rpc.register(Ultra, {
      status: async (input) => {
        const { sessionID } = input as Parameters<typeof ctx.session.get>[0]
        await ctx.session.get({ sessionID })
        await pending.get(sessionID)
        return { enabled: await enabled(sessionID) }
      },
    })

    await ctx.command.transform((editor) => {
      editor.add({
        name: "ultra",
        description: "Toggle proactive delegation for this session (on, off, status)",
        execute: async ({ sessionID, prompt }) => {
          const action = prompt.text.trim().toLowerCase()
          if (!["", "on", "off", "status"].includes(action)) {
            throw new Error("Usage: /ultra [on|off|status]")
          }
          // Serialize rapid toggles so two presses return to the original state.
          const task = (pending.get(sessionID) ?? Promise.resolve()).then(async () => {
            const current = await enabled(sessionID)
            const next = action === "" ? !current : action === "status" ? current : action === "on"
            if (action !== "status") await ctx.storage.set(`session:${sessionID}`, next)
            await rpc.events.emit("status", { sessionID, enabled: next })
          })
          const settled = task.catch(() => {})
          pending.set(sessionID, settled)
          try {
            await task
          } finally {
            if (pending.get(sessionID) === settled) pending.delete(sessionID)
          }
        },
      })
    })

    await ctx.session.hook("context", async (event) => {
      // Auxiliary generation/compaction should not receive instructions to delegate.
      if (Object.keys(event.tools).length === 0) return
      await pending.get(event.sessionID)
      if (await enabled(event.sessionID)) event.system.push({ type: "text", text: guidance })
    })
  },
})
