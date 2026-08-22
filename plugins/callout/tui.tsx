/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js"
import { readCallout, type CalloutState } from "./state"

type Segment = {
  text: string
  bold?: boolean
  italic?: boolean
  code?: boolean
}

// Deliberately narrow inline markdown: bold, italic, and code spans, no
// nesting. Underscores are not delimiters so identifiers, paths, and branch
// names survive unstyled.
const inline = /\*\*(\S(?:[^*]*\S)?)\*\*|\*(\S(?:[^*]*\S)?)\*|`([^`]+)`/g

function segments(content: string): Segment[] {
  const result: Segment[] = []
  let index = 0

  for (const match of content.matchAll(inline)) {
    if (match.index > index) result.push({ text: content.slice(index, match.index) })

    const [matched, bold, italic, code] = match
    if (bold) result.push({ text: bold, bold: true })
    else if (italic) result.push({ text: italic, italic: true })
    else if (code) result.push({ text: code, code: true })

    index = match.index + matched.length
  }

  if (index < content.length) result.push({ text: content.slice(index) })
  return result
}

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

export default Plugin.define({
  id: "callout",
  setup(context) {
    // The server half of this plugin writes per-session state files; the TUI
    // runs in a separate process, so it polls those files rather than sharing
    // memory. Only sessions whose sidebar actually rendered are polled.
    const [values, setValues] = createSignal<Record<string, CalloutState | undefined>>({})
    const sessions = new Set<string>()

    const refresh = async () => {
      for (const sessionID of sessions) {
        const value = await readCallout(sessionID)
        setValues((current) => ({ ...current, [sessionID]: value }))
      }
    }

    const timer = setInterval(() => void refresh(), 500)

    const release = context.ui.slot({
      append: "sidebar.content",
      render: (input) => {
        sessions.add(input.sessionID)
        void refresh()
        const warning = context.theme.text.feedback.warning.default
        const value = createMemo(() => values()[input.sessionID])
        const lines = createMemo(() =>
          (value()?.content ?? "")
            .split("\n")
            .map((content) => ({ content, target: link(content.trim()), segments: segments(content) })),
        )

        return (
          <Show when={value()}>
            <box border={["left"]} borderColor={warning} paddingLeft={1} flexDirection="column">
              <text fg={warning}>
                <b>Callout</b>
              </text>
              <For each={lines()}>
                {(line) => (
                  <Show
                    when={line.target}
                    fallback={
                      <text fg={context.theme.text.default}>
                        <Show when={line.content} fallback=" ">
                          <For each={line.segments}>
                            {(segment) => (
                              <Switch fallback={segment.text}>
                                <Match when={segment.bold}>
                                  <b>{segment.text}</b>
                                </Match>
                                <Match when={segment.italic}>
                                  <i>{segment.text}</i>
                                </Match>
                                <Match when={segment.code}>
                                  <span style={{ fg: context.theme.markdown.code }}>{segment.text}</span>
                                </Match>
                              </Switch>
                            )}
                          </For>
                        </Show>
                      </text>
                    }
                  >
                    <text fg={context.theme.text.default}>
                      <a href={line.target!.href}>{line.target!.label}</a>
                    </text>
                  </Show>
                )}
              </For>
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
