Verified against OpenCode v2.0.20 (@opencode/plugin 2.0.20).

# Extend the terminal UI

Use `@opencode/plugin/tui` for terminal-local commands, JSX, notifications, and state. Use the [server half](server.md) for model/session policy or server-local resources; connect the halves with [RPC](rpc.md). The recipes below typecheck against the pinned SDK; they have not been exercised in a live TUI.

## Define and export the TUI half

Default-export `Plugin.define({ id, setup })`. The contract is `setup(context: Plugin.Context): Promise<Cleanup | void> | Cleanup | void`, where `Cleanup = () => Promise<void> | void`. TUI definitions have no `effect` entrypoint. `define` returns the object; the loader checks its nonempty ID and setup function.

Minimal plugin and toast recipe:

```ts
import { Plugin } from "@opencode/plugin/tui"

export default Plugin.define({
  id: "acme.toast",
  setup(context) {
    context.ui.toast.show({ message: "Ready", variant: "success", duration: 3000 })
  },
})
```

Expose the package subpath `./tui`. This example assumes you have already built `dist/tui.js` with the Solid/OpenTUI transform described below:

```json
{
  "name": "opencode-acme-ui",
  "type": "module",
  "exports": { "./tui": "./dist/tui.js" },
  "dependencies": { "@opencode/plugin": "2.0.20" },
  "peerDependencies": {
    "@opentui/core": ">=0.5.12",
    "@opentui/solid": ">=0.5.12",
    "solid-js": ">=1.9.0"
  }
}
```

For a combined package add a server export beside `./tui`. An unnamed local directory needs a conventional `tui.tsx`/`tui.js` entry; installed named packages resolve `<package>/tui` through exports. See [packaging.md](packaging.md) for resolution, dependencies, file lists, and release checks.

Sources: `packages/plugin/src/tui/plugin.ts`, `packages/plugin/src/tui/index.ts`, `packages/plugin/src/host.ts`, `packages/plugin/package.json`, `packages/tui/src/plugin/context.tsx`.

## Put TUI configuration in cli.json

Configure a TUI-only package in global `~/.config/opencode/cli.json` (under `$XDG_CONFIG_HOME/opencode` when set). There is no project-local `cli.json` discovery. `OPENCODE_CLI_CONFIG_CONTENT` overlays the global file.

```json
{
  "plugins": [
    { "package": "opencode-acme-ui", "options": { "compact": true } }
  ],
  "keybinds": { "acme.status": "ctrl+g" }
}
```

Configure a combined server/TUI package in `opencode.json(c)` under `plugins`; an active server plugin advertising `features.tui` becomes a TUI candidate automatically. Its server options do not reach `context.options`: use the same target's object entry in `cli.json` for TUI options. The explicit CLI declaration wins when discovery/server inventory also contains that target.

`plugins` accepts package/path strings, `{ package, options? }`, known IDs, `*`, `prefix.*`, and negative selectors such as `-opencode.notifications`. Negative selectors affect definitions accumulated so far; order matters. Use your own prefix, not `opencode.`: that prefix has special selector handling. Local TUI discovery enumerates plugin directories/directory symlinks, not loose TSX files. Remote inventory supplies targets, not source files; advertised local paths must exist on the terminal machine. See [packaging.md](packaging.md) for the full loading rules.

Sources: `packages/cli/src/config/config.ts`, `packages/tui/src/config/index.tsx`, `packages/tui/src/plugin/context.tsx`, `packages/tui/src/plugin/discovery.ts`.

## Find the context capability for the task

All top-level fields are readonly. Read changing values inside JSX, a memo, or an effect; `location`, `theme`, and `themeMode` are host getters. Setup-time destructuring captures their current values.

| Task | Context API |
| --- | --- |
| Read plugin settings | `options`: supplied option record, defaults to `{}` |
| Identify the current location/build | `location: LocationRef \| undefined`; `app.version`, `app.channel` |
| Call the connected server | `client: OpenCodeClient`, including `client.rpc(contract)` |
| Observe cached server state/events | `data`: session, project, shell, location collections; `on`, `listen` |
| Render terminal surfaces | `ui.slot`, `ui.router`, `ui.panel`, `ui.dialog`; `renderer: CliRenderer` for OpenTUI-specific helpers |
| Add commands or inspect input state | `keymap.layer`, `dispatch`, `shortcuts`, `commands`, `pending`, `active`, `mode` |
| Display feedback | `ui.toast.show`, `attention.notify` |
| Keep client-local state | `storage.store`, `storage.memory` |
| Style JSX | `theme: ResolvedTheme`; `themeMode: "dark" \| "light"` |
| Render fenced Markdown code | `markdown.registerCodeBlockRenderer(language, render)` |
| Control session tabs/model variant | `ui.tabs`, `ui.model` |
| Format a path for display | `ui.format.path(value: string): string`, including home abbreviation |

