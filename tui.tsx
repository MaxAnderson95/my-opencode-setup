/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode-ai/plugin/tui"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { backgroundShellID, backgroundSubagentSessionID } from "./lib/jobs"

type BackgroundJob = {
  id: string
  tool: string
  title: string
  started: number
  sessionID?: string
}

function text(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function duration(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export default Plugin.define({
  id: "background-jobs",
  setup(context) {
    const release = context.ui.slot({
      append: "sidebar.content",
      render: (input) => {
        const [now, setNow] = createSignal(Date.now())
        void context.data.shell.sync(context.location)
        const jobs = createMemo(() => {
          const messages = context.data.session.message.list(input.sessionID)
          const tools = messages.flatMap((message) => {
            if (message.type !== "assistant") return []
            return message.content.filter((item) => item.type === "tool")
          })
          const shellIDs = new Set(
            tools
              .map((item) => backgroundShellID(item.state))
              .filter((shellID): shellID is string => shellID !== undefined),
          )
          const shells = context.data.shell
            .list(context.location)
            .filter((shell) => shell.status === "running" && shellIDs.has(shell.id))
            .map(
              (shell): BackgroundJob => ({
                id: shell.id,
                tool: "shell",
                title: shell.command,
                started: shell.time.started,
              }),
            )
          const subagents = tools
              .filter((item) => {
                if (item.state.status === "streaming") return false
                const child = backgroundSubagentSessionID(item.state) ?? text(item.state.metadata?.sessionId)
                return child !== undefined && context.data.session.status(child) === "running"
              })
              .map((item): BackgroundJob => {
                const state = item.state
                if (state.status === "streaming") throw new Error("unreachable")
                const sessionID = backgroundSubagentSessionID(state) ?? text(state.metadata?.sessionId)
                return {
                  id: item.id,
                  tool: item.name,
                  title:
                    text(state.metadata?.title) ??
                    text(state.input.description) ??
                    text(state.input.command) ??
                    text(state.input.prompt) ??
                    item.name,
                  started: item.time.ran ?? item.time.created,
                  sessionID,
                }
              })
          return [...shells, ...subagents]
        })

        createEffect(() => {
          if (jobs().length === 0) return
          setNow(Date.now())
          const timer = setInterval(() => setNow(Date.now()), 1000)
          onCleanup(() => clearInterval(timer))
        })

        return (
          <Show when={jobs().length > 0}>
            <box flexDirection="column" gap={1}>
              <text fg={context.theme.text.default}>
                <b>Background ({jobs().length})</b>
              </text>
              <For each={jobs()}>
                {(job) => (
                  <box
                    flexDirection="column"
                    paddingLeft={1}
                    onMouseUp={
                      job.sessionID
                        ? () => context.ui.router.navigate({ type: "session", sessionID: job.sessionID! })
                        : undefined
                    }
                  >
                    <text fg={context.theme.text.default} wrapMode="word">
                      <span style={{ fg: context.theme.text.feedback.info.default }}>●</span> {job.title}
                    </text>
                    <text fg={context.theme.text.subdued}>
                      {job.tool} · {duration(now() - job.started)}
                    </text>
                  </box>
                )}
              </For>
            </box>
          </Show>
        )
      },
    })

    return release
  },
})
