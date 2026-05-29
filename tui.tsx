// @ts-nocheck
/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

const id = "session-id-badge"

const tui: TuiPlugin = async (api, options) => {
  if (options && options.enabled === false) return

  api.slots.register({
    slots: {
      sidebar_content(ctx, props) {
        return (
          <box>
            <text fg={ctx.theme.current.text}>
              <b>Session</b>
            </text>
            <text fg={ctx.theme.current.textMuted}>{props.session_id}</text>
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