Use `usePlugin()` from `@opencode/plugin/tui` inside registered slot, route, and dialog renderers. The host wraps them with `PluginContextProvider`. Outside that provider the hook throws. Do not import private TUI context hooks: their extra capabilities are not the plugin contract.

Source: `packages/plugin/src/tui/context.ts` (the complete public contract), `packages/plugin/src/tui/solid.ts`, `packages/tui/src/plugin/api.tsx` (adapter and ownership).

## Register palette, slash, and keyboard commands

Mount an `app` slot returning `null`, and call `keymap.layer` inside its renderer or a child component. Its signature is `layer(input: () => KeymapLayer): void`. It uses Solid context/cleanup hooks and must not run directly in async plugin setup.

Palette command with default keybind and argument-taking slash completion:

```ts
import { Plugin } from "@opencode/plugin/tui"

export default Plugin.define({
  id: "acme.commands",
  setup(context) {
    context.ui.slot({
      append: "app",
      render() {
        context.keymap.layer(() => ({
          commands: [{
            id: "acme.status",
            title: "Show Acme status",
            group: "Acme",
            bind: "ctrl+g",
            palette: true,
            slash: { name: "acme", arguments: true },
            run: (input) => context.ui.toast.show({ message: input ?? "Ready" }),
          }],
        }))
        return null
      },
    })
  },
})
```

| `KeymapLayer` field | Meaning |
| --- | --- |
| `mode?: string` | Defaults to `"base"`; `"global"` removes the mode restriction. Use `"modal"` inside dialogs. |
| `enabled?: boolean \| (() => boolean)` | Enables the complete layer; panel focus also gates interactivity. |
| `target?: () => Renderable \| null \| undefined` | Restricts input to a focused renderable. |
| `priority?: number` | Resolves conflicts between active layers. |
| `commands?: readonly KeymapCommand[]` | Commands owned by this component. |
| `bindings?: readonly string[]` | Activates configured bindings for command IDs declared elsewhere. |

| `KeymapCommand` field | Meaning |
| --- | --- |
| `id?: string` | Stable command/config ID. Palette/slash commands require one. An inline command omits it and requires `bind`. |
| `title?`, `description?`, `group?` | Discovery/help metadata. |
| `enabled?: boolean \| (() => boolean)` | Gates the command. |
| `bind?: false \| string` | Default binding, or `false` to disable automatic binding for this named command. |
| `palette?: true` | Adds the command to palette discovery. |
| `slash?: { name; aliases?: string[]; arguments?: true }` | Adds slash completion. With arguments, completion leaves text in the prompt and dispatch later supplies raw input. Otherwise completion runs the command. |
| `suggested?: boolean \| (() => boolean)` | Promotes the command in discovery. |
| `run(input?: string, event?: KeyEvent): void \| false \| Promise<void>` | Named keyboard dispatch includes the event; programmatic dispatch can supply input. Returning `false` continues dispatch. Inline bindings currently call `run()` without an event. |

Other keymap operations:

| Method | Result |
| --- | --- |
| `dispatch(id, input?)` | `void`; dispatches a reachable command. |
| `shortcuts(id)` | `readonly string[]`, formatted shortcuts. |
| `commands()` | Reactive reachable `readonly KeymapCommand[]`. |
| `pending()` | Reactive `{ key: string; token?: string }[]` for the pending sequence. |
| `active()` | Reactive `{ key; title?; description?; group?; continues: boolean }[]` for reachable bindings. |
| `mode.current()` | Active mode string. |
| `mode.push(mode)` | Cleanup function to pop the temporary mode; call it on teardown. |

A nonempty CLI binding for an ID overrides its string default. The wrapper falls back to `bind` when configured bindings are empty, so do not promise that a CLI `false`/`"none"` disables an explicit plugin string default. `bind: false` suppresses the command's automatic binding, but a separate `bindings` entry can still activate configured bindings. Choose plugin-prefixed IDs to avoid inheriting native IDs' bindings. Build route-dependent command arrays inside the layer callback so navigation changes their registration. Use `"global"` only when the command should also run during modal input.

Sources: `packages/plugin/src/tui/context.ts`, `packages/tui/src/context/keymap.tsx`, `packages/tui/src/config/keybind.ts`, `packages/tui/src/component/prompt/autocomplete.tsx`.

## Claim a slot

Call `ui.slot(claim): () => void` with exactly one placement and a renderer. `prepend`/`append` place children inside the boundary; `before`/`after` place adjacent siblings; `replace` takes over its contents. The host also unregisters claims on plugin disposal.

All ten public slots:

