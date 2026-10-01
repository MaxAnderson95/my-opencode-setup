/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { createSignal, Show } from "solid-js"
import { type Health, Judge } from "./rpc"

export default Plugin.define({
  id: "max.permission-judge",
  setup(context) {
    const judge = context.client.rpc(Judge)
    // Each location runs its own server instance; Jev counts as unavailable while any of them says so.
    const [outages, setOutages] = createSignal<ReadonlyMap<string, string>>(new Map())

    const update = (directory: string, health: Health) => {
      const before = outages().size
      const next = new Map(outages())
      if (health.available) next.delete(directory)
      else next.set(directory, health.reason)
      setOutages(next)
      if (before === 0 && next.size > 0)
        context.ui.toast.show({
          title: "Permission judge",
          message: `Jev is unavailable, so permission prompts are not being reviewed and need your answer. ${health.available ? "" : health.reason}`,
          variant: "warning",
          duration: 10_000,
        })
      if (before > 0 && next.size === 0)
        context.ui.toast.show({ title: "Permission judge", message: "Jev is reviewing permission prompts again.", variant: "success" })
    }

    const stop = judge.events.on("health", (event) => update(event.location.directory, event.data))
    const check = (directory: string) =>
      judge
        .health({}, { location: { directory } })
        .then((health) => update(directory, health))
        .catch(() => {})
    check((context.location ?? context.data.location.default()).directory)
    // Events are live-only and a restarted server starts healthy without announcing it, so
    // re-check while a warning is showing.
    const timer = setInterval(() => {
      for (const directory of outages().keys()) void check(directory)
    }, 30_000)

    const release = context.ui.slot({
      append: "prompt.footer.status",
      render: () => (
        <Show when={outages().size > 0}>
          <text fg={context.theme.text.feedback.warning.base}>Jev unavailable: prompts need you</text>
        </Show>
      ),
    })

    return () => {
      clearInterval(timer)
      stop()
      release()
    }
  },
})
