Verified against OpenCode v2.0.20 (@opencode/plugin 2.0.20).

# Port a v1 plugin

Replace the implementation API, then verify each behavior at its new lifecycle point. Renaming an import, moving the file, or converting config does not make a v1 implementation run in v2. Use [server.md](server.md) for the new server API, [providers.md](providers.md) for auth/provider work, and [tui.md](tui.md) for terminal behavior.

## Identify the generation before editing

Inspect the resolved entrypoint and SDK version, not the README or package name alone.

| Signal | V1 | V2.0.20 |
| --- | --- | --- |
| Server entrypoint | Plugin factory returning a `Hooks` object; recent v1 also accepts an object with `server: factory` | Default definition `{ id, setup }` or `{ id, effect }` |
| SDK | `@opencode-ai/plugin` | `@opencode/plugin`, or `/effect` |
| Initialization | `async ({ client, directory, project, $, ... }, options) => hooks` | `setup(ctx)` registers extensions; `ctx.options` supplies options |
| Hooks | Returned keys such as `"chat.params"`, `"tool.execute.before"` | `await ctx.session.hook("context", callback)`, `await ctx.tool.hook("execute.before", callback)` |
| Tools | Returned `tool` record and `tool({ args, execute })` | `await ctx.tool.transform(editor => editor.add(definition))` |
| Terminal entrypoint | V1 `PluginModule` forbids it with `tui?: never` | Separate `/tui` export using `@opencode/plugin/tui` |

`Plugin.define` is a typing helper; a structurally valid default definition works too. Named exports alone do not satisfy the v2 loader. Early v2 betas also used `@opencode-ai/plugin`, so an old import can indicate a beta rather than v1. Check the actual `{ id, setup/effect }` shape and declarations.

Ground truth: v1 `packages/plugin/src/index.ts` at `origin/dev`; v2 `packages/core/src/plugin/module.ts` and `packages/plugin/src/promise/plugin.ts` at `v2.0.20`.

## Keep supported config; port implementation code

The v2 migration docs say supported v1 server config, agent/command definitions, skills, and `.opencode/` files remain compatible. V2 normalizes supported config in memory without rewriting files; native v2 conversion is optional. The intentional breaking areas are the plugin API, server/client API, and terminal configuration moving to global `cli.json`. Unsupported legacy fields are explicitly listed in the general migration guide.

For a native plugin config, use `plugins` and object options:

```jsonc
// V1
{
  "plugin": [
    ["./plugins/greeting", { "enabled": true }]
  ]
}
```

```jsonc
// V2
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "./plugins/greeting", "options": { "enabled": true } }
  ]
}
```

The normalizer still accepts `plugin` and `[package, options]` tuples. It appends native `plugins` entries after normalized legacy entries. This config compatibility does not adapt v1 hooks.

Configured local targets must be directories. Put an `index.ts` or `server.ts` inside the directory. Auto-discovery still accepts immediate `.ts`/`.js` server files under `.opencode/plugin/` and `.opencode/plugins/`; prefer a directory under `.opencode/plugins/` for a port. The official plugin migration guide's configured `./plugin/local.ts` example conflicts with the v2.0.20 directory check.

Sources: `services/www/src/docs/content/migrate-v1.mdx`, `packages/core/src/config/normalize.ts`, `packages/core/src/config/plugin/source.ts`, `packages/core/src/plugin/source-directory.ts`.

## Translate every hook

Register hooks in `setup`; callbacks receive one mutable event. The registration Promise resolves to `{ dispose(): Promise<void> }`. The host disposes registrations on unload; keep the handle only for earlier removal. Transform callbacks are synchronous, replayable edits, not one-time initialization. Fetch external data before registering, capture it, and call the affected domain's `reload()` when it changes.