| Slot | Reactive props | Host placement |
| --- | --- | --- |
| `app` | Empty record | Main app column after the active home/session/plugin route, once plugins are ready. Use for headless controllers or overlays. |
| `home.footer` | Empty record | Bottom of the home screen. |
| `home.footer.status` | Empty record | Built-in home-footer row, after MCP/plugin health and before spacer/version. Exists only when that built-in row mounts. |
| `prompt.footer` | `sessionID?: string`, `mode: "normal" \| "shell"`, `showDetails: boolean` | Entire row below the prompt input, containing status and file slots. |
| `prompt.footer.status` | Same prompt-footer props | Left status/location area, including running/interrupt indicators. |
| `prompt.footer.file` | Same prompt-footer props | Editor context/file label area. |
| `session.composer.top` | `sessionID: string` | Above the composer/permission/form/prompt region, after the queued-prompt dock. |
| `session.panel` | `PanelInput`, below | Host-managed side/fullscreen session panel contents. |
| `sidebar.content` | `sessionID: string` | Scrollable sidebar body beneath the title. |
| `sidebar.footer` | `sessionID: string` | Non-scrolling bottom of the sidebar. |

`PanelInput` has `name: string`, `sessionID: string`, `width: number`, `presentation: "panel" | "fullscreen"`, `focused: boolean`, and `focus()`, `close()`, `toggleFullscreen()` actions. Read props without setup-time destructuring to retain reactivity.

At one target the last-enabled replacement wins; an ancestor replacement suppresses nested content regardless of enable order. Siblings anchored outside the replaced boundary survive. Additive claims on missing slots append to the nearest mounted dot-prefix ancestor, or disappear if none exists; missing replacements disappear. `app` is not the ancestor of `home.footer`. Slot render bodies run once as components; changing props arrive through getters, not by rerunning the body.

### Add a sidebar item

Use a box for the section and keep its text bounded. `prepend` puts this ahead of existing content; there is no numeric item-order API.

```tsx
/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"

export default Plugin.define({
  id: "acme.sidebar",
  setup(context) {
    context.ui.slot({
      prepend: "sidebar.content",
      render: (input) => (
        <box flexShrink={0}>
          <text fg={context.theme.text.base}><b>Acme</b></text>
          <text fg={context.theme.text.muted} wrapMode="word">{input.sessionID}</text>
        </box>
      ),
    })
  },
})
```

### Add a footer/status item

Use `prompt.footer.status` for a compact prompt indicator. The prompt also appears on home; adding the same indicator to `home.footer.status` can show it twice.

```tsx
/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"

export default Plugin.define({
  id: "acme.footer",
  setup(context) {
    context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => (
        <text fg={context.theme.text.muted}>
          {input.sessionID ? context.data.session.status(input.sessionID) : "Ready"}
        </text>
      ),
    })
  },
})
```

The sidebar may be hidden by host layout. Test wide and narrow terminals before treating an invisible contribution as a loading failure. Footer components can unmount during permission prompts or navigation; keep activation-wide state/subscriptions outside their renderers. No public assistant-message footer, arbitrary message/part/tool renderer registry, sidebar descriptor API, or prompt text/attachment mutation API exists in this version.

Sources: `packages/plugin/src/tui/context.ts`, `packages/tui/src/plugin/structure.ts`, `packages/tui/src/plugin/render.tsx`; host placements are listed in the Source map.

## Open dialogs and display feedback

Call `dialog.show` first, then `dialog.set`. Showing replaces the active shared dialog and resets size/centering. `clear` closes that shared dialog, not a plugin-scoped modal.

```tsx
/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"

function StatusDialog() {
  const context = usePlugin()
  context.keymap.layer(() => ({
    mode: "modal",
    commands: [{ bind: "q", run: () => context.ui.dialog.clear() }],
  }))
  return <box padding={1}><text fg={context.theme.text.base}>Ready. Press q to close.</text></box>
}

export default Plugin.define({
  id: "acme.dialog",
  setup(context) {
    context.ui.slot({
      append: "app",
      render() {
        context.keymap.layer(() => ({
          commands: [{
            id: "acme.dialog.open",
            title: "Open Acme dialog",
            palette: true,
            run() {
              context.ui.dialog.show(() => <StatusDialog />)
              context.ui.dialog.set({ size: "large", centered: true })
            },
          }],
        }))
        return null
      },
    })
  },
})
```

