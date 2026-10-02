---
name: writing-opencode-plugins
description: Build, extend, debug, or port OpenCode v2 plugins. Use when writing a server plugin (tools, session/prompt/request hooks, events, commands, agents, permissions, storage), a TUI plugin (slots, sidebar/footer items, palette/slash commands, keymaps, dialogs, toasts, panels), a provider/model/OAuth plugin, RPC between plugin halves, or when packaging, installing, testing, or migrating a v1 plugin to v2.
---

# Writing OpenCode v2 plugins

Verified against OpenCode v2.0.20 (`@opencode/plugin` 2.0.20). The v2 plugin API is a rewrite: v1 hook objects, `@opencode-ai/plugin`, `client`/`$` inputs, and `tool({ args })` do not exist here. Trust the installed SDK's `.d.ts` over memory, docs, and this skill when they disagree.

## Mental model

A plugin is a package with up to two halves that load in different processes:

- The **server half** (`./server` export) runs inside the shared background OpenCode service, once per active location (directory). It shapes what the model sees and does: tools, prompt and request hooks, events, commands, agents, providers, permissions, storage. It never owns a terminal.
- The **TUI half** (`./tui` export) runs inside each terminal client. It renders into named slots, registers commands and keybinds, opens dialogs, shows toasts, and reads a reactive cache of server state. Terminal effects (escape codes, sounds, local files the user sees) belong here.
- **RPC** connects them: the server half registers a typed contract, the TUI half calls it through `ctx.client.rpc(contract)`.

Server code extends OpenCode in two ways. **Transforms** are synchronous, replayable edits to a domain's collection (tools, agents, commands, providers, models, skills, MCP servers). OpenCode reruns them whenever the domain rebuilds, so fetch data before registering and call `ctx.<domain>.reload()` when captured data changes. **Runtime hooks** intercept live operations (`session.hook("context")`, `tool.hook("execute.before")`, `permission.hook("evaluate")`) and receive one mutable event; hooks from all plugins run in registration order on the same event.

Two server authoring styles expose the same capabilities: Promise (`Plugin.define({ id, setup })` from `@opencode/plugin`) and Effect (`Plugin.define({ id, effect })` from `@opencode/plugin/effect`). Default to Promise; choose Effect when the plugin is already Effect code or needs scoped resource ownership.

```ts
import { Plugin } from "@opencode/plugin"
import { Schema } from "effect"

export default Plugin.define({
  id: "acme.hello",
  async setup(ctx) {
    await ctx.tool.transform((tools) => {
      tools.add({
        name: "acme_hello",
        description: "Greet someone",
        input: Schema.Struct({ name: Schema.String }),
        options: { codemode: false },
        execute: async ({ name }) => ({ content: `Hello ${name}` }),
      })
    })
    await ctx.session.hook("context", (event) => {
      event.system.push({ type: "text", text: "Prefer short answers." })
    })
  },
})
```

This example ran live on a v2.0.20 server as a local directory plugin (`index.ts` in a directory listed in `plugins`): the model called `acme_hello` directly and followed the injected instruction. Tool input schemas accept Effect Schema, Standard Schema (Zod 4), or raw JSON Schema; typed schemas infer the executor's input. Declare any schema library you import as your own dependency (for `effect`, the exact version `@opencode/plugin` depends on).

## Workflow

