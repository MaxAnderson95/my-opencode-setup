/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode-ai/plugin/tui"

export default Plugin.define({
  id: "session-id-badge",
  setup(context) {
    if (context.options.enabled === false) return

    // `prepend` — not `append` — because sidebar.content orders its claims by
    // plugin enable order, and the host seeds the Context and MCP builtins
    // before any discovered plugin. Appending therefore lands below MCP; the
    // v1 API's numeric `order` that used to place this mid-sidebar is gone.
    const release = context.ui.slot({
      prepend: "sidebar.content",
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
