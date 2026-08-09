// @ts-nocheck
/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal } from "solid-js"

const id = "cache-stats"

type CacheStats = {
  input: number
  read: number
  write: number
}

function rate(input: number, read: number, write: number): number {
  const prompt = input + read + write
  return prompt > 0 ? Math.round((read / prompt) * 100) : 0
}

const tui: TuiPlugin = async (api, options) => {
  if (options && options.enabled === false) return

  const [sessions, setSessions] = createSignal<Record<string, CacheStats>>({})
  const seen = new Set<string>()

  const record = (sid: string, messageID: string, usage: any) => {
    if (!sid || !messageID || !usage || seen.has(messageID)) return
    seen.add(messageID)

    const input = Math.max(0, usage.input ?? 0)
    const read = Math.max(0, usage.cache?.read ?? 0)
    const write = Math.max(0, usage.cache?.write ?? 0)

    setSessions((current) => {
      const previous = current[sid] ?? { input: 0, read: 0, write: 0 }
      return {
        ...current,
        [sid]: {
          input: previous.input + input,
          read: previous.read + read,
          write: previous.write + write,
        },
      }
    })
  }

  const offStep = api.event.on("session.next.step.ended", (event) => {
    const properties = event.properties
    record(properties?.sessionID, properties?.assistantMessageID, properties?.tokens)
  })
  api.lifecycle.onDispose(offStep)

  const offMessage = api.event.on("message.updated", (event) => {
    const info = event.properties?.info
    if (info?.role !== "assistant" || !info.time?.completed) return
    record(info.sessionID, info.id, info.tokens)
  })
  api.lifecycle.onDispose(offMessage)

  api.slots.register({
    slots: {
      sidebar_content(ctx, props) {
        const stats = createMemo(() => sessions()[props.session_id] ?? { input: 0, read: 0, write: 0 })
        return (
          <box>
            <text fg={ctx.theme.current.text}>
              <b>Prompt cache</b>
            </text>
            <text fg={ctx.theme.current.textMuted}>
              Hit rate: {rate(stats().input, stats().read, stats().write)}%
            </text>
          </box>
        )
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
