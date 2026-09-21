import { Plugin } from "@opencode/plugin"
import { createStore, defaultTodoDir, parseTodos, renderTodos } from "./state"

const description = `Create and maintain a structured task list for the current coding session. Tracks progress, organizes multi-step work, and surfaces status to the user.

Each call replaces the session's full list. Send every item, including ones already completed.

## When to use
Use proactively when:
- The task requires 3+ distinct steps or actions (not just 3 tool calls for a single conceptual step)
- The work is non-trivial and benefits from planning
- The user provides multiple tasks (numbered or comma-separated) or explicitly asks for a todo list
- New instructions arrive - capture them as todos
- You start a task - mark it in_progress (only one at a time) before working
- You finish a task - mark it completed and add any follow-ups discovered during the work

## When NOT to use
Skip when:
- The work is a single, straightforward task (or <3 trivial steps)
- The request is purely informational or conversational
- Tracking adds no organizational value

## States
- pending - not started
- in_progress - actively working (exactly ONE at a time)
- completed - finished successfully
- cancelled - no longer needed

## Priority
high, medium, or low.

## Rules
- Update status in real time; don't batch completions
- Mark completed only after the required work is actually done, including any required verification. Never based on intent.
- Keep exactly one in_progress while work remains
- If blocked or partial, keep it in_progress and add a follow-up todo describing the blocker
- Preserve user-provided commands verbatim (flags, args, order)
- Items should be specific and actionable; break large work into smaller steps
- Send an empty todos array to clear the list

When in doubt, use it.`

export async function applyTodos(
  store: ReturnType<typeof createStore>,
  sessionID: string,
  input: unknown,
): Promise<{ content: string }> {
  const todos = parseTodos(input)
  await store.write(sessionID, todos)
  return { content: renderTodos(todos) }
}

export function createTodoPlugin(root = defaultTodoDir()) {
  const store = createStore(root)

  return Plugin.define({
    id: "todo",
    setup: async (ctx) => {
      await ctx.tool.transform((tools) => {
        tools.add({
          name: "todowrite",
          description,
          input: {
            type: "object",
            properties: {
              todos: {
                type: "array",
                description: "The updated todo list. Replaces the previous list for this session.",
                items: {
                  type: "object",
                  properties: {
                    content: { type: "string", description: "Brief description of the task" },
                    status: {
                      type: "string",
                      enum: ["pending", "in_progress", "completed", "cancelled"],
                      description: "Current status of the task: pending, in_progress, completed, cancelled",
                    },
                    priority: {
                      type: "string",
                      enum: ["high", "medium", "low"],
                      description: "Priority level of the task: high, medium, low",
                    },
                  },
                  required: ["content", "status", "priority"],
                  additionalProperties: false,
                },
              },
            },
            required: ["todos"],
            additionalProperties: false,
          },
          options: { codemode: false },
          execute: (input, context) => applyTodos(store, context.sessionID, input),
        })
      })
    },
  })
}

export default createTodoPlugin()
