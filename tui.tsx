/** @jsxImportSource @opentui/solid */
import type { ModelInfo, ProviderInfo } from "@opencode/client"
import { Plugin } from "@opencode/plugin/tui"
import { RGBA, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { batch, createMemo, createSignal, For, Show } from "solid-js"
import {
  createFavoriteFile,
  modelKey,
  moveFavorite,
  toggleFavorite,
  type FavoriteFile,
  type ModelRef,
} from "./favorites"

export type Row = {
  key: string
  model: ModelRef
  title: string
  provider: string
  category: string
  favorite: boolean
}

type Entry = { type: "space" } | { type: "header"; label: string } | { type: "row"; row: Row }

type Model = Pick<ModelInfo, "id" | "providerID" | "name" | "status" | "time">

const transparent = RGBA.fromInts(0, 0, 0, 0)

/** Favorites in saved order, then every other non-deprecated model grouped by provider, filtered by `query`. */
export function listRows(input: {
  models: readonly Model[]
  providers: readonly Pick<ProviderInfo, "id" | "name">[]
  favorites: readonly ModelRef[]
  query: string
}): Row[] {
  const providerNames = new Map(input.providers.map((provider) => [provider.id, provider.name]))
  const keyOf = (model: Model) => modelKey({ providerID: model.providerID, modelID: model.id })
  const toRow = (model: Model, favorite: boolean): Row => {
    const provider = providerNames.get(model.providerID) ?? model.providerID
    return {
      key: keyOf(model),
      model: { providerID: model.providerID, modelID: model.id },
      title: model.name,
      provider,
      category: favorite ? "Favorites" : provider,
      favorite,
    }
  }

  const models = new Map(input.models.map((model) => [keyOf(model), model]))
  const favoriteKeys = new Set(input.favorites.map(modelKey))
  const favorites = input.favorites.flatMap((item) => {
    const model = models.get(modelKey(item))
    return model ? [toRow(model, true)] : []
  })
  const others = input.models
    .filter((model) => model.status !== "deprecated" && !favoriteKeys.has(keyOf(model)))
    .map((model) => ({ row: toRow(model, false), released: model.time.released }))
    .toSorted(
      (a, b) =>
        a.row.provider.localeCompare(b.row.provider) ||
        b.released - a.released ||
        a.row.title.localeCompare(b.row.title),
    )
    .map((item) => item.row)

  const terms = input.query.toLowerCase().split(/\s+/).filter(Boolean)
  return [...favorites, ...others].filter((row) => {
    const text = `${row.title} ${row.provider} ${row.key}`.toLowerCase()
    return terms.every((term) => text.includes(term))
  })
}

function FavoritesDialog(props: { context: Plugin.Context; file: FavoriteFile }) {
  const context = props.context
  const location = context.location ?? context.data.location.default()
  const dimensions = useTerminalDimensions()
  const theme = createMemo(() => context.theme.surface("dialog"))
  const [favorites, setFavorites] = createSignal<ModelRef[]>([])
  const [query, setQuery] = createSignal("")
  const [selected, setSelected] = createSignal<string>()

  const fail = (error: unknown) =>
    context.ui.toast.show({
      title: "Favorite models",
      message: error instanceof Error ? error.message : String(error),
      variant: "error",
    })

  props.file.read().then(setFavorites, fail)
  if (!context.data.location.model.list(location)) context.data.location.model.sync(location).catch(fail)
  if (!context.data.location.provider.list(location)) context.data.location.provider.sync(location).catch(fail)

  const rows = createMemo(() =>
    listRows({
      models: context.data.location.model.list(location) ?? [],
      providers: context.data.location.provider.list(location) ?? [],
      favorites: favorites(),
      query: query(),
    }),
  )
  const index = createMemo(() => Math.max(0, rows().findIndex((row) => row.key === selected())))
  const current = () => rows()[index()]

  const entries = createMemo(() =>
    rows().flatMap((row, position): Entry[] => {
      const previous = rows()[position - 1]
      if (previous?.category === row.category) return [{ type: "row", row }]
      const header: Entry[] = [{ type: "header", label: row.category }, { type: "row", row }]
      return previous ? [{ type: "space" }, ...header] : header
    }),
  )
  const height = createMemo(() => Math.max(5, Math.min(entries().length, Math.floor(dimensions().height / 2) - 6)))
  const offset = createMemo((previous: number) => {
    const list = entries()
    const target = list.findIndex((entry) => entry.type === "row" && entry.row.key === current()?.key)
    let top = target
    while (top > 0 && list[top - 1].type !== "row") top--
    let start = Math.min(previous, Math.max(0, list.length - height()))
    if (top < start) start = top
    if (target >= start + height()) start = target - height() + 1
    return Math.max(0, start)
  }, 0)
  const visible = createMemo(() => entries().slice(offset(), offset() + height()))

  function move(delta: number) {
    const list = rows()
    if (!list.length) return
    setSelected(list[(index() + delta + list.length) % list.length].key)
  }

  function persist(change: (list: ModelRef[]) => ModelRef[]) {
    setFavorites(change)
    props.file.update(change).catch(async (error) => {
      fail(error)
      setFavorites(await props.file.read().catch(() => favorites()))
    })
  }

  function reorder(direction: -1 | 1) {
    const row = current()
    if (!row?.favorite) return
    const shown = new Set(rows().flatMap((item) => (item.favorite ? [item.key] : [])))
    persist((list) => moveFavorite(list, row.key, direction, shown))
  }

  function toggle() {
    const row = current()
    if (!row) return
    setSelected(row.key)
    persist((list) => toggleFavorite(list, row.model))
  }

  context.keymap.layer(() => ({
    mode: "modal",
    commands: [
      { bind: "up,ctrl+p", title: "Previous model", group: "Favorites", run: () => move(-1) },
      { bind: "down,ctrl+n", title: "Next model", group: "Favorites", run: () => move(1) },
      { bind: "shift+up", title: "Move favorite up", group: "Favorites", run: () => reorder(-1) },
      { bind: "shift+down", title: "Move favorite down", group: "Favorites", run: () => reorder(1) },
      { bind: "ctrl+f", title: "Toggle favorite", group: "Favorites", run: toggle },
      { bind: "return", title: "Open model picker", group: "Favorites", run: () => context.keymap.dispatch("model.list") },
    ],
  }))

  const Hint = (hint: { title: string; keys: string }) => (
    <text>
      <span style={{ fg: theme().text.base }}>
        <b>{hint.title}</b>{" "}
      </span>
      <span style={{ fg: theme().text.muted }}>{hint.keys}</span>
    </text>
  )

  return (
    <box gap={1} paddingBottom={1}>
      <box paddingLeft={4} paddingRight={4}>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme().text.base} attributes={TextAttributes.BOLD}>
            Favorite models
          </text>
          <text fg={theme().text.muted} onMouseUp={() => context.ui.dialog.clear()}>
            esc
          </text>
        </box>
        <box paddingTop={1}>
          <input
            placeholder="Search"
            placeholderColor={theme().text.muted}
            focusedBackgroundColor={theme().background.formfield.focused}
            focusedTextColor={theme().text.formfield.focused}
            cursorColor={theme().text.formfield.focused}
            onInput={(value) =>
              batch(() => {
                setQuery(value)
                setSelected(undefined)
              })
            }
            ref={(input) => setTimeout(() => !input.isDestroyed && input.focus(), 1)}
          />
        </box>
      </box>
      <box paddingLeft={1} paddingRight={1}>
        <Show
          when={rows().length > 0}
          fallback={
            <box paddingLeft={3}>
              <text fg={theme().text.muted}>No models found</text>
            </box>
          }
        >
          <For each={visible()}>
            {(entry) => {
              if (entry.type === "space") return <box height={1} />
              if (entry.type === "header")
                return (
                  <box paddingLeft={3}>
                    <text fg={theme().hue.accent[200]} attributes={TextAttributes.BOLD}>
                      {entry.label}
                    </text>
                  </box>
                )
              const active = () => entry.row.key === current()?.key
              const color = () => (active() ? theme().text.action.primary.focused : theme().text.base)
              return (
                <box
                  paddingLeft={3}
                  paddingRight={3}
                  backgroundColor={active() ? theme().background.action.primary.focused : transparent}
                >
                  <text fg={color()} attributes={active() ? TextAttributes.BOLD : undefined} wrapMode="none" overflow="hidden">
                    {entry.row.title}
                    <span style={{ fg: active() ? color() : theme().text.muted }}>{" " + entry.row.provider}</span>
                  </text>
                </box>
              )
            }}
          </For>
        </Show>
      </box>
      <box paddingLeft={4} paddingRight={2} flexDirection="row" gap={2}>
        <Hint title="Favorite" keys="ctrl+f" />
        <Hint title="Move" keys="shift+↑↓" />
        <Hint title="Model picker" keys="enter" />
      </box>
    </box>
  )
}

function Commands(props: { context: Plugin.Context; file: FavoriteFile }) {
  const context = props.context
  const open = () => context.ui.dialog.show(() => <FavoritesDialog context={context} file={props.file} />)
  // The built-in picker registers model.dialog.favorite only while it is open.
  const pickerOpen = () => context.keymap.commands().some((command) => command.id === "model.dialog.favorite")

  context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "model.favorites",
        title: "Manage favorite models",
        group: "Agent",
        palette: true,
        slash: { name: "favorites" },
        run: open,
      },
    ],
  }))

  context.keymap.layer(() => ({
    mode: "modal",
    commands: [
      {
        bind: "ctrl+g",
        title: "Manage favorite models",
        group: "Dialog",
        run: () => (pickerOpen() ? open() : false),
      },
    ],
  }))

  return null
}

export default Plugin.define({
  id: "model-favorites",
  setup(context) {
    const file = createFavoriteFile()
    return context.ui.slot({ append: "app", render: () => <Commands context={context} file={file} /> })
  },
})
