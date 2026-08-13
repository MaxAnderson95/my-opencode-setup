/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode-ai/plugin/tui"

export default Plugin.define({
  id: "session-id-badge",
  setup(context) {
    if (context.options.enabled === false) return

    const release = context.ui.slot({
      append: "sidebar.content",
      render: (input) => (
        <box>
          <text fg={context.theme.text.default}>
            <b>Session</b>
          </text>
          <text fg={context.theme.text.subdued}>{input.sessionID}</text>
        </box>
      ),
    })

    return release
  },
})