| V1 hook/concept | V2 destination | Required change |
| --- | --- | --- |
| `tool.execute.before` | `ctx.tool.hook("execute.before", ...)` | `output.args` becomes `event.input: unknown`; `input.callID` becomes `event.id`. Narrow input before editing. |
| `tool.execute.after` | `ctx.tool.hook("execute.after", ...)` | Narrow `event.status`: `"completed"` has `result`; `"error"` has `error`. Model-facing text is `result.content`, not `output.output`. |
| `tool.definition` | `ctx.tool.transform(...)` | Update the definition's `description` and `input` through `editor.update(id, callback)`. |
| `tool` record | `ctx.tool.transform(...)` | `editor.add` takes one definition object with `name`, `description`, `input`, and `execute`. |
| `chat.message` | `ctx.session.hook("prompt", ...)` | Edit `event.prompt.text/files/agents/skills`, `metadata`, or `delivery` before durable admission. There is no mutable v1 `UserMessage` plus `Part[]` output. |
| `chat.params` | `ctx.session.hook("context", ...)` | Edit `event.options`; `maxOutputTokens` becomes `maxTokens`. `temperature`, `topP`, and `topK` live inside `options`; provider-specific options share that object. |
| `chat.headers` | `ctx.session.hook("model.request", ...)` | Edit `event.headers` and optionally `baseURL`. Use `http.request` for the final native `Request`. |
| `event` | `ctx.event.subscribe({ signal })` | Consume an async iterable; event payload is `event.data`. Own cancellation and background-loop lifetime. |
| `dispose` | Cleanup returned by `setup` | Return `() => void` or `() => Promise<void>`; do not return a hooks object. |
| `config` | Affected domain's `transform(...)` | No mutable global config hook. Move each edit to its owning domain. |
| `auth.methods` | `ctx.integration.transform(...)` | Register through `editor.method.update({ integrationID, method, authorize, refresh, ... })`. V1 `prompts` become a native `form`; OAuth results become native credentials. |
| `auth.loader` | Integration connections and request hooks | Resolve the active connection with `ctx.integration.connection.active/resolve`. Move custom-fetch behavior to `http.request/http.response` when using native HTTP; inspect [providers.md](providers.md) for AI SDK paths. No `auth.loader` hook remains. |
| `provider.models` | `ctx.provider.transform(...)` and `ctx.model.transform(...)` | Provider editor changes source definitions; model editor changes available-provider model overrides/removals. Load remote inventory outside transforms. |
| `permission.ask` | `ctx.permission.hook("evaluate", ...)` | Change `event.effect: "allow" | "deny" | "ask"`, optionally `message`; inspect `action`, `resources`, and `source` instead of the old permission object. |
| `command.execute.before` | Command transform or `prompt` hook | No global equivalent. Register owned commands through `ctx.command.transform(editor => editor.add({ name, execute }))`; use `prompt` for prompt-admission edits regardless of source. |
| `shell.env` | `ctx.shell.hook("create.before", ...)` | Edit `event.env`. Event also has mutable `command`, `cwd`, `timeout`, and `shell`; it has no v1 session/call IDs. |
| `experimental.chat.system.transform` | Session `context` hook | `system: string[]` becomes `SystemPart[]`; append `{ type: "text", text: ... }`. |
| `experimental.chat.messages.transform` | Session `context` hook | Edit model-facing `event.messages`, not v1 `{ info, parts }[]`. This is an outgoing request edit, not a stored transcript rewrite. |
| `experimental.session.compacting` | `ctx.session.hook("compaction", ...)` | Edit structured `system/messages/options/tools`. There is no v1 `context: string[]` plus optional `prompt` pair. Setting `event.result` supplies a summary and skips the model request. |
| `experimental.compaction.autocontinue` | No direct equivalent | Revisit behavior through compaction, execution events, and explicit session operations; the compaction hook has no `enabled` auto-continue flag. |
| `experimental.provider.small_model` | No direct equivalent | Revisit agent/provider/model selection using current configuration and transforms. V2 request hook `model` references are readonly; do not assign a guessed small-model field. |
| `experimental.text.complete` | No direct equivalent | For model input, use request hooks. For tool output, use `execute.after`. For terminal display, use supported TUI slots. None is a persisted assistant-text completion hook. |

Domain transforms exist on `agent`, `provider`, `model`, `command`, `integration`, `mcp`, `reference`, `skill`, `tool`, `vcs`, `websearch`, and `worktree`. Their editors differ; there is no universal config editor. See [server.md](server.md).

For OAuth, replace v1 `method: "auto"/"code"` results with `mode: "auto"/"code"`. Auto mode's `callback` is a Promise, not a function; code mode retains `callback(code)`. Return a native `Credential.OAuth` with `type: "oauth"` and `methodID`, not v1 `type: "success"/"failed"` result wrappers. V1 auth method `type: "api"` becomes the integration's `type: "key"` method.

Use the `prompt` hook for persisted admitted input and `context` for the primary agent request. Register `compaction`, `generate`, and `title` separately when the same model-input policy must cover auxiliary requests. The later `model.request`, `http.request`, and `http.response` hooks expose `kind: "primary" | "compaction" | "title" | "generate"`; provider-scoped session hooks accept `{ providerID }` as their third argument.

For deliberate policy rejection, use permission evaluation or the typed Effect `Tool.Error` failure on `execute.before`. Ordinary Promise hooks wrap callbacks with `Effect.promise`; throwing a generic error is a defect, not a general structured rejection API. Do not copy the migration guide's throw-to-block example into a new guard without choosing the correct failure channel.