| API | Options and result |
| --- | --- |
| `dialog.show(render, onClose?)` | `render: () => JSX.Element`, optional close callback; returns void. |
| `dialog.set(options)` | `size?: "medium" \| "large" \| "xlarge"`, `centered?: boolean`; returns void. |
| `dialog.clear()` | Returns void. |
| `dialog.alert(options)` | `{ title, message }`; `Promise<void>`. |
| `dialog.confirm(options)` | `{ title, message, label?: { confirm?: string; cancel?: string } }`; `Promise<boolean \| undefined>` for confirm/cancel/close. |
| `dialog.prompt(options)` | `{ title, description?, placeholder?, value? }`; `Promise<string \| undefined>`. |
| `dialog.select<Value>(options)` | `{ title, placeholder?, options: readonly DialogSelectOption<Value>[], current?: Value }`; `Promise<Value \| undefined>`. Each option has `title`, `value`, optional `description`, `footer`, `category`, `disabled`. |
| `toast.show(options)` | `{ message, title?, variant?, duration?, sessionID? }`; returns void. Variant is `"info"` (default), `"success"`, `"warning"`, or `"error"`; duration is milliseconds. |

A toast with `sessionID` gets an Open action when that session family is not currently open, and defaults its title to the cached session title. Arbitrary toast action callbacks are not public.

For system notifications/sounds call `attention.notify(options): Promise<AttentionNotifyResult>`. Options: `message`, optional `title`, `notification: boolean | { when?: AttentionWhen }`, `sound: boolean | { name?: AttentionSoundName; volume?: number; when?: AttentionWhen }`. `AttentionWhen` is `"always" | "focused" | "blurred"`. Sounds are `"default"`, `"question"`, `"permission"`, `"error"`, `"done"`, `"subagent_done"`. Volume is clamped to 0..1. Host attention settings still gate delivery. Result has `ok`, `notification`, `sound`, and optional `skipped`: `"attention_disabled"`, `"empty_message"`, `"blurred"`, `"focused"`, `"focus_unknown"`, or `"renderer_destroyed"`.

Sources: `packages/plugin/src/tui/context.ts`, `packages/tui/src/plugin/api.tsx`, `packages/tui/src/ui/dialog.tsx`, `packages/tui/src/attention.ts`.

## Add a screen, panel, or tab action

| Task | Public API and behavior |
| --- | --- |
| Register a screen | `ui.router.register({ name, render }): () => void`; renderer gets `{ data?: Record<string, any> }` in the upstream type. Use concrete payload types/narrowing in your code. Duplicate names within a plugin throw. |
| Navigate | `ui.router.navigate({ type: "home" })`, `{ type: "session", sessionID }`, or `{ type: "plugin", name, data?, id? }`; omitted plugin ID means this plugin. |
| Read route | `ui.router.current(): Route`, reactive host value. Copy `{ ...current() }` when saving a return destination; retaining the mutable proxy does not snapshot it. |
| Open session panel | Register `session.panel`, filter on a unique prefixed `input.name`, then `ui.panel.open(name, { presentation?: "panel" \| "fullscreen" }): boolean`. Returns false outside a session/inactive plugin. Every panel contribution receives the selected name. |
| Close/read owned panel | `ui.panel.close(): void`, `current(): { name; sessionID } \| undefined`; scoped to this plugin. Narrow terminals force fullscreen. Closing disposes content; presentation changes preserve it. Host focus gates panel keymaps. |
| Read tabs | `ui.tabs.enabled(): boolean`, `list(): readonly { sessionID; title?; active; busy; attention; unread?: "activity" \| "error" }[]`, reactive. |
| Change tabs | `open(sessionID)`, `focus(sessionID)`, `move(sessionID, index)`, `close(sessionID?)`: boolean. Disabled tabs return false; open preserves focus, focus opens if needed; move/close require a matching tab. |
| Read selected model | `ui.model.current(): { providerID; modelID; variant?: string } \| undefined`, reactive. |
| Select variant | `ui.model.variant.list(): readonly string[]`, reactive; `set(variant: string \| undefined): boolean`. Undefined selects the default; unavailable model/variant returns false. No general model-selection API. |

Sources: `packages/plugin/src/tui/context.ts`, `packages/tui/src/plugin/api.tsx`, `packages/tui/src/plugin/render.tsx`, `packages/tui/src/component/panel-host.tsx`, `packages/tui/src/context/panel.tsx`.

## Read reactive session and message state

Read `context.data` in a Solid computation or compiled JSX. Reads use the host cache; they do not fetch implicitly. `sync` requests missing/stale data through the cache coordinator; `invalidate` marks it stale. Do not synchronously fetch on every render or create a polling/subscription loop in a remounting footer.

```tsx
/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo } from "solid-js"

export default Plugin.define({
  id: "acme.session",
  setup(context) {
    context.ui.slot({
      append: "sidebar.content",
      render(input) {
        const session = createMemo(() => context.data.session.get(input.sessionID))
        const messages = createMemo(() => context.data.session.message.list(input.sessionID))
        createEffect(() => {
          const sessionID = input.sessionID
          void context.data.session.message.sync(sessionID).catch((error: unknown) => {
            context.ui.toast.show({ message: String(error), variant: "error" })
          })
        })
        return <text fg={context.theme.text.muted}>{session()?.title ?? input.sessionID}: {messages().length} messages</text>
      },
    })
  },
})
```

