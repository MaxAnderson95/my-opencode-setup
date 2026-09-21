import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

export const statuses = ["pending", "in_progress", "completed", "cancelled"] as const
export const priorities = ["high", "medium", "low"] as const

export type TodoStatus = (typeof statuses)[number]
export type TodoPriority = (typeof priorities)[number]

export type Todo = {
  content: string
  status: TodoStatus
  priority: TodoPriority
}

export type TodoState = {
  todos: Todo[]
  updatedAt: number
}

const sessionIDPattern = /^ses_[A-Za-z0-9]+$/

export function defaultTodoDir() {
  return join(process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? ".", ".local", "share"), "opencode", "todo")
}

export function parseTodos(input: unknown): Todo[] {
  if (!isRecord(input) || !Array.isArray(input.todos)) {
    throw new Error("todowrite requires { todos: [...] }.")
  }

  return input.todos.map((item, index) => parseTodo(item, index))
}

export function renderTodos(todos: readonly Todo[]): string {
  if (todos.length === 0) return "Todo list cleared."

  const open = todos.filter((todo) => todo.status === "pending" || todo.status === "in_progress").length
  const lines = todos.map((todo) => `- [${mark(todo.status)}] ${todo.priority}: ${todo.content}`)
  return [`${open} open`, ...lines].join("\n")
}

export function createStore(root: string) {
  return {
    async read(sessionID: string): Promise<TodoState | undefined> {
      try {
        const parsed = JSON.parse(await readFile(statePath(root, sessionID), "utf8")) as Partial<TodoState>
        if (!Array.isArray(parsed.todos)) return
        return { todos: parsed.todos.flatMap((item) => quietTodo(item)), updatedAt: parsed.updatedAt ?? 0 }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return
        throw error
      }
    },

    async write(sessionID: string, todos: readonly Todo[]): Promise<void> {
      const path = statePath(root, sessionID)
      if (todos.length === 0) {
        await rm(path, { force: true })
        return
      }

      await mkdir(root, { recursive: true })
      const temporary = `${path}.${process.pid}.tmp`
      const state: TodoState = { todos: [...todos], updatedAt: Date.now() }
      await writeFile(temporary, JSON.stringify(state), "utf8")
      await rename(temporary, path)
    },
  }
}

function parseTodo(item: unknown, index: number): Todo {
  if (!isRecord(item)) throw new Error(`todos[${index}] must be an object.`)

  const content = typeof item.content === "string" ? item.content.trim() : ""
  if (!content) throw new Error(`todos[${index}].content must be a non-empty string.`)

  if (!isStatus(item.status)) {
    throw new Error(`todos[${index}].status must be one of: ${statuses.join(", ")}.`)
  }
  if (!isPriority(item.priority)) {
    throw new Error(`todos[${index}].priority must be one of: ${priorities.join(", ")}.`)
  }

  return { content, status: item.status, priority: item.priority }
}

function quietTodo(item: unknown): Todo[] {
  try {
    return [parseTodo(item, 0)]
  } catch {
    return []
  }
}

function mark(status: TodoStatus) {
  switch (status) {
    case "pending":
      return " "
    case "in_progress":
      return ">"
    case "completed":
      return "x"
    case "cancelled":
      return "-"
  }
}

function statePath(root: string, sessionID: string) {
  if (!sessionIDPattern.test(sessionID)) throw new Error("Invalid session id.")
  return join(root, `${sessionID}.json`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStatus(value: unknown): value is TodoStatus {
  return typeof value === "string" && statuses.includes(value as TodoStatus)
}

function isPriority(value: unknown): value is TodoPriority {
  return typeof value === "string" && priorities.includes(value as TodoPriority)
}
