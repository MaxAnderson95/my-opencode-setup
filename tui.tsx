/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode-ai/plugin/tui"
import { For, Show, createMemo, createSignal, onMount } from "solid-js"

export default Plugin.define({
  id: "active-provider-account",
  setup(context) {
    if (context.options.enabled === false) return

    const location = context.location ?? context.data.location.default()
    const [revision, setRevision] = createSignal(0)
    const sync = async () => {
      context.data.location.integration.invalidate(location)
      await context.data.location.integration.sync(location)
      setRevision((value) => value + 1)
    }

    const stop = context.data.listen(({ details }) => {
      if (details.type === "integration.connection.updated") void sync()
    })

    const release = context.ui.slot({
      prepend: "sidebar.content",
      render: () => {
        onMount(() => void sync())

        const accounts = createMemo(() => {
          revision()
          return (context.data.location.integration.list(location) ?? []).flatMap((integration) => {
            const credentials = integration.connections.filter((connection) => connection.type === "credential")
            if (credentials.length < 2) return []
            const active = credentials[0]
            return active ? [`${integration.name} · ${active.label}`] : []
          })
        })

        return (
          <Show when={accounts().length > 0}>
            <box flexDirection="column">
              <text fg={context.theme.text.default}>
                <b>Accounts</b>
              </text>
              <For each={accounts()}>
                {(account) => <text fg={context.theme.text.subdued}>{account}</text>}
              </For>
            </box>
          </Show>
        )
      },
    })

    return () => {
      stop()
      release()
    }
  },
})