Here the effect depends on the selected session ID, not message count. For activation-wide work use setup with explicit cleanup, or a stable `app` controller when Solid effects/context are needed.

### Cached data API

`sync` methods return `Promise<void>`; `invalidate` methods return void. `LocationCollection<Value>` means `list(location?: LocationRef): Value[] | undefined`, `sync(location?): Promise<void>`, `invalidate(location?): void`.

| Domain | Reads | Refresh/actions |
| --- | --- | --- |
| `data.session` | `list(): SessionInfo[]`; `get(sessionID): SessionInfo \| undefined`; `root(sessionID): string`; `family(sessionID): string[]`; `cost(sessionID): number`; `status(sessionID): "idle" \| "running"` | `sync(sessionID)`, `invalidate(sessionID)` |
| `session.pending` | `list(sessionID): SessionInboxInfo[]` | `sync(sessionID)`, `invalidate(sessionID)` |
| `session.message` | `list(sessionID): SessionMessageInfo[]`; `get(sessionID, messageID): SessionMessageInfo \| undefined` | `sync(sessionID)`, `invalidate(sessionID)` |
| `session.permission` | `list(sessionID): PermissionRequest[] \| undefined` | `sync(sessionID)`, `invalidate(sessionID)` |
| `session.form` | `list(sessionID, location?): Array<FormInfo & { readonly location?: LocationRef }> \| undefined` | `sync(sessionID, location?)`, `invalidate(sessionID, location?)`, `reply(input: SessionFormReplyInput, location?): Promise<void>`, `cancel(input: SessionFormCancelInput, location?): Promise<void>` |
| `data.project` | `list(): Project[]`; `get(projectID): Project \| undefined` | `sync()`, `invalidate()` |
| `project.permission` | `list(projectID): PermissionSavedInfo[] \| undefined` | `sync(projectID)`, `invalidate(projectID)` |
| `data.shell` | `list(location?): ShellInfo[]`; `get(id): ShellInfo \| undefined` | `sync(location?)`, `invalidate(location?)` |
| `data.location` | `default(): LocationRef` | `sync(location?)`, `invalidate(location?)` |
| `location.vcs` | `info(location?): VcsInfo \| undefined` | `sync(location?)`, `invalidate(location?)` |
| `location.agent` | `LocationCollection<AgentInfo>` | Shared collection methods |
| `location.command` | `LocationCollection<CommandInfo>` | Shared collection methods |
| `location.integration` | `LocationCollection<IntegrationInfo>` | Shared collection methods |
| `location.mcp.server` | `LocationCollection<McpServer>` | Shared collection methods |
| `location.mcp.resource` | `LocationCollection<McpResource>` | Shared collection methods |
| `location.model` | `LocationCollection<ModelInfo>` | Shared collection methods |
| `location.provider` | `LocationCollection<ProviderInfo>` | Shared collection methods |
| `location.reference` | `LocationCollection<ReferenceInfo>` | Shared collection methods |
| `location.skill` | `LocationCollection<SkillInfo>` | Shared collection methods |

Missing session status defaults to idle. Root cost sums cached family costs; child cost is that child's cost. `family` contains known cached IDs, not a fresh server query. Incidental methods on the internal host data object are outside the public contract.

Sources: `packages/plugin/src/tui/context.ts`, `packages/tui/src/context/data.tsx`, `packages/client/src/solid/data.ts`.

## Call the server and handle events

Use the injected `context.client` instead of rediscovering localhost or hardcoding server URLs. Its generated resource methods reach the connected server, including a remote server. Inspect the method's generated types: native methods do not all share the same input fields. For a location-scoped method, use `context.location ?? context.data.location.default()` where that method accepts location. Session methods usually take `sessionID`.

Native events use `data.on(type, handler): () => void` or `data.listen(handler: ({ details: OpenCodeEvent }) => void): () => void`. `on` narrows the event by its discriminant. Payload is `event.data`, not v1 `properties`. Return unsubscribe explicitly:

```ts
import { Plugin } from "@opencode/plugin/tui"

export default Plugin.define({
  id: "acme.events",
  setup(context) {
    return context.data.on("session.execution.failed", (event) => {
      context.ui.toast.show({
        sessionID: event.data.sessionID,
        message: event.data.error.message,
        variant: "error",
      })
    })
  },
})
```

Use `session.execution.started/succeeded/failed/interrupted`, `form.created/replied/cancelled`, and `permission.asked/replied` for current lifecycle notifications. Event handlers can see multiple sessions; select by event/session identity rather than assuming the displayed session is the event's target.

