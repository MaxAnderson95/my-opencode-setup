export default {
  id: "local.session-rename",
  async setup(ctx) {
    await ctx.tool.transform((draft) => {
      draft.add({
        name: "rename_session",
        description: "Rename the current session. Pass only the new title; the current session is selected automatically. Follow the session naming instructions and preserve manually chosen titles unless the task has changed.",
        input: {
          type: "object",
          properties: {
            title: {
              type: "string",
              minLength: 1,
              description: "The new session title.",
            },
          },
          required: ["title"],
          additionalProperties: false,
        },
        options: { codemode: false },
        async execute(input, tool) {
          const title = input.title.trim()
          if (!title) throw new Error("A non-empty session title is required.")
          if (!tool.sessionID) throw new Error("A current session is required.")
          await ctx.session.rename({ sessionID: tool.sessionID, title })
          return { content: JSON.stringify({ title }) }
        },
      })
    })
  },
}
