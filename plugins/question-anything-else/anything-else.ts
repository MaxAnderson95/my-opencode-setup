import { Plugin } from "@opencode/plugin"

export const anythingElse = {
  header: "Anything else?",
  question: "Anything else? (Optional: general thoughts to consider along with the answers above)",
  options: [],
}

type QuestionInput = { questions: readonly { question?: unknown }[] }

const isQuestionInput = (input: unknown): input is QuestionInput =>
  typeof input === "object" && input !== null && "questions" in input && Array.isArray(input.questions)

export function withAnythingElse(input: unknown): unknown {
  if (!isQuestionInput(input)) return input
  if (input.questions.some((question) => question.question === anythingElse.question)) return input
  return { ...input, questions: [...input.questions, anythingElse] }
}

export default Plugin.define({
  id: "question-anything-else",
  setup: async (ctx) => {
    await ctx.tool.hook("execute.before", (event) => {
      if (event.tool === "question") event.input = withAnythingElse(event.input)
    })
  },
})