### Call the server half over RPC

There is no `context.rpc` on TUI. Export a portable shared contract, then call `context.client.rpc(contract)`. This contract uses Effect's Standard Schema conversion for typed Promise-client results:

```ts
// rpc-contract.ts
import { Rpc } from "@opencode/plugin/rpc"
import { Schema } from "effect"

export const Acme = Rpc.define({
  id: "acme",
  methods: {
    status: {
      input: Schema.toStandardSchemaV1(Schema.Struct({})),
      output: Schema.toStandardSchemaV1(Schema.Struct({ message: Schema.String })),
    },
  },
  events: {},
})
```

The server half must implement/register that contract at the requested location. TUI call recipe:

```ts
import { Plugin } from "@opencode/plugin/tui"
import { Acme } from "./rpc-contract"

export default Plugin.define({
  id: "acme.rpc-ui",
  setup(context) {
    const acme = context.client.rpc(Acme)
    const controller = new AbortController()
    context.ui.slot({
      append: "app",
      render() {
        context.keymap.layer(() => ({
          commands: [{
            id: "acme.server.status",
            title: "Show server status",
            palette: true,
            async run() {
              try {
                const status = await acme.status({}, {
                  location: context.location ?? context.data.location.default(),
                  signal: controller.signal,
                })
                if (!controller.signal.aborted) context.ui.toast.show({ message: status.message })
              } catch (error) {
                if (!controller.signal.aborted) context.ui.toast.show({ message: String(error), variant: "error" })
              }
            },
          }],
        }))
        return null
      },
    })
    return () => controller.abort()
  },
})
```

RPC returns the decoded output directly, without a `.data` wrapper. Location is the second method argument's option. Typed custom events use `rpcClient.events.on(name, handler): () => void` or `subscribe(name): AsyncIterable<...>`; filter `event.location` when necessary and retain cleanup. Each subscription uses an event stream; keep it off remounting render paths. Events are live-only and may be missed during disconnects. The TUI adapter captures `host.client.api` at activation; automatic rebinding of retained RPC clients after managed reconnect is not verified. See [rpc.md](rpc.md) for server registration, events, schema choices, and errors.

Sources: `packages/tui/src/plugin/api.tsx`, `packages/tui/src/feature-plugins/system/notifications.ts`, `packages/client/src/promise/rpc.ts`, `packages/plugin/src/rpc.ts`, `packages/schema/src/rpc.ts`.

## Persist state or retain it through hot reload

Use `storage.store<Value extends object>(key, { initial })` for durable JSON. It returns `[Store<Value>, (mutation: (draft: Value) => void) => Promise<void>]`. Mutate the updater's draft and await it; do not mutate the readonly Solid store directly.

```ts
import { Plugin } from "@opencode/plugin/tui"

export default Plugin.define({
  id: "acme.settings",
  setup(context) {
    const [settings, update] = context.storage.store("settings", { initial: { compact: false } })
    context.ui.slot({
      append: "app",
      render() {
        context.keymap.layer(() => ({
          commands: [{
            id: "acme.compact.toggle",
            title: settings.compact ? "Use expanded view" : "Use compact view",
            palette: true,
            async run() {
              try {
                await update((draft) => { draft.compact = !draft.compact })
              } catch (error) {
                context.ui.toast.show({ message: String(error), variant: "error" })
              }
            },
          }],
        }))
        return null
      },
    })
  },
})
```

Use `storage.memory` for the same tuple with a synchronous updater and non-JSON values. It survives plugin reloads within this TUI process and disappears on TUI exit:

```ts
import type { Plugin } from "@opencode/plugin/tui"

export function countReloads(context: Plugin.Context) {
  const [state, update] = context.storage.memory("state", { initial: { count: 0 } })
  update((draft) => { draft.count++ })
  return state
}
```

There is no public arbitrary KV `get/set` API. Both stores prefix keys with `plugin.<pluginID>.`; durable files are `<state-root>/<channel>/tui/<prefixed-key>.json`. Valid prefixed keys match `^[a-zA-Z0-9][a-zA-Z0-9._-]*$`; avoid slashes/path traversal in IDs or keys. Writes load the latest disk value under a lock, write atomically, and reconcile the live store. A directory watcher synchronizes other TUI processes' writes; watcher failure disables that live reload. State is terminal-local, not server-owned.

`initial` supplies a fallback, not a deep merge or migration. Reusing an existing key returns its memoized store; changing the default object does not migrate old data. JSON persistence loses functions/classes/Map/Date identity. The internal `key` reconciliation option and `flush()` method are not public plugin storage APIs.

Sources: `packages/plugin/src/tui/context.ts`, `packages/tui/src/plugin/api.tsx`, `packages/tui/src/context/storage.tsx`.

