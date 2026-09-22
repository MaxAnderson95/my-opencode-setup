/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { createMemo, createSignal, For, Show } from "solid-js"
import { createStore, defaultTodoDir, type Todo, type TodoState } from "./state"

function mark(status: Todo["status"]) {
  if (status === "completed") return "✓"
  if (status === "in_progress") return "•"
  if (status === "cancelled") return "-"
  return " "
}

export default Plugin.define({
  id: "todo",
  setup(context) {
    const store = createStore(defaultTodoDir())
    const [values, setValues] = createSignal<Record<string, TodoState | undefined>>({})
    const sessions = new Set<string>()

    const refresh = async () => {
      for (const sessionID of sessions) {
        const value = await store.read(sessionID)
        setValues((current) => {
          const previous = current[sessionID]
          if (previous?.updatedAt === value?.updatedAt) return current
          return { ...current, [sessionID]: value }
        })
      }
    }

    const timer = setInterval(() => void refresh(), 500)

    // append lands after the host Context and MCP sections. The old sidebar
    // todo sat at order 400, after those and before files. v2 has no numeric slot order.
    const release = context.ui.slot({
      append: "sidebar.content",
      render: (input) => {
        sessions.add(input.sessionID)
        const [open, setOpen] = createSignal(true)
        const todos = createMemo(() => values()[input.sessionID]?.todos ?? [])
        const visible = createMemo(() => todos().some((todo) => todo.status !== "completed"))

        return (
          <Show when={visible()}>
            <box>
              <box flexDirection="row" gap={1} onMouseDown={() => todos().length > 2 && setOpen((value) => !value)}>
                <Show when={todos().length > 2}>
                  <text fg={context.theme.text.base}>{open() ? "▼" : "▶"}</text>
                </Show>
                <text fg={context.theme.text.base}>
                  <b>Todo</b>
                </text>
              </box>
              <Show when={todos().length <= 2 || open()}>
                <For each={todos()}>
                  {(todo) => {
                    const color =
                      todo.status === "in_progress"
                        ? context.theme.text.feedback.warning.base
                        : context.theme.text.muted
                    return (
                      <text fg={color} wrapMode="word">
                        [{mark(todo.status)}] {todo.content}
                      </text>
                    )
                  }}
                </For>
              </Show>
            </box>
          </Show>
        )
      },
    })

    return () => {
      clearInterval(timer)
      release()
    }
  },
})