1. **Pin the target.** Run `opencode --version` and depend on the exact matching `@opencode/plugin` version (never a wildcard). Open that version's `node_modules/@opencode/plugin/dist/**/*.d.ts` as the contract. Done when the package's SDK version equals the host version and imports resolve.
2. **Choose the halves.** Model, session, tool, or credential behavior goes in the server half. Rendering, keys, and terminal-local effects go in the TUI half. If the TUI needs server-owned data or actions, add an RPC contract. Done when every behavior has an owning half.
3. **Find the nearest working plugin** in [reference/examples.md](reference/examples.md) and read its implementation before writing yours.
4. **Scaffold the package** from the templates in [reference/packaging.md](reference/packaging.md): `exports` for `./server` and/or `./tui`, pinned SDK, runtime peers for TUI, JSX pragma on shipped TSX.
5. **Implement** with the reference file for each domain you touch (table below). Return cleanup for every timer, subscription, process, and stream you start; hook and transform registrations are disposed by the host.
6. **Verify up the ladder** and report the highest stage reached: typecheck against the pinned SDK, unit tests, loaded as a local directory, loaded as an installed package, live behavior in a running server/TUI. Each stage proves only itself. Installed TUI packages in particular behave differently from local source (see Gotchas).

Max's local dev and publish workflow: the `my-opencode` skill.

## Where each capability lives