## Compile Solid/OpenTUI JSX and use the host theme

For typechecking/local source, use a modern target plus the host's JSX settings. This complete config typechecks every example in this skill; an older default target fails on Effect generators, `Set` iteration, and `replaceAll`:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "Preserve",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "jsx": "preserve",
    "jsxImportSource": "@opentui/solid",
    "types": ["bun"]
  }
}
```

Put `/** @jsxImportSource @opentui/solid */` on shipped TSX files too; an omitted/unshipped TSConfig must not select React's JSX runtime. `jsx: "preserve"` alone does not compile Solid JSX for distribution. Use universal Solid generation with `moduleName: "@opentui/solid"`, as the host's Node build does, and export the resulting ESM JavaScript. Keep `solid-js`, `solid-js/store`, OpenTUI core/Solid and their runtime subpaths, and `@opencode/plugin/tui` external rather than bundling independent runtime copies. Host versions here are Solid 1.9.15 and OpenTUI 0.5.12; use matching development types, including `@opencode/theme`, and declare runtime peers/imports in the package.

| Runtime/path | Verified behavior |
| --- | --- |
| Bun local TSX outside `node_modules` | Host installs OpenTUI's Solid transform and runtime module sharing, including the public TUI context helpers. |
| Bun installed raw TSX under `node_modules` | The Solid source transform excludes these paths. Runtime import rewriting is a separate path; raw JSX loading does not prove compiler-style reactive getters/lazy children. |
| Node | Runtime support explicitly expects precompiled plugins. Dynamic import resolution probing `.tsx` does not provide a TSX compiler. |
| Published compiled ESM | Avoids dependence on host source compilation. Test module identity, reactivity, and loading against each supported binary; portable Node/Bun installed behavior was not runtime-tested here. |

Max's public model-favorites and question-minimize plugins illustrate installed-path workarounds: copying a catalog into local signals, explicit getters/deferred children, or static JSX anchors plus imperative renderable visibility. Treat those as targeted fixes for their runtime path, not the preferred design for compiled Solid components. A pragma fixes JSX runtime selection; it does not restore the skipped Solid compiler. Test the installed package with changing lists, conditional branches, cleanup, and route transitions.

Use semantic resolved theme tokens:

| Theme surface | Public fields |
| --- | --- |
| Text | `text.base`, `text.muted`, `text.action`, `text.formfield`, `text.feedback[kind].base/muted` |
| Background | `background.base`, `background.raised.base/high/max`, `background.action`, `background.formfield`, `background.feedback[kind].base` |
| Other tokens | `border.base`, `scrollbar.base`, `diff`, `syntax`, `markdown`, `hue`, `categorical` |
| Color helpers | `source(color)`, `increase(color, amount?)`, `decrease(color, amount?)` |
| Raised-surface view | `surface(name): ResolvedTheme`; same theme resolved for that named surface. |

Theme colors are OpenTUI `RGBA`. Action/formfield colors have states and a `state(states)` resolver. Read `context.theme` and `context.themeMode` reactively; old `text.default/subdued` and top-level feedback fields are not current tokens. The public plugin context has no theme-registration, theme-selection, or mode-setting API. Users select themes through CLI settings; theme documents and internal theme services are separate from this plugin API. Read `packages/theme/src/tui/types.ts` and `schema.ts` for exact token/state/surface keys.

Sources: `packages/tui/tsconfig.json`, `packages/tui/src/plugin/runtime-plugin-support.bun.ts`, `packages/tui/src/plugin/runtime-plugin-support.node.ts`, `packages/cli/vite.node.config.ts`, `packages/theme/src/tui/types.ts`; OpenTUI v0.5.12 `packages/solid/scripts/solid-plugin.ts` and `runtime-plugin-support-configure.ts`. Public examples: `my-opencode-setup/plugins/model-favorites/tui.tsx`, `plugins/question-minimize/tui.tsx`.

## Render Markdown fenced-code blocks

Call `markdown.registerCodeBlockRenderer(language: string, render: MarkdownCodeBlockRenderer): () => void`. The OpenTUI renderer receives a code token and render context, returning `Renderable | undefined | null`; `context.defaultRender()` uses the ordinary fenced-code rendering. This is a renderable API, not JSX or arbitrary message rendering. Read `@opentui/core/renderables/Markdown.d.ts` before implementing it.

Language is normalized with `infoStringToFiletype`; empty or duplicate normalized languages within one plugin throw. Multiple plugins' renderers merge last-wins. The host owns unregister on plugin disposal. Built-in Mermaid/LaTeX renderers use this API; assistant text receives the resulting Markdown pipeline.

Sources: `packages/plugin/src/tui/context.ts`, `packages/tui/src/plugin/api.tsx`, `packages/tui/src/plugin/markdown.ts`, `packages/tui/src/routes/session/message-parts.tsx`, `packages/merman/src/plugin.ts`.

## Dispose resources and verify lifecycle

Return cleanup for timers, native/RPC event subscriptions, streams, external processes, renderer listeners, temporary modes, and asynchronous work you start. Use `onCleanup` inside mounted components; use returned plugin cleanup for activation-wide resources. Guard initialization failures if resources were created before setup can throw: the host cannot call a cleanup that setup never returned.

The host owns route/slot/Markdown unregisters and panel release. After setup succeeds it appends your cleanup; disposal executes the list in reverse, continuing through failures. Local changes reconcile through a serialized lifecycle queue. Import failure keeps the previous active generation; setup failure disposes host-owned registrations and can restore the previous one. Slots/routes have render-time error boundaries; that does not cover every asynchronous callback or custom dialog error. Catch asynchronous recipe failures explicitly.

Installed package targets with unchanged options reuse their current module during a session. Updating files on disk, or toggling a plugin, does not prove its new package revision ran. Verify local source loading, installed package loading, reactive updates, and disposal as separate stages; use [packaging.md](packaging.md) for the test/log workflow.

Max's local dev and publish workflow: the `my-opencode` skill.

Sources: `packages/tui/src/plugin/context.tsx`, `packages/tui/src/plugin/api.tsx`, `packages/tui/src/plugin/render.tsx`, `packages/tui/src/plugin/watch.ts`.

## Gotchas

- Mount keymap layers inside slot/route/dialog components. Setup is not a component owner.
- Show the dialog before setting presentation; showing resets size/centering.
- Read reactive props/getters in computations. Slot render bodies execute once, untracked: `render: () => state.ready ? <text>Ready</text> : null` never updates. Use `<Show when={state.ready}>` or a JSX expression. Destructured values freeze the same way.
- Separate import rewriting from Solid compilation. Installed raw TSX can render once while failing to update correctly.
- Own subscriptions/fetches at a stable lifecycle boundary; keep footer/sidebar remounts from multiplying them.
- Use all ten declared slots, including `session.panel`; no per-message footer or public prompt-edit seam exists.
- Use RPC for server-owned data. Local files, subprocesses, persistence, and terminal effects remain on the terminal machine.
- Pass TUI options through `cli.json`; combined-package server options are not forwarded.
- Verify installed behavior and cleanup; typechecking/source inspection does not establish a live TUI result.

## Source map

All OpenCode paths below refer to the v2.0.20 checkout. Installed SDK declarations mirror them under `@opencode/plugin/dist/tui/`.

| Read for | Files |
| --- | --- |
| Public plugin/context/Solid contracts | `packages/plugin/src/tui/plugin.ts`, `context.ts`, `index.ts`, `solid.ts` |
| Package resolution/config/discovery | `packages/plugin/src/host.ts`; `packages/tui/src/plugin/context.tsx`, `discovery.ts`; `packages/tui/src/config/index.tsx`, `keybind.ts`; `packages/cli/src/config/config.ts` |
| Ownership/adapters/slot ordering | `packages/tui/src/plugin/api.tsx`, `render.tsx`, `structure.ts`, `context.tsx` |
| App/home/prompt placements | `packages/tui/src/app.tsx`, `routes/home.tsx`, `feature-plugins/home/footer.tsx`, `component/prompt/index.tsx` |
| Session/sidebar/panel placements | `packages/tui/src/routes/session/index.tsx`, `routes/session/sidebar.tsx`, `component/panel-host.tsx`, `context/panel.tsx` |
| Commands/modal input | `packages/tui/src/context/keymap.tsx`, `ui/dialog.tsx`, `component/prompt/autocomplete.tsx` |
| Data/events/client/RPC | `packages/plugin/src/tui/context.ts`; `packages/client/src/solid/data.ts`, `promise/rpc.ts`; `packages/tui/src/feature-plugins/system/notifications.ts`, `feature-plugins/prompt/btw.tsx` |
| Persistence/attention/theme/Markdown | `packages/tui/src/context/storage.tsx`, `attention.ts`, `plugin/markdown.ts`; `packages/theme/src/tui/types.ts`, `schema.ts`; `@opentui/core/renderables/Markdown.d.ts` |
| Bun/Node JSX and shared runtime | `packages/tui/src/plugin/runtime-plugin-support.bun.ts`, `runtime-plugin-support.node.ts`; `packages/cli/vite.node.config.ts`; OpenTUI v0.5.12 `packages/solid/scripts/solid-plugin.ts`, `runtime-plugin-support-configure.ts`, `packages/core/src/runtime-plugin.ts` |
| Docs to compare against source | `services/www/src/docs/content/build/plugins/cli.mdx`, `cli/plugins.mdx` |