Sources: `packages/plugin/src/promise/{session,tool,permission,shell,command,integration,provider,model,registration}.ts`, `packages/core/src/plugin/hooks.ts`, `packages/plugin/src/effect/tool.ts`, `packages/plugin/src/promise/adapter.ts`.

## Replace context and SDK assumptions

Use the native context first. Server plugin methods use the v2 client contract; replacing `client.` with `ctx.` does not preserve v1 input envelopes or response shapes.

| V1 input/concept | V2 equivalent or boundary |
| --- | --- |
| `directory` | `ctx.location.directory`, the load location. |
| `project` | `ctx.location.project` with `id`, `directory`, and `canonical`; it is not the old full Project object. |
| `worktree` string | `ctx.location.project.directory` for this resolved checkout root. `project.canonical` identifies its main checkout directory. `ctx.worktree` is an operation/transform domain, not a path. |
| Second options argument | `ctx.options`. |
| `client.session.*` | Selected `ctx.session` methods: `create`, `get`, `switchAgent`, `switchModel`, `prompt`, `generate`, `command`, `synthetic`, `interrupt`, `update`, `move`, `wait`, `context`. Not every client method is exposed. |
| `client.session.update({ path, body })` | `ctx.session.update({ sessionID, title, ... })`; there is no `ctx.session.rename`. |
| `client` for all server resources | Only the context's declared domains. For an external integration, use `@opencode/client` and its current contract; no server `ctx.client` exists. |
| `serverUrl` | No equivalent context property. Native domain calls do not need server discovery. |
| `$` | No injected shell helper. Import the process API you choose, pass an explicit working directory, and clean up children/cancellation. |
| `experimental_workspace.register(type, adapter)` | No equivalent remote workspace-adapter registration. `ctx.worktree.transform` registers create/remove/list strategies for worktrees; port only behavior that fits that contract. |
| Process-lifetime state/resources | Location activation lifetime plus returned cleanup. A globally configured plugin can have multiple active location instances. |
| Plugin-owned persistent files | `ctx.storage` for plugin-scoped durable JSON state. Choose a stable plugin ID before migrating stored data. |

A session can move. Read session/operation location when resolving its files rather than caching `ctx.location.directory` as the path for every event. Native context methods also avoid accidentally connecting to a different shared server through global service discovery.

Sources: `packages/plugin/src/promise/plugin.ts`, `packages/plugin/src/promise/session.ts`, `packages/schema/src/location.ts`, `packages/core/src/location.ts`, `packages/core/src/project.ts`, `packages/plugin/src/promise/worktree.ts`.

## Port custom tools without losing their contract

Use `editor.add({ name, input, description, execute, ... })`. `Tool.ValueSchema` accepts Effect codecs, Standard Schema schemas, or JSON Schema. A Zod 4 object can stay; replace the v1 `tool.schema` convenience import with your schema library's normal import. Raw JSON Schema makes executor input `unknown`; a typed schema preserves inferred input. Standard Schema values must also support JSON Schema conversion: the runtime accepts Standard JSON Schema methods or a Zod 4 instance and rejects other vendors without conversion support.

| V1 tool field/context | V2 |
| --- | --- |
| Tool record key | Definition `name`; verify effective name/namespace after all transforms. |
| `args: { name: z.string() }` | `input: z.object({ name: z.string() })`, or another supported schema. |
| String return or `{ output: string }` | `{ content: string }` for model-visible text. Optional schema-backed `output` is separate typed data. |
| `title` result field | No matching result field; represent required information in content/metadata. |
| `attachments` with `url/filename` | File entries in `content` with `type: "file"`, `uri`, `mime`, optional `name`. Preserve text/file content in after-hooks. |
| `context.abort` | `context.signal: AbortSignal`. |
| `context.metadata(...)` | `await context.progress(metadata)` during execution; final result `metadata` is separate. |
| `context.ask(...)` | No corresponding public tool-context request method. Preserve an existing permission-enforcing built-in tool or revisit the design. `options.permission` affects disabled-tool inventory filtering; it does not replace resource-level approval. |
| `context.directory/worktree` | Not in v2 `ToolContext`. Resolve the calling session's location when paths matter. |

V2 uses Code Mode by default. Set `options: { codemode: false }` when the tool must remain directly callable under its familiar name. Recheck built-in names and permission actions rather than copying v1 `bash`/`task` assumptions.