| Task | API | Read |
| --- | --- | --- |
| Add or wrap a tool the model calls | `ctx.tool.transform` (`add`/`update`), `ctx.tool.hook("execute.before" \| "execute.after")` | [server.md](reference/server.md) |
| Edit system prompt, outgoing messages, request options | `ctx.session.hook("context")`; also `compaction`, `generate`, `title` for auxiliary requests | [server.md](reference/server.md) |
| Change user input before it is stored | `ctx.session.hook("prompt")` | [server.md](reference/server.md) |
| React to session finished, failed, form, permission | `ctx.event.subscribe()` (server) or `ctx.data.on(type, fn)` (TUI); `session.execution.*` events | [server.md](reference/server.md), [tui.md](reference/tui.md) |
| Drive sessions: create, prompt, interrupt, rename, wait | `ctx.session.create/prompt/interrupt/update/wait/context/...` | [server.md](reference/server.md) |
| Add server commands, agents, skills, MCP servers | `ctx.command/agent/skill/mcp.transform` | [server.md](reference/server.md) |
| Allow or deny permissions; change shell env | `ctx.permission.hook("evaluate")`, `ctx.shell.hook("create.before")` | [server.md](reference/server.md) |
| Persist server state | `ctx.storage.get/set/scan/remove` | [server.md](reference/server.md) |
| Add reference sources (local dirs, Git repos) | `ctx.reference.transform` | [server.md](reference/server.md#add-a-skill-reference-or-mcp-server) |
| Add a web search, VCS, or worktree backend | `ctx.websearch/vcs/worktree.transform` | [server.md](reference/server.md#add-websearch-vcs-or-worktree-backends) |
| One-off model call without a session; inspect plugins; read a session terminal | `ctx.generate.text`, `ctx.plugin.list`, `ctx.experimental.terminal.read` | [server.md](reference/server.md#generate-without-a-session-inspect-plugins-or-read-a-terminal) |
| Add a provider, discover or filter models | `ctx.provider.transform`, `ctx.model.transform` | [providers.md](reference/providers.md) |
| OAuth or API key auth; rewrite provider requests | `ctx.integration.transform`, `session.hook("model.request" \| "http.request" \| "http.response")`, `ctx.aisdk.hook` | [providers.md](reference/providers.md) |
| Sidebar, footer, composer, home, panel UI | `ctx.ui.slot({ append \| prepend \| before \| after \| replace: <slot>, render })` | [tui.md](reference/tui.md) |
| Palette command, slash command, keybind | `ctx.keymap.layer(...)` inside a mounted component | [tui.md](reference/tui.md) |
| Dialog, confirm, select, prompt, toast, OS notification | `ctx.ui.dialog.*`, `ctx.ui.toast.show`, `ctx.attention.notify` | [tui.md](reference/tui.md) |
| Plugin screens, session panels, tabs, model variant | `ctx.ui.router`, `ctx.ui.panel`, `ctx.ui.tabs`, `ctx.ui.model` | [tui.md](reference/tui.md) |
| Persist TUI state | `ctx.storage.store` (durable JSON), `ctx.storage.memory` (survives hot reload) | [tui.md](reference/tui.md) |
| Server and TUI talk to each other | `Rpc.define` from `@opencode/plugin/rpc`, `ctx.rpc.register`, `ctx.client.rpc` | [rpc.md](reference/rpc.md) |
| package.json, config entries, install CLI, loading, logs, tests | `exports`, `plugins` in `opencode.jsonc` or `cli.json`, `opencode plugin ...` | [packaging.md](reference/packaging.md) |
| Port a v1 plugin | hook-by-hook translation table | [migrate-v1.md](reference/migrate-v1.md) |

## Gotchas that apply everywhere

- **Match the SDK to the host.** A different `@opencode/plugin` version, or a wildcard peer resolving the v1 `@opencode-ai/plugin`, typechecks against the wrong contract.
- **Default-export the definition.** The loader reads the default export's `{ id, setup }` (or `{ id, effect }`); named exports and v1 factories do not load.
- **Keep transforms synchronous and replayable.** Async work inside a transform callback is not awaited. Fetch first, capture, then `reload()` the domain.
- **Keep setup short.** Plugins activate one after another; a setup that awaits a long probe or a never-ending event loop delays every later plugin. Start loops in the background and return cleanup.
- **Clean up on failure too.** If setup throws after starting resources, the host never receives your cleanup; release them in a `catch`.
- **One server, many locations.** A global plugin can have several active instances, one per location, and an event's session can belong to another location than the instance observing it. Scope state by session ID and location.
- **`session.idle` is gone.** Listen for `session.execution.succeeded/failed/interrupted`. Event payloads live in `event.data`, not v1 `properties`.
- **The prompt hook and the context hook are different surfaces.** `prompt` edits what gets stored; `context` edits only the outgoing primary request. Title, compaction, and generate requests need their own hooks.
- **Throwing from a Promise hook is a defect, not a rejection.** Deny through `permission.hook("evaluate")` or the typed Effect tool error.
- **Promise domain calls ignore `signal`.** `ctx.session.wait(input, { signal })` and other native Promise methods drop their options argument; only event subscriptions, RPC calls, and tool executors honor signals. Use Effect interruption when those calls must be cancellable.
- **Promise `tool` editor updates turn typed tool errors into defects.** Wrap a built-in tool from an Effect plugin when its `Tool.Error` failures must survive.
- **Slot render bodies run once.** A top-level ternary in `render` never updates; put conditions in `<Show>` or JSX expressions.
- **Mount TUI keymaps inside a component.** Call `ctx.keymap.layer` inside a slot, route, or dialog renderer (a headless `app` slot returning `null` works), never directly in setup.
- **Test installed TUI packages from `node_modules`.** OpenTUI's Solid compiler skips `node_modules`, so raw TSX that updates correctly from a local directory can render once and then stop reacting when installed. Ship compiled JS or keep reactive reads in explicit getters, and test the installed path.
- **Installed is not running.** `opencode plugin update` stages a new revision; a running server or TUI can keep executing the old module. Confirm the live behavior, and restart only after checking who else uses the shared server.
- **HTTP hooks do not see WebSocket traffic.** Registering `http.request`/`http.response` does not force HTTP; models on the WebSocket transport need the `experimental.ws.handshake/send/receive` session hooks as well.

## Ground truth

- Published contract: `node_modules/@opencode/plugin/dist/{promise,effect,tui}/*.d.ts` at the pinned version.
- Upstream source: `anomalyco/opencode` at tag `v<version>` (v2 lives on the `v2` branch; `dev` is the v1 line). Key paths: `packages/plugin/src/` (SDK), `packages/core/src/plugin/` (host, hooks, built-in plugins), `packages/tui/src/plugin/` (TUI host), `packages/plugin-browser/` (a complete first-party plugin). Use the `btca-local` skill to read a local clone.
- Docs: https://opencode.ai/v2/docs/build/plugins and its `/cli`, `/rpc`, `/effect`, `/migrate-v1` subpages. Several doc examples are stale; each reference file lists the known conflicts.
