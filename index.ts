import { Plugin } from "@opencode/plugin";

export default Plugin.define({
  id: "session-id-badge",
  async setup(ctx) {
    await ctx.session.hook("context", (event) => {
      event.system.push({
        type: "text",
        text: `Current OpenCode session ID: ${event.sessionID}`,
      });
    });
  },
});