Sources: `packages/schema/src/tool.ts`, `packages/plugin/src/promise/tool.ts`, `packages/core/src/tool.ts`, `packages/core/src/tool/runtime.ts`; v1 `packages/plugin/src/tool.ts` at `origin/dev`.

## Work through a small port

Keep a greeting tool directly callable and preserve the primary request's system instruction, temperature, token limit, and header. The v1 factory is migration input only:

```ts
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

export const GreetingPlugin: Plugin = async (_input, options) => {
  if (options?.enabled === false) return {}

  return {
    tool: {
      greeting: tool({
        description: "Create a greeting",
        args: { name: tool.schema.string() },
        async execute({ name }) {
          return `Hello ${name}!`
        },
      }),
    },
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push("Keep greetings short.")
    },
    "chat.params": async (_input, output) => {
      output.temperature = 0.2
      output.maxOutputTokens = 8_000
    },
    "chat.headers": async (_input, output) => {
      output.headers["x-plugin"] = "greeting"
    },
  }
}
```

The v2 default definition registers the tool and request edits:

```ts
import { Plugin } from "@opencode/plugin"
import { z } from "zod"

export default Plugin.define({
  id: "greeting",
  async setup(ctx) {
    if (ctx.options.enabled === false) return

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "greeting",
        description: "Create a greeting",
        input: z.object({ name: z.string() }),
        options: { codemode: false },
        async execute({ name }) {
          return { content: `Hello ${name}!` }
        },
      })
    })

    await ctx.session.hook("context", (event) => {
      event.system.push({ type: "text", text: "Keep greetings short." })
      event.options.temperature = 0.2
      event.options.maxTokens = 8_000
    })

    await ctx.session.hook("model.request", (event) => {
      if (event.kind === "primary") event.headers["x-plugin"] = "greeting"
    })
  },
})
```

This example uses Zod 4's Standard Schema contract. Declare Zod if your package imports it; the host's transitive dependency is not your dependency contract. The v2 example typechecked against `@opencode/plugin@2.0.20`; it was not loaded into a live host. Test auxiliary-request requirements separately rather than claiming full equivalence for v1 experimental system-hook coverage.

## Replace completion listeners and own cleanup

Listen for emitted execution events: `session.execution.started`, `session.execution.succeeded`, `session.execution.failed`, and `session.execution.interrupted`. Core publishes one terminal event per busy period, which can cover coalesced drains. A succeeded event is not necessarily one event per user message.

```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "completion-log",
  setup(ctx) {
    const controller = new AbortController()
    const pump = (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type === "session.execution.succeeded") {
          console.log("Session completed", event.data.sessionID)
        }
      }
    })().catch((error: unknown) => {
      if (!controller.signal.aborted) console.error("Event subscription failed", error)
    })

    return async () => {
      controller.abort()
      await pump
    }
  },
})
```

The official migration example listens for `session.idle`. That event remains a deprecated schema member, but the v2.0.20 execution producer emits the execution events above and does not publish `SessionStatusEvent.Idle`. A generated union accepting an event does not establish a producer.

This small pump logs an unexpected subscription failure and stops. A plugin that must recover needs an explicit retry/backoff and shutdown policy. Do not await a permanent pump before returning from setup. Clean up timers, listeners, sockets, and children you own; hook/transform registrations already have host-managed disposal. If setup fails before returning cleanup, release resources acquired earlier yourself or use scoped Effect acquisition.

Recheck other event names during migration: forms use `form.created/replied/cancelled`; credentials use `credential.updated/switched`. Read current payloads rather than copying v1 `properties` or early-beta integration-connection events. Permissions still have their own `permission.asked/replied` events.

Sources: `packages/core/src/session/execution.ts`, `packages/schema/src/{session-event,session-status-event,form,credential,permission}.ts`, `packages/plugin/src/promise/{event,adapter}.ts`.

## Change packaging and separate terminal work

| Task | V2 action |
| --- | --- |
| Choose SDK | Author against `@opencode/plugin@2.0.20`; use root Promise API, `/effect`, `/tui`, `/rpc` for their respective contracts. |
| Publish server half | Export a default definition at package `./server`, falling back to package root. |
| Load local source directory | Supply root `server.*` or `index.*`; a local directory's export map does not redirect this filesystem lookup into `src/` or `dist/`. |
| Publish terminal half | Export `./tui`, default definition with its own `setup`, and runtime dependencies for its imports. |
| Share server/TUI contracts | Export `./rpc`; use [rpc.md](rpc.md), not a shared process-global variable. |
| Configure both halves | Server `opencode.json(c)` advertises a combined plugin's TUI feature to the terminal. TUI-only packages use global `cli.json`. |
| Port terminal output | Move terminal escapes, widgets, dialogs, and local commands to the TUI half; the shared server does not own the user's terminal. |
| Retain v1 support | Keep implementations explicitly separate and test both hosts. A dual default object can expose `server` for recent v1 and `setup` for v2; older v1 may require a factory entrypoint. |

