// @ts-nocheck
/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, Show } from "solid-js"
import { readCallout, type CalloutState } from "./state"

const id = "callout"

function link(content: string): { href: string; label: string } | undefined {
  try {
    const url = new URL(content)
    if (url.protocol !== "http:" && url.protocol !== "https:") return

    const githubPR = url.hostname === "github.com" && url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/)
    if (githubPR) return { href: url.href, label: `${githubPR[1]}/${githubPR[2]} #${githubPR[3]}` }

    return { href: url.href, label: url.hostname }
  } catch {
    return
  }
}

const tui: TuiPlugin = async (api) => {
  const [values, setValues] = createSignal<Record<string, CalloutState | undefined>>({})
  const sessions = new Set<string>()

  const refresh = async () => {
    for (const sessionID of sessions) {
      const value = await readCallout(sessionID)
      setValues((current) => ({ ...current, [sessionID]: value }))
    }
  }

  const timer = setInterval(() => void refresh(), 500)
  api.lifecycle.onDispose(() => clearInterval(timer))

  api.slots.register({
    order: 75,
    slots: {
      sidebar_content(ctx, props) {
        sessions.add(props.session_id)
        void refresh()
        const value = createMemo(() => values()[props.session_id])
        const target = createMemo(() => link(value()?.content ?? ""))

        return (
          <Show when={value()}>
            <box
              border={["left"]}
              borderColor={ctx.theme.current.warning}
              paddingLeft={1}
              flexDirection="column"
            >
              <text fg={ctx.theme.current.warning}>
                <b>Callout</b>
              </text>
              <Show when={target()} fallback={<text fg={ctx.theme.current.text}>{value()!.content}</text>}>
                <text fg={ctx.theme.current.text}>
                  <a href={target()!.href}>{target()!.label}</a>
                </text>
              </Show>
            </box>
          </Show>
        )
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = { id, tui }

export default plugin
