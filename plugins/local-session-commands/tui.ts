// @ts-nocheck
import { isAbsolute, resolve } from "node:path"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

const id = "local-session-commands"

function firstLine(input: string) {
  const index = input.indexOf("\n")
  return index === -1 ? input : input.slice(0, index)
}

function commandArguments(input: string, command: string) {
  const line = firstLine(input)
  if (!line.startsWith(`/${command}`)) return

  const rest = line.slice(command.length + 1)
  if (rest !== "" && !rest.startsWith(" ")) return

  return rest.trimStart()
}

function openTarget(input: string, directory: string) {
  const arg = input.trim().replace(/^@/, "")
  if (arg === "") return directory
  return isAbsolute(arg) ? arg : resolve(directory, arg)
}

async function runOpen(target: string) {
  const proc = Bun.spawn(["open", target], {
    stdout: "ignore",
    stderr: "pipe",
  })

  const code = await proc.exited
  if (code === 0) return

  const stderr = await new Response(proc.stderr).text()
  throw new Error(stderr.trim() || `open exited with ${code}`)
}

function clearFocusedPrompt(api) {
  const editor = api.renderer.currentFocusedEditor
  editor?.clear?.()
  api.keymap.dispatchCommand("prompt.clear")
}

function currentSessionID(api) {
  const route = api.route.current
  if (route?.name !== "session") return
  return route.params?.sessionID
}

const tui: TuiPlugin = async (api, options) => {
  if (options && options.enabled === false) return

  const toastError = (error: unknown, fallback: string) => {
    api.ui.toast({
      message: error instanceof Error ? error.message : fallback,
      variant: "error",
    })
  }

  const open = async (raw = "") => {
    const target = openTarget(raw, api.state.path.directory || api.state.path.worktree)
    await runOpen(target)
    api.ui.toast({
      message: raw.trim() ? `Opened ${target}` : "Opened current directory",
      variant: "success",
    })
  }

  const remove = async () => {
    const sessionID = currentSessionID(api)
    if (!sessionID) {
      api.ui.toast({ message: "No active session to delete", variant: "warning" })
      return
    }

    const result = await api.client.session.delete({ sessionID })
    if (result.error) throw new Error(result.error.message ?? "Failed to delete session")
  }

  api.keymap.registerLayer({
    commands: [
      {
        namespace: "palette",
        name: "local.open",
        title: "Open file or folder",
        desc: "Open a path or the current directory with macOS open",
        category: "Session",
        slashName: "open",
        run: () => void open().catch((error) => toastError(error, "Failed to open path")),
      },
      {
        namespace: "palette",
        name: "local.delete-session",
        title: "Delete session",
        desc: "Delete the current session",
        category: "Session",
        slashName: "delete",
        run: () => void remove().catch((error) => toastError(error, "Failed to delete session")),
      },
    ],
  })

  const dispose = api.keymap.intercept(
    "key",
    (ctx) => {
      if (ctx.event.name !== "return" && ctx.event.name !== "enter") return
      if (ctx.event.shift || ctx.event.ctrl || ctx.event.alt || ctx.event.meta || ctx.event.super) return

      const editor = api.renderer.currentFocusedEditor
      if (!editor || typeof editor.plainText !== "string") return

      const openArgs = commandArguments(editor.plainText, "open")
      if (openArgs !== undefined) {
        ctx.consume({ preventDefault: true, stopPropagation: true })
        clearFocusedPrompt(api)
        void open(openArgs).catch((error) => toastError(error, "Failed to open path"))
        return
      }

      const deleteArgs = commandArguments(editor.plainText, "delete")
      if (deleteArgs !== undefined && deleteArgs.trim() === "") {
        ctx.consume({ preventDefault: true, stopPropagation: true })
        clearFocusedPrompt(api)
        void remove().catch((error) => toastError(error, "Failed to delete session"))
      }
    },
    { priority: 10 },
  )

  api.lifecycle.onDispose(dispose)
}

export default {
  id,
  tui,
} satisfies TuiPluginModule & { id: string }