Inspect `exports` before calling a package compatible. Some packages retain a v1 root and expose a v2 subpath. V2 resolves package `/server` before root; it does not search arbitrary `/v2` paths. Ensure the actual resolved server entrypoint has the v2 definition, or publish separate versions/entrypoints that the host can resolve. See [packaging.md](packaging.md) for exact loading and installed-package tests.

Pin/check each workspace's resolved SDK. A wildcard peer on the historical `@opencode-ai/plugin` name can resolve v1 even when another workspace uses v2 beta types. Current v2 uses the new name, but stale lockfiles and nested dependencies can still make source compilation and runtime resolution disagree. Type-only imports remove unnecessary runtime imports; they do not translate an API.

V2-shaped beta plugins also need review. In v2.0.20 `ctx.provider` and `ctx.model` are separate domains; there is no `ctx.catalog`. Tests mocking a retired beta context can pass while the installed plugin fails.

Max's local dev and publish workflow: the `my-opencode` skill.

## Verify the port

1. Resolve the exact installed package/entrypoint and matching SDK declarations. Confirm the default definition, ID, exports, files, dependencies, and source/config path.
2. Typecheck every v2 snippet and the real package. Exercise each migrated tool, hook, transform, command, and event against the target host/location; verify persisted-message versus outgoing-request behavior.
3. Test setup failure, unload, reload, multiple locations, and moved sessions for owned resources/state. Test each request kind the policy claims to cover.
4. Test the installed artifact, including terminal behavior if present. A workspace-linked typecheck or mocked context does not prove installed loading or live behavior.

## Gotchas

- V1 config is normalized; v1 implementation hooks are not. Preserve unrelated supported config while porting code.
- Default-export the definition. A named factory, returned hooks object, or `server` function alone cannot satisfy the v2 loader.
- Use directory targets for configured local plugins, even though stale docs show `.ts` file targets.
- Preserve structured result content and distinguish `completed` from `error`; there is no universal mutable output string.
- A tool's `options.permission` is an inventory filter, not v1 `context.ask()` approval.
- Use emitted execution events rather than the deprecated `session.idle` type member.
- Match the SDK and mock context to the target host; early v2 examples can be obsolete too.
- Treat prompt admission, model context, native HTTP, and terminal rendering as separate surfaces with different persistence and ownership.

## Source map

Read these paths at `v2.0.20` unless a v1 ref is specified:

- `services/www/src/docs/content/build/plugins/migrate-v1.mdx`: official destinations; correct its idle-event, file-target, and generic throw-to-block examples using source.
- `services/www/src/docs/content/migrate-v1.mdx`: supported config compatibility and intentional breaking areas.
- `packages/plugin/src/index.ts`, `packages/plugin/src/tool.ts` at `origin/dev`: exhaustive v1 inputs, hooks, auth, and tool contract.
- `packages/plugin/src/promise/{plugin,session,tool,permission,shell,command,event,registration,integration,provider,model,worktree}.ts`: v2 Promise contracts.
- `packages/schema/src/{tool,prompt-input,location,session-event,session-status-event,form,credential,permission}.ts`: structured values and event payloads.
- `packages/core/src/session/{prompt,model-request,execution}.ts`: admission, request-hook stages, and actual execution-event producer.
- `packages/core/src/tool.ts`, `packages/core/src/tool/runtime.ts`: tool permission filtering and schema conversion/validation.
- `packages/core/src/plugin/{module,hooks}.ts`, `packages/plugin/src/effect/tool.ts`, `packages/plugin/src/promise/adapter.ts`: definition validation, hook failure channels, adapters, and cleanup.
- `packages/core/src/config/normalize.ts`, `packages/core/src/config/plugin/source.ts`, `packages/core/src/plugin/source-directory.ts`: legacy normalization and local-target checks.
- `packages/core/src/plugin.ts`, `packages/plugin/src/promise/storage.ts`, `packages/core/src/{location,project}.ts`: location-scoped activation, plugin-ID storage scope, and checkout paths.
- `packages/plugin/{package.json,src/host.ts}`, `packages/tui/src/plugin/context.tsx`, `packages/cli/src/commands/handlers/plugin/add.ts`: SDK exports, entrypoint resolution, and server/TUI routing.
- Published `@opencode/plugin/dist/promise/{plugin,session,tool,registration}.d.ts`: compiler contract for the target SDK.
