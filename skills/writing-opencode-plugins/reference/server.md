Verified against OpenCode v2.0.20 (@opencode/plugin 2.0.20).

# Extend the server

Use server plugins for tools, prompt/request policy, sessions, domain inventories, and durable state. Use [tui.md](tui.md) for terminal presentation and local commands. Entrypoint exports, discovery, config, loading tests, and logs belong in [packaging.md](packaging.md); auth and provider implementation belong in [providers.md](providers.md).

Every recipe below typechecks against the published SDK. These are authoring examples, not live-host integration tests. Declare the packages your implementation imports; transitive availability in the typecheck project is not a dependency contract.

## Define the plugin and choose its async boundary

Default-export `Plugin.define({ id, setup })` from `@opencode/plugin` for ordinary Promise code. `setup(context: Plugin.Context): Promise<Cleanup | void> | Cleanup | void`, with `Cleanup = () => Promise<void> | void`. `define` returns its input; the loader requires a default object with an ID string and a setup/effect function.

```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "example.policy",
  async setup(ctx) {
    if (ctx.options.enabled === false) return
    await ctx.session.hook("context", (event) => {
      event.system.push({ type: "text", text: "Keep changes within the requested scope." })
    })
  },
})
```

Choose a stable, unique, nonempty ID such as `example.policy`. Server v2.0.20 types/loader use an unrestricted string, not a declared ID-pattern validator. The supervisor keeps the first duplicate ID and reports later duplicates as failed. Avoid the built-in `opencode.` prefix: configuration selectors treat it specially. Changing the ID also changes the storage namespace. Package name and plugin ID are separate identities.

Read configuration through `ctx.options`, a readonly record supplied by the plugin object entry and defaulting to `{}`. There is no second setup argument or definition-level options schema. Validate options once in setup with your existing validator or direct narrowing; do not validate them in every transform replay.

Use `Plugin.define({ id, effect })` from `@opencode/plugin/effect` when the plugin intentionally shares the host's Effect contract. Its signature is `effect(context: Context): Effect.Effect<void, never, R>`, with `R = Scope.Scope` by default. Domain calls return Effects, event subscription returns a Stream, and executable definitions use Effect callbacks. Transforms stay synchronous.

```ts
import { Plugin } from "@opencode/plugin/effect"
import { Effect, Stream } from "effect"

export default Plugin.define({
  id: "example.effect-events",
  effect: (ctx) => Effect.gen(function* () {
    yield* ctx.event.subscribe().pipe(
      Stream.filter((event) => event.type === "session.execution.succeeded"),
      Stream.runForEach((event) => ctx.storage.set(`finished/${event.data.sessionID}`, event.created)),
      Effect.catchCause((cause) => Effect.logWarning("example.effect-events stopped", cause)),
      Effect.forkScoped,
    )
  }),
})
```

The host provides the plugin scope and current logging settings. Use `Effect.acquireRelease`, `Effect.addFinalizer`, and `Effect.forkScoped` for resources. Setup's failure type is `never`; handle fallible initialization deliberately. Third-party Effect plugins do not receive private core services just because built-in plugins import them. For a plugin using a different Effect version internally, a Promise host boundary plus an owned managed runtime can avoid sharing that runtime contract; see [examples.md](examples.md).

Promise setup must return cleanup for owned timers, listeners, child processes, sockets, independent runtimes, and background work. If setup throws before returning cleanup, release partially acquired resources in a `catch`/`finally`; the host cannot invoke a function it never received. Hook/transform/RPC registrations already have scope-owned cleanup.

Sources: `packages/plugin/src/{promise,effect}/plugin.ts`, `packages/plugin/src/options.ts`, `packages/plugin/src/promise/adapter.ts`, `packages/core/src/plugin/{module,supervisor}.ts`, `packages/core/src/plugin.ts`.

## Find the context capability

All context fields are readonly. Promise and Effect contexts expose the same domains; operations differ in return types and decoded/encoded values. This is a restricted in-process client-shaped object, not the full HTTP client.

| Field | Purpose | Main methods/data |
| --- | --- | --- |
| `app` | Identify host build | `name`, `version`, `channel` |
| `location` | Identify this activation's location | `directory`, optional `workspaceID`, `project: { id, directory, canonical }` |
| `options` | Read supplied plugin configuration | Readonly option record |
| `agent` | Read and edit agents/default | `list`, `get`, `transform`, `reload` |
| `aisdk` | Resolve AI SDK objects | `hook("sdk"/"language", callback, { providerID }?)` |
| `command` | Contribute server commands | `list`, `transform`, `reload` |
| `event` | Observe public live events | `subscribe` |
| `experimental.terminal` | Read persistent session terminal | `read({ sessionID, lines? })` |
| `integration` | Register auth and manage connections | `list`, `get`, `connect.key`, `oauth.*`, `command.*`, `connection.active/resolve/status`, `transform`, `reload` |
| `mcp` | Edit MCP configuration/read status | `list`, `transform`, `reload` |
| `model` | Edit available-provider candidates/default | `list`, `default`, `transform`, `reload` |
| `generate` | Generate without session history/tools | `text({ prompt, model? })` |
| `permission` | Evaluate or resolve permissions | `list`, `get`, `reply`, `hook("evaluate", ...)` |
| `plugin` | Inspect plugin inventory | `list` |
| `provider` | Edit provider settings/source inventories | `list`, `get`, `transform`, `reload` |
| `reference` | Register local/Git reference sources | `list`, `transform`, `reload` |
| `rpc` | Extend server methods/events | Callable `rpc(definition)`; `register(definition, handlers)` |
| `session` | Operate on known sessions | `create`, `get`, `switchAgent`, `switchModel`, `prompt`, `generate`, `command`, `synthetic`, `interrupt`, `update`, `move`, `wait`, `context`, `hook` |
| `shell` | Edit shell launches | `hook("create.before", ...)` |
| `skill` | Read/edit skills | `list`, `transform`, `reload` |
| `storage` | Persist plugin-scoped JSON | `get`, `set`, `remove`, `scan` |
| `tool` | Contribute/wrap/intercept tools | `list`, `transform`, `reload`, `hook` |
| `vcs` | Read diffs/status; register VCS backend | `get`, `base`, `branch.list`, `status`, `diff`, `transform`, `reload` |
| `websearch` | Register/query search backends | `providers`, `query`, `transform`, `reload` |
| `worktree` | Register strategies/operate on project inventory | `list`, `create`, `remove`, `refresh`, `transform`, `reload` |

Provider transforms edit source definitions, including inactive providers; see [providers.md](providers.md). Model transforms edit candidates only under available providers; see [providers.md](providers.md). Integration transforms own auth independently of providers; see [providers.md](providers.md). AI SDK hooks resolve cached SDK/language objects rather than intercept every request; see [providers.md](providers.md).

There is no `ctx.client`, `$`, `serverUrl`, `config`, `form`, `log`, filesystem/process helper, formatter registry, instruction-discovery registry, or arbitrary HTTP route registrar. `session.context` is available, but full session enumeration, fork/remove, message CRUD, log cursors, compact, form, and subagent dispatch are not. Import platform IO only when required and own its cancellation/lifetime. Prefer native context methods over rediscovering a server that might be a different process.

**Promise domain methods ignore their second `RequestOptions` argument, including `signal`.** The adapter (`adaptApiMethod` in `packages/plugin/src/promise/adapter.ts`) accepts only the input and runs the Effect without cancellation, so `ctx.session.wait(input, { signal })` keeps waiting after the signal aborts. Signals do work for event subscriptions, RPC calls, and tool executors. When a native call (session, worktree, integration, and similar) must be cancellable, use the Effect API and interrupt the fiber, or race the Promise yourself and accept that the host operation continues.

Many read APIs return `{ location, data }`; session operations return their declared value directly. Inputs/outputs come from `@opencode/client/promise/api` or `/effect/api`, not v1 `{ path, body }` envelopes. Some host adapters use the activation's location despite inherited client types accepting `location`; verify `packages/core/src/plugin/host.ts` before assuming cross-location routing. Agent reads and MCP list explicitly support cross-location selection.

Sources: `packages/plugin/src/{promise,effect}/plugin.ts`, `packages/plugin/src/app.ts`, `packages/schema/src/location.ts`, `packages/core/src/plugin/host.ts`.

## Choose transforms, hooks, or reload

Use a transform to contribute effective registry state. The callback is `(editor) => void`, synchronous and replayable. Fetch/read external inputs before registering it. Registration, disposal, and `domain.reload()` invalidate state; materialization replays active callbacks in registration order on a fresh base. Earlier returned values remain stable. Runtime hooks mutate one live operation. `reload()` replays transforms without rerunning setup.

### All transform domains

Each domain exposes `transform(callback)` and `reload()`. Every public editor method appears below. A transform has no result-based short-circuit or provider-scoping argument; choose objects/IDs inside its callback.

| Domain | Editor methods | Edits |
| --- | --- | --- |
| `agent` | `list()`, `get(id)`, `default(id \| undefined)`, `update(id, callback)`, `remove(id)` | Mutable `Agent.Info`; update creates missing agents. No `add`. |
| `aisdk` | None | Runtime hooks only. |
| `command` | `add(definition)` | Executable command definitions only. No editor list/get/update/remove. |
| `integration` | `list()`, `get(id)`, `update(id, callback)`, `remove(id)`, `method.list(integrationID)`, `method.update(registration)`, `method.remove(integrationID, method)` | Integration name and auth implementations. [providers.md](providers.md) |
| `mcp` | `list()`, `get(name)`, `set(name, config)`, `update(name, callback)`, `remove(name)` | Local/remote server configs. |
| `model` | `list(providerID?)`, `get(providerID, modelID)`, `update(providerID, modelID, callback)`, `remove(providerID, modelID)`, `default.get/set`, `provider.list/get` | Mutable raw overrides; immutable provider source reads. [providers.md](providers.md) |
| `provider` | `list()`, `get(providerID)`, `add({ info, models, sourceConnection? })`, `update(providerID, callback)`, `remove(providerID)`, `models.set/update/remove` | Provider metadata/source definitions. [providers.md](providers.md) |
| `reference` | `add(name, source)`, `remove(name)`, `list()`, `get(name)` | Local/Git source registrations. |
| `skill` | `list()`, `get(id)`, `add(info)`, `update(id, callback)`, `remove(id)` | Mutable `Skill.Info`. |
| `tool` | `list()`, `get(id)`, `namespace({ name, description })`, `add(info)`, `update(id, callback)`, `remove(id)` | Complete executors and schemas, keyed by effective ID. |
| `vcs` | `add(definition)`, `default.get()`, `default.set(id)` | VCS backends and selection. |
| `websearch` | `add(definition)`, `default.get()`, `default.set(id \| false)` | Search backends and selection. |
| `worktree` | `add(definition)` | Create/remove/list strategies; later additions select the default. |

Keep mutable captured state outside the callback, then explicitly reload after changes. This recipe fetches once at setup and once when the tool runs; it creates no timer to clean up:

```ts
import { Plugin } from "@opencode/plugin"
import { Schema } from "effect"

export default Plugin.define({
  id: "example.dynamic-policy",
  async setup(ctx) {
    const load = async () => {
      const response = await fetch("https://example.com/plugin-policy.json", {
        signal: AbortSignal.timeout(5000),
      })
      if (!response.ok) throw new Error(`Policy HTTP ${response.status}`)
      return Schema.decodeUnknownSync(Schema.Struct({ note: Schema.String }))(await response.json())
    }
    let policy = await load()
    await ctx.agent.transform((editor) => {
      editor.update("example-review", (agent) => { agent.system = policy.note })
    })
    await ctx.tool.transform((editor) => editor.add({
      name: "refresh_example_policy",
      description: "Refresh the example review policy",
      input: Schema.Struct({}),
      async execute() {
        policy = await load()
        await ctx.agent.reload()
        return { content: "Policy refreshed." }
      },
    }))
  },
})
```

These edits affect future registry/request snapshots. An executor closing over mutable data still sees that data; capture it inside the transform if it must stay tied to one definition. Keep transforms free of counters, resources, fetches, and asynchronous edits. TypeScript can accept an async function where a void callback is expected; that does not make core await it.

### Dispose one registration early

Promise registrations have `dispose(): Promise<void>`; Effect registrations have `dispose: Effect.Effect<void>`. Disposal is idempotent and scope-owned. Runtime dispatch captures its callback array: disposing during a dispatch does not cancel callbacks already in that snapshot.

```ts
import type { Plugin } from "@opencode/plugin"

export async function removeTemporaryPolicy(ctx: Plugin.Context) {
  const registration = await ctx.session.hook("context", (event) => {
    event.system.push({ type: "text", text: "Temporary review policy." })
  })
  await registration.dispose()
}
```

Sources: `packages/plugin/src/{promise,effect}/registration.ts`, domain files under those directories, `packages/core/src/state.ts`, `packages/core/src/plugin/hooks.ts`.

## Add a tool

Register a complete definition with `ctx.tool.transform(editor => editor.add(definition))`. The Promise executor is `(decodedInput, context: ToolContext) => Promise<Tool.Result<OutputSchema>>`. Effect executors return `Effect.Effect<Tool.Result<OutputSchema>, Tool.Error>` and use Effect interruption instead of an explicit signal.

### Use an inferred schema and explicit output

Effect Schema codecs work in both plugin APIs. This direct tool exposes typed data and model-visible content separately:

```ts
import { Plugin } from "@opencode/plugin"
import { Schema } from "effect"

export default Plugin.define({
  id: "example.greeting",
  async setup(ctx) {
    await ctx.tool.transform((editor) => editor.add({
      name: "greeting",
      description: "Create a greeting for a name",
      input: Schema.Struct({ name: Schema.String }),
      output: Schema.Struct({ greeting: Schema.String }),
      options: { codemode: false },
      async execute({ name }, call) {
        await call.progress({ stage: "formatting" })
        const greeting = `Hello ${name}`
        return { output: { greeting }, content: greeting, metadata: { name } }
      },
    }))
  },
})
```

`ToolContext` has readonly `sessionID`, `agent`, `messageID`, tool-call `id`, `signal`, and `progress(metadata): Promise<void>`. There is no working directory, selected model, `ask`, `abort`, or `metadata()` method. Read `ctx.session.get({ sessionID: call.sessionID })` for the session's current location/model. Pass `call.signal` to cancellable external work. In native Effect tools, `progress` returns an Effect and context has no explicit signal.

### Use Standard Schema or Zod 4

Zod 4 implements Standard Schema and the host knows its JSON Schema conversion. Other Standard Schema vendors need Standard JSON Schema conversion (`~standard.jsonSchema.input/output`) as well as validation; otherwise registration fails. Do not copy the v1 root `tool.schema` helper.

```ts
import { Plugin } from "@opencode/plugin"
import { z } from "zod"

export default Plugin.define({
  id: "example.fetch",
  async setup(ctx) {
    await ctx.tool.transform((editor) => editor.add({
      name: "fetch_example_page",
      description: "Fetch a page on example.com",
      input: z.object({ path: z.string() }),
      async execute({ path }, call) {
        const url = new URL(path, "https://example.com/")
        if (url.origin !== "https://example.com") return { content: "Only example.com is supported." }
        const response = await fetch(url, { signal: call.signal })
        return { content: await response.text(), metadata: { status: response.status } }
      },
    }))
  },
})
```

### Use raw JSON Schema and file content

Raw JSON Schema makes executor input `unknown`; narrow/decode it if the executor uses it. This empty-input tool needs no cast:

```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "example.file",
  async setup(ctx) {
    await ctx.tool.transform((editor) => editor.add({
      name: "example_note",
      description: "Return a small note as text and a file",
      input: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        return { content: [
          { type: "text", text: "Attached note." },
          { type: "file", uri: "data:text/plain;base64,SGVsbG8=", mime: "text/plain", name: "note.txt" },
        ] }
      },
    }))
  },
})
```

| Definition/result field | Contract |
| --- | --- |
| `name`, `description`, `input`, `execute` | Required. Optional definition `output` declares its output schema. |
| Result `content` | Optional string or readonly text/file array. Text: `{ type: "text", text }`; file: `{ type: "file", uri, mime, name? }`. |
| Result `output` | Separate structured data. Return it only with an output schema, and always return it when a schema exists. |
| Result `metadata` | Application-defined record; `progress` publishes running metadata separately. No result `title` or `attachments`. |
| `options.namespace?: string` | Effective ID becomes namespace plus normalized tool name. Register namespace description with `editor.namespace`. |
| `options.codemode` | Defaults to Code Mode. `false` exposes the tool directly to the model. |
| `options.pinned?: boolean` | Available only for Code Mode tools; keeps their entry in the initial Code Mode catalog. |
| `options.permission?: string` | Action used for whole-tool inventory filtering. It does not authorize each call/resource. |

String content becomes one text part; omitted/empty-array content falls back to stringified output. Output without a schema is a defect; missing declared output is `Tool.Error`. Effect codecs encode output, Standard Schema validates it, and raw JSON output receives only a JSON-value check, not its declared constraints. Raw JSON input conversion can fail and leave input unvalidated. Use a supported typed schema for acceptance-critical validation.

Effective tool names replace unsupported characters with `_`; namespace dots become `_`. Names accept 1..128 normalized `[A-Za-z0-9_-]` characters; namespace segments accept 1..64. Direct effective ID `execute` is reserved. Invalid registrations log and skip. Use `ctx.tool.list()` to verify effective IDs after every transform, including MCP contributions.

The host normalizes content, then after-hooks run before image normalization and runner truncation. Default truncation is 2000 lines/50 KiB with full text spilled to tool-output storage; files survive. Any `metadata.truncated` value, including `false`, bypasses core truncation. Do not set it unless your tool deliberately owns bounded output. There is no server-side custom tool-render callback.

Sources: `packages/plugin/src/{promise,effect}/tool.ts`, `packages/schema/src/tool.ts`, `packages/core/src/tool.ts`, `packages/core/src/tool/runtime.ts`, `packages/core/src/tool-output.ts`, `packages/core/src/codemode/tool.ts`.

## Modify or wrap an existing tool

Use `editor.update(effectiveID, callback)` to edit description, schema, options, or executor. Missing IDs do nothing; `add` creates. Updates preserve name and namespace. Replace schema/options objects instead of mutating their nested data. Keep the original executor when its validation/permission/process behavior matters.

```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "example.wrap-read",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.update("read", (tool) => {
        const execute = tool.execute
        tool.description += " Returns the original read result with example metadata."
        tool.execute = async (input, call) => {
          const result = await execute(input, call)
          return { ...result, metadata: { ...result.metadata, wrappedBy: "example.wrap-read" } }
        }
      })
    })
  },
})
```

The Promise editor changes error semantics. Every Promise `editor.update` replaces the executor with a Promise bridge, even when the callback edits only the description. A typed `Tool.Error` from the original executor crosses that bridge as a rejected Promise and returns to core as a defect, so error-status after-hooks and model-visible tool errors no longer see it. When the wrapped tool's failures must stay typed, wrap it from a native Effect plugin instead:

```ts
import { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"

export default Plugin.define({
  id: "example.wrap-read",
  effect: (ctx) =>
    ctx.tool
      .transform((editor) => {
        editor.update("read", (tool) => {
          const execute = tool.execute
          tool.execute = (input, call) =>
            execute(input, call).pipe(
              Effect.map((result) => ({ ...result, metadata: { ...result.metadata, wrappedBy: "example.wrap-read" } })),
            )
        })
      })
      .pipe(Effect.asVoid),
})
```

Use `execute.before` for input changes instead of replacing an executor. `input` is `unknown`; narrow the actual schema. An invented input field does not create support in the built-in executor. Use `execute.after` for result edits, preserving files/structured output and narrowing `status` first.

```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "example.tool-hooks",
  async setup(ctx) {
    await ctx.tool.hook("execute.before", (event) => {
      if (event.tool !== "greeting" || typeof event.input !== "object" || event.input === null) return
      if ("name" in event.input && typeof event.input.name === "string") {
        event.input = { ...event.input, name: event.input.name.trim() }
      }
    })
    await ctx.tool.hook("execute.after", (event) => {
      if (event.tool !== "greeting" || event.status !== "completed") return
      const content = typeof event.result.content === "string"
        ? [{ type: "text" as const, text: event.result.content }]
        : [...(event.result.content ?? [])]
      event.result = { ...event.result, content: [...content, { type: "text", text: "Greeting complete." }] }
    })
  },
})
```

Both outer Code Mode execution and its inner calls pass tool hooks. On direct calls, before-hooks can redirect `tool` before lookup. The inner Code Mode path uses its captured executor and consumes changed `input`; changing inner `event.tool` does not redirect that executor. After-hooks run for executor success/typed `Tool.Error`, not every defect or a before-hook rejection. The after-hook's readonly status cannot turn the error arm into success.

For deliberate model-visible rejection use the Effect before-hook's `Tool.Error` failure channel. Promise callback rejection is a defect, including a thrown `Tool.Error`; it is not this typed channel.

```ts
import { Plugin } from "@opencode/plugin/effect"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"

export default Plugin.define({
  id: "example.block-tool",
  effect: (ctx) => Effect.gen(function* () {
    yield* ctx.tool.hook("execute.before", (event) =>
      event.tool === "example_delete"
        ? Effect.fail(new Tool.Error({ message: "Example deletion is disabled." }))
        : Effect.void,
    )
  }),
})
```

Sources: `packages/plugin/src/{promise,effect}/tool.ts`, `packages/core/src/tool.ts`, `packages/plugin/src/promise/adapter.ts`.

## Edit model-facing system, messages, and options

Use `session.hook("context", callback, { providerID }?)` for the primary agent loop. `system` is `SystemPart[]`; `messages` is `@opencode/ai` model-facing `Message[]`, not persisted session messages. Changes affect the outgoing request only. Register `compaction`, `generate`, and `title` separately if the policy must cover them.

```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "example.request-policy",
  async setup(ctx) {
    const policy = (event: import("@opencode/plugin/promise/session").SessionRequest) => {
      event.system.push({ type: "text", text: "Keep review findings specific and short." })
      event.options.temperature = 0.2
      event.options.maxTokens = 8000
      event.messages = event.messages.map((message) => ({
        ...message,
        content: message.content.map((part) => part.type === "text"
          ? { ...part, text: part.text.replaceAll("example-secret", "[redacted]") }
          : part),
      }))
    }
    await ctx.session.hook("context", (event) => { policy(event); delete event.tools.example_delete })
    await ctx.session.hook("compaction", policy)
    await ctx.session.hook("generate", policy)
    await ctx.session.hook("title", policy)
    await ctx.session.hook("model.request", (event) => {
      event.headers["x-example-request-kind"] = event.kind
    })
  },
})
```

The v2.0.20 primary and compaction requests begin with a computed `maxTokens` override; title and generate begin with `{}`. Other resolved model settings are not copied into `event.options`. Generation keys use semantic names such as `maxTokens`; other keys are provider options. Overrides take precedence over defaults, recursive objects merge, and arrays/scalars replace. Removing an override falls back to configured defaults. Raw HTTP body overlays can override protocol-lowered fields later. Message/part properties remain readonly in the types; replace messages or their content arrays when editing text, as above.

Request-local `tools` can remove tools or edit description/input schemas. Move the same definition object to another key to alias it; identity preserves the executor. Unknown invented entries are dropped. Add executable tools through `ctx.tool.transform`, not by inventing a request entry. Keep repeated system edits stable if prompt-prefix caching matters.

Sources: `packages/plugin/src/{promise,effect}/session.ts`, `packages/core/src/session/model-request.ts`, `packages/ai/src/schema/messages.ts`.

## Modify admitted user prompts

Use `session.hook("prompt", callback)` before attachment/skill resolution and durable inbox admission. Edit `prompt.text/files/agents/skills`, `metadata`, and `delivery`; session/message IDs are readonly. Provider scoping is unavailable at admission.

```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "example.admission",
  async setup(ctx) {
    await ctx.session.hook("prompt", (event) => {
      if (!event.prompt.text.includes("example-secret")) return
      event.prompt.text = event.prompt.text.replaceAll("example-secret", "[redacted]")
      for (const item of event.prompt.files ?? []) delete item.mention
      for (const item of event.prompt.agents ?? []) delete item.mention
      for (const item of event.prompt.skills ?? []) delete item.mention
      event.metadata = { ...event.metadata, redacted: true }
      event.delivery = "queue"
    })
  },
})
```

Files added here use `{ uri, name?, description?, mention? }`; selected skills use `{ id, mention? }`. Normal resolution validates/materializes them. Adjust or remove mention offsets after rewriting text. Agent attachments do not switch the active agent.

The hook runs for user prompts, including commands that submit through `session.prompt`. Synthetic/shell messages and move/compaction controls bypass it. A duplicate already-admitted ID returns its existing entry; concurrent submissions can run preparation more than once before one wins. Keep admission side effects retry-safe. Preparation failure prevents admission, but the hook has no typed rejection/result API.

Sources: `packages/plugin/src/promise/session.ts`, `packages/schema/src/{prompt-input,prompt}.ts`, `packages/core/src/session/prompt.ts`, `packages/core/src/session/inbox.ts`.

## Intercept native HTTP or WebSocket traffic

Use `model.request` for endpoint/header changes before transport; use `http.request`/`http.response` for final native provider traffic. Clone before reading one-shot bodies. A request hook has no response field with which to supply a fake response.

```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "example.transport",
  async setup(ctx) {
    await ctx.session.hook("http.request", (event) => {
      const headers = new Headers(event.request.headers)
      headers.set("x-example-session", event.sessionID)
      event.request = new Request(event.request, { headers })
    }, { providerID: "openai" })
    await ctx.session.hook("http.response", (event) => {
      console.log("example.transport", event.kind, event.response.status)
    }, { providerID: "openai" })
    await ctx.session.hook("experimental.ws.handshake", (event) => {
      event.headers["x-example-session"] = event.sessionID
    }, { providerID: "openai" })
  },
})
```

HTTP hooks do not force WebSocket-capable models onto HTTP. The host supplies both available transport wrappers, and the route selects one. HTTP hooks cover HTTP fallback, not socket frames. For transport-wide policy, evaluate the experimental handshake/send/receive hooks too; rewriting `frame` sends it verbatim and the plugin owns protocol consequences. See [providers.md](providers.md) for auth, route selection, and AI SDK boundaries.

Sources: `packages/core/src/session/model-request.ts`, `packages/plugin/src/promise/session.ts`.

## Register a command or agent

Server command definition: `{ name, description?, execute: (input: CommandInvocation) => Promise<void> }`, where invocation is `{ sessionID, prompt: PromptInput.Prompt, delivery: "steer" | "queue" }`. The editor has only `add`; it does not expose general command editing or a global execute-before hook.

```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "example.review-command",
  async setup(ctx) {
    await ctx.command.transform((editor) => editor.add({
      name: "example-review",
      description: "Review the current changes",
      async execute({ sessionID, prompt, delivery }) {
        await ctx.session.prompt({
          ...prompt, sessionID, delivery,
          text: `Review changes for correctness and missing tests.\n\n${prompt.text}`,
        })
      },
    }))
  },
})
```

This command is server-owned and callable through `session.command`. A TUI slash command uses a keymap layer and can navigate/show dialogs without a model turn. Keep terminal-only actions in [tui.md](tui.md). A server command executor can also complete without prompting; registration itself does not imply generation.

Add an agent with `editor.update(id, callback)`: missing agents start from host defaults. Use `mode: "subagent"`, `"primary"`, or `"all"`; a default agent must be visible and not subagent-only.

```ts
import { Agent, Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "example.review-agent",
  async setup(ctx) {
    await ctx.agent.transform((editor) => {
      editor.update("example-reviewer", (agent) => {
        agent.name = Agent.Name.make("Example reviewer")
        agent.description = "Reviews correctness and missing tests"
        agent.mode = "subagent"
        agent.system = "Report concrete regressions with file paths."
      })
    })
  },
})
```

Other `Agent.Info` fields are `id`, optional `model`, `request`, `hidden`, optional `color/steps`, and `permissions`. Editor values retain schema brands: use constructors such as `Agent.Name.make` when assigning branded names/IDs. Contributing a subagent definition does not supply a public child-session dispatcher or a `parentID` creation input.

Sources: `packages/plugin/src/promise/{command,agent}.ts`, `packages/schema/src/agent.ts`, `packages/core/src/{agent,command}.ts`, `packages/core/src/plugin/command.ts`.

## Add a skill, reference, or MCP server

Use each domain's editor, not a global config hook. Skill entries need branded IDs/name and a real absolute `path`; `path` is the current SDK field, not the stale docs' `location`.

```ts
import { Mcp, Plugin, Skill } from "@opencode/plugin"
import { AbsolutePath } from "@opencode/schema/schema"
import path from "node:path"

export default Plugin.define({
  id: "example.resources",
  async setup(ctx) {
    await ctx.skill.transform((editor) => editor.add({
      id: Skill.ID.make("example-review"),
      name: Skill.Name.make("Example review"),
      description: "Review changes for correctness",
      autoinvoke: false,
      path: AbsolutePath.make(path.join(ctx.location.directory, "SKILL.md")),
      content: "Review changed behavior and its existing tests.",
    }))
    await ctx.reference.transform((editor) => {
      editor.add("example-handbook", { type: "local", path: ctx.location.directory })
      editor.add("example-upstream", {
        type: "git", repository: "https://github.com/anomalyco/opencode", branch: "v2.0.20",
      })
    })
    await ctx.mcp.transform((editor) => {
      editor.set("example-docs", new Mcp.RemoteConfig({
        type: "remote", url: "https://mcp.example.com", disabled: true,
      }))
    })
  },
})
```

Choose an existing skill resource directory/file appropriate to your package; the example path must exist before a caller needs its resources. Skills carry markdown `content`; `autoinvoke` controls automatic invocation eligibility. Read/edit inventories through their editor methods or located list APIs. Reference sources are exactly local `{ type, path }` or Git `{ type, repository, branch? }` in the Promise editor; source description/hidden fields available to internal config are not declared here.

MCP local config requires `type: "local"` and `command: string[]`, with optional `cwd`, `environment`, `disabled`, `codemode`, `timeout`, `protocol`. Remote config requires `type: "remote"` and `url`, with optional `headers`, `oauth`, and the same control fields. `timeout` has millisecond `startup/catalog/execution`; protocol is `"legacy" | "auto" | "2026-07-28"`. Read the schema for OAuth options.

`disabled: true` disconnects; `false` allows connection. `mcp.reload()` reconciles changed captured configs; successful registration does not prove connection or tool catalog readiness. This domain has no connect/disconnect/resource-read methods. Use [providers.md](providers.md) for integration/auth methods. Later config plugins can alter contributed skills/references.

Sources: `packages/plugin/src/promise/{skill,reference,mcp}.ts`, `packages/schema/src/{skill,mcp}.ts`, `packages/core/src/plugin/host.ts`, `packages/core/src/config/plugin/{skill,reference,mcp}.ts`.

## Add websearch, VCS, or worktree backends

Register search with `editor.add({ id, name, execute })`, then select with `editor.default.set(id)`. Promise `execute(input: { query }, { signal })` returns `readonly WebSearch.Result[]`. Results have `url`, optional `title/content`, required `time: { published?: number }` in Unix milliseconds.

```ts
import { Plugin, WebSearch } from "@opencode/plugin"
import { Schema } from "effect"

export default Plugin.define({
  id: "example.search",
  async setup(ctx) {
    await ctx.websearch.transform((editor) => {
      editor.add({
        id: "example-search", name: "Example search",
        async execute({ query }, { signal }) {
          const url = new URL("https://example.com/search")
          url.searchParams.set("q", query)
          const response = await fetch(url, { signal })
          if (!response.ok) throw new Error(`Search HTTP ${response.status}`)
          return Schema.decodeUnknownSync(Schema.Array(WebSearch.Result))(await response.json())
        },
      })
      editor.default.set("example-search")
    })
  },
})
```

`default.set(false)` disables search; the host also recognizes `"random"`. `websearch.providers()` and `query({ query, providerID?, location? })` return located results. `reload()` refreshes definitions after captured state changes; it does not retry a failed network query.

Implement the VCS backend against the published `VcsDefinition`, then register/select it. This installer accepts your actual implementation, not fake empty repository results:

```ts
import type { Plugin } from "@opencode/plugin"
import type { VcsDefinition } from "@opencode/plugin/promise/vcs"

export async function installVcs(ctx: Plugin.Context, backend: VcsDefinition) {
  return ctx.vcs.transform((editor) => {
    editor.add(backend)
    editor.default.set(backend.id)
  })
}
```

| VCS callback | Promise contract |
| --- | --- |
| `info(scope, { signal })` | `Promise<Vcs.Info>`: `{ provider?, branch: { current?, default? } }` |
| Optional `base(scope, { signal })` | `Promise<Vcs.Base \| null>`: `{ name, ref, source: "reflog" \| "default" }` |
| `branches(input, { signal })` | `Promise<Vcs.BranchList>` (`readonly string[]`); scope plus optional `search/limit` |
| `status(scope, { signal })` | `Promise<readonly Vcs.FileStatus[]>`: `file`, `additions`, `deletions`, `status: "added" \| "deleted" \| "modified"` |
| `diff(input, { signal })` | `Promise<readonly FileDiff.Info[]>`; scope plus `mode`, optional `base`, required `context/maxOutputBytes` |

`VcsScope` is `{ directory, worktree, canonical, store? }`. Modes are `"working" | "branch" | "committed"`. Client reads are `get`, `base`, `branch.list({ search?, limit? })`, `status`, `diff({ mode, base?, context? })`, all located. The client method is `branch.list`, not docs' `branches`. Built-in Git/Mercurial detection still owns repository discovery; a matching backend ID can be selected automatically. Backend callbacks must respect cancellation/output budgets.

Implement worktrees against `WorktreeDefinition`, then register it. The editor only has `add`, which also selects it; later additions win.

```ts
import type { Plugin } from "@opencode/plugin"
import type { WorktreeDefinition } from "@opencode/plugin/promise/worktree"

export async function installWorktreeStrategy(ctx: Plugin.Context, strategy: WorktreeDefinition) {
  return ctx.worktree.transform((editor) => editor.add(strategy))
}
```

| Worktree callback | Promise contract |
| --- | --- |
| `create({ sourceDirectory, directory, branch? }, { signal })` | `Promise<{ directory: string }>`; return the actual existing checkout directory |
| `remove({ directory, force }, { signal })` | `Promise<void>`; respect dirty-worktree/force behavior |
| `list(sourceDirectory, { signal })` | `Promise<readonly { directory: string; type: "root" \| "worktree" }[]>`; report owned directories and roots |

To ask the host for force confirmation (for example, a dirty checkout), fail `remove` with the public `Worktree.OperationError` and `forceRequired: true`. The Promise adapter uses `Effect.tryPromise`, so a thrown `OperationError` reaches core intact; other thrown values are wrapped into a generic `OperationError` without `forceRequired`. Effect strategies fail with the same class.

```ts
import { Worktree } from "@opencode/plugin"
import type { WorktreeDefinition } from "@opencode/plugin/promise/worktree"

declare function isDirty(directory: string, signal: AbortSignal): Promise<boolean>
declare function removeCheckout(directory: string, signal: AbortSignal): Promise<void>

export const remove: WorktreeDefinition["remove"] = async ({ directory, force }, { signal }) => {
  if (!force && (await isDirty(directory, signal))) {
    throw new Worktree.OperationError({ message: "Uncommitted changes", forceRequired: true })
  }
  await removeCheckout(directory, signal)
}
```

`branch` means a starting ref, not a new branch name. The suggested destination already reflects host naming/collision handling; a backend choosing another destination owns collisions there. Creation failure does not fall back to Git. Existing worktrees retain recorded strategy ownership; unavailable owners fail removal.

Client operations require `projectID`: `list({ projectID })`, `create({ projectID, from?, name?, directory?, branch? })`, `remove({ projectID, directory, force })`, `refresh({ projectID })`. There is no client `strategy` field. List reads saved inventory; refresh performs discovery. Create/refresh/remove use the canonical checkout's configuration/plugins, not necessarily the caller's activation. Strategies manage local directories, not remote workspace provisioning. Effect backend executors omit the explicit signal context and use Effect interruption.

Sources: `packages/plugin/src/{promise,effect}/{websearch,vcs,worktree}.ts`, `packages/plugin/src/worktree.ts`, `packages/schema/src/{websearch,vcs,file-diff}.ts`, `packages/core/src/{vcs,worktree}.ts`, `packages/core/src/worktree/strategies.ts`, `packages/core/src/plugin/host.ts`.

## Evaluate permissions and edit shell environments

Permission evaluation runs after configured/saved rules choose `ask` or `allow`. Configured denies return before the hook, so it cannot override them. Mutable fields are `effect: "allow" | "deny" | "ask"` and optional `message`; inspect readonly `sessionID`, optional `agent`, `action`, `resources`, optional `metadata/source`.

```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "example.launch-policy",
  async setup(ctx) {
    await ctx.permission.hook("evaluate", (event) => {
      if (event.action !== "example-delete") return
      event.effect = "deny"
      event.message = "Example deletion is disabled."
    })
    await ctx.shell.hook("create.before", (event) => {
      event.env.EXAMPLE_MODE = "1"
    })
  },
})
```

`permission.list({ sessionID })` returns pending requests; `get({ sessionID, requestID })` reads one; `reply({ sessionID, requestID, decision, message? })` resolves one. `decision` is `"once" | "always" | "reject"`. There is no context `ask`, `assert`, or `rules` method; set session rules through `session.update({ sessionID, permissions })`. `options.permission` on a tool filters inventory and does not request per-resource approval. Preserve the built-in executor when you need its existing permission pipeline.

Shell `create.before` has mutable `command`, `cwd`, `timeout`, `shell`, and `env: Record<string, string | undefined>`. It has no session/call ID, process handle, stdout, or executor method. It intercepts core-managed shell creation, not every subprocess a plugin starts itself.

Sources: `packages/plugin/src/promise/{permission,shell}.ts`, `packages/core/src/{permission,shell}.ts`, `packages/core/src/plugin/host.ts`, `packages/client/src/effect/api/api.ts`.

## Call the selected sessions API

Use known session IDs and the exact native input object. Promise input IDs/paths are strings; hook/schema values and native Effect inputs use branded IDs. `model` selection uses `{ providerID, id, variant? }`, not `modelID`.

| Method | Input (all optional fields marked `?`) | Promise result |
| --- | --- | --- |
| `create` | Optional `{ id?, title?, agent?, model?, location?: { directory }, metadata?, permissions? }` | `SessionInfo` |
| `get` | `{ sessionID }` | `SessionInfo` |
| `switchAgent` | `{ sessionID, agent }` | `void` |
| `switchModel` | `{ sessionID, model }` | `void` |
| `prompt` | `{ sessionID, id?, text, files?, agents?, skills?, metadata?, delivery?, resume? }` | `SessionInboxUser` |
| `generate` | `{ sessionID, prompt }` | `{ text: string }` |
| `command` | `{ sessionID, name, text, files?, agents?, skills?, delivery? }` | `void` |
| `synthetic` | `{ sessionID, id?, text, description?, metadata?, delivery?, resume? }` | `SessionInboxSynthetic` |
| `interrupt` | `{ sessionID, resume? }` | `{ interrupted: boolean }` |
| `update` | `{ sessionID, title?, metadata?, permissions? }` | `void`; host applies title/permissions only |
| `move` | `{ sessionID, directory, delivery? }` | `void`; directory must be absolute |
| `wait` | `{ sessionID }` | `void` |
| `context` | `{ sessionID }` | `readonly SessionMessageInfo[]` |

`delivery` is `"steer" | "queue"`. File/skill attachments use the prompt-input schemas above; agent attachments use `AgentAttachment` in `packages/schema/src/prompt.ts`. Session metadata and permissions use the generated `SessionMetadata` and `PermissionRuleset`, not arbitrary invented fields. Read their schemas before supplying them.

```ts
import type { Plugin } from "@opencode/plugin"

export async function runReview(ctx: Plugin.Context) {
  const session = await ctx.session.create({ title: "Example review", agent: "build" })
  await ctx.session.prompt({ sessionID: session.id, text: "Review the current changes.", delivery: "queue" })
  await ctx.session.wait({ sessionID: session.id })
  const messages = await ctx.session.context({ sessionID: session.id })
  const summary = await ctx.session.generate({ sessionID: session.id, prompt: "Summarize the review in one sentence." })
  await ctx.session.update({ sessionID: session.id, title: "Completed example review" })
  return { sessionID: session.id, messages, summary: summary.text }
}
```

Create defaults to the activation's location. It has no `parentID`; this recipe creates a root session. Prompt returns admission, not a completed model response. Wait for idle and then read projected context if needed. `context` is not a full archive/log cursor API. Synthetic messages enter model context; `resume: false` adds a reminder without starting the loop. Use RPC/TUI state for cosmetic notices.

`session.update` declares `metadata` but the v2.0.20 plugin host ignores it; do not rely on metadata updates there. There is no `rename`; use `update({ title })`. Command uses `name/text`, not `command/arguments`; interrupt uses `resume`, not `continue`, and returns its interruption result. Avoid prompting/waiting on the intercepted session inside its own request hook: recursion/deadlock is a design risk, not a tested supported pattern.

### Generate without a session, inspect plugins, or read a terminal

```ts
import type { Plugin } from "@opencode/plugin"

export async function inspectHost(ctx: Plugin.Context, sessionID: string) {
  const plugins = await ctx.plugin.list()
  const terminal = await ctx.experimental.terminal.read({ sessionID, lines: 100 })
  const generated = await ctx.generate.text({ prompt: "Write a one-sentence review checklist." })
  return { plugins: plugins.data, terminal, text: generated.text }
}
```

`generate.text({ prompt, model? })` returns `{ text }` without session history/tools; use session generation for session context. Plugin list returns `{ location, data: PluginInfo[] }`: entries include optional `id`, `source`, `features`, and active/failed `state` with error/ref. Context exposes no plugin add/update/reload operation. Inventory can show failed while an older fallback is running.

Terminal `read({ sessionID, lines? })` returns `null` or `{ ptyID, title, cwd, foregroundProcess: string | null, screen: { text, cols, rows, cursor: { x, y } } }`. It reads persistent PTY snapshots only; it cannot create/write/delete them.

Sources: `packages/plugin/src/promise/{session,plugin}.ts`, `packages/client/src/{effect/api/api,promise/generated/types}.ts`, `packages/plugin/src/promise/adapter.ts`, `packages/core/src/plugin/host.ts`, `packages/core/src/session/generate.ts`.

## Persist JSON in server storage

Use `get(key): Promise<Schema.Json | undefined>`, `set(key, value): Promise<void>`, `remove(key): Promise<void>`, and `scan({ prefix, after?, limit? }): Promise<{ entries: readonly { key, value }[]; next? }>`. Persist versioned data and decode it on read. Scan every cursor.

```ts
import type { Plugin } from "@opencode/plugin"

export async function readQueue(ctx: Plugin.Context, sessionID: string) {
  await ctx.storage.set(`queue/${sessionID}`, { version: 1, ready: true })
  const value = await ctx.storage.get(`queue/${sessionID}`)
  const entries = []
  let after: string | undefined
  do {
    const page = await ctx.storage.scan({ prefix: "queue/", after, limit: 100 })
    entries.push(...page.entries)
    after = page.next
  } while (after !== undefined)
  await ctx.storage.remove(`queue/${sessionID}`)
  return { value, entries }
}
```

The global database namespaces keys by plugin ID, not by location/project/session. Multiple active instances with the same ID share storage. Include your required session/location identity in the key. Changing IDs loses access to the previous namespace unless explicitly migrated. Keys/cursors returned by scan are plugin-relative.

Scan defaults to 100, clamps limits to 1..1000, sorts lexicographically ascending, and excludes `after`. `next` is the last returned key when another page exists. There is no transaction, compare-and-set, atomic update, TTL, or secret-store API. A `get` followed by `set` does not create a cross-instance lock. TUI storage is separate and terminal-local; see [tui.md](tui.md).

Sources: `packages/plugin/src/{promise,effect}/storage.ts`, `packages/plugin/src/storage.ts`, `packages/core/src/plugin/host.ts`, `packages/core/src/kv.ts`.

## Subscribe to events and own the consumer

Promise `ctx.event.subscribe({ signal }?)` returns `AsyncIterable<OpenCodeEvent>`. Effect `ctx.event.subscribe()` returns `Stream.Stream<OpenCodeEvent, unknown>`. Subscribe to all, then filter `event.type`; there is no subscribe-by-type overload. Read payloads through `event.data`, not v1 `properties`.

```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "example.completion-events",
  setup(ctx) {
    const controller = new AbortController()
    const pump = (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type !== "session.execution.succeeded") continue
        const session = await ctx.session.get({ sessionID: event.data.sessionID })
        if (session.location.directory !== ctx.location.directory) continue
        console.log("example.completion-events", session.id)
      }
    })().catch((error: unknown) => {
      if (!controller.signal.aborted) console.error("example.completion-events stopped", error)
    })
    return async () => { controller.abort(); await pump }
  },
})
```

Start the pump without awaiting it during setup; abort and await it on cleanup. Choose explicit logging/retry/reconciliation for failures or missed events. The Effect-scoped recipe at the start uses the same ownership with a Stream. Public events are live-only, not replay. Do not assume this activation's stream only contains this directory: filter event/session identity. Ambient bus scoping differs for built-ins versus external activation, and automatic location filtering was not runtime-tested here. Sessions can move; read their current location or process move events rather than retaining a permanent directory cache.

Event envelope is `id`, `created`, optional `metadata/location`, `type`, and `data`; durable events also have `{ aggregateID, seq, version }`. Request/operation hooks and event notifications are different APIs. The Promise inherited `onActivity` subscribe option is not invoked by the in-process adapter.

### Event names by area

All public union names are listed below. Table fields describe `event.data`. Common abbreviations: `S = sessionID`, `A = assistantMessageID`, `I = tool-call id`, `O = ordinal`; these are actual property names when expanded, not aliases accepted by the API. Named payload types are in the generated client declarations. A type's presence does not prove an active producer.

| Area | Type | Data fields |
| --- | --- | --- |
| Session identity | `session.created` | `sessionID, projectID, location, subpath?, parentID?, slug, title?, agent?, model?, metadata?, permissions?, version` |
| | `session.agent.selected` | `S, agent, previous?` |
| | `session.model.selected` | `S, model, previous?` |
| | `session.moved` | `S, location, projectID, subpath?` |
| | `session.renamed` | `S, title` |
| | `session.metadata.updated` | `S, metadata: SessionMetadata` |
| | `session.permissions` | `S, permissions: PermissionRuleset` |
| | `session.viewed` | `S, idle` |
| | `session.usage.updated` | `S, cost, tokens: TokenUsageInfo` |
| | `session.deleted` | `S` |
| | `session.forked` | `S, parentID, boundary, instructions?, instructionEntries?` |
| Inbox | `session.inbox.enqueued` | `S, inboxID, item: SessionInboxItem` |
| | `session.inbox.delivered` | `S, inboxID` |
| | `session.inbox.cancelled` | `S, inboxID` |
| | `session.inbox.delivery.changed` | `S, inboxID, delivery` |
| Execution | `session.execution.started` | `S` |
| | `session.execution.succeeded` | `S` |
| | `session.execution.failed` | `S, error: SessionStructuredError` |
| | `session.execution.interrupted` | `S, reason: "user" \| "shutdown" \| "superseded" \| "inactivity"` |
| Context | `session.instructions.updated` | `S, delta: Record<string, string \| "removed">, text?` |
| | `session.synthetic` | `S, text, description?, metadata?` |
| | `session.skill.activated` | `S, id, name, text` |
| Model step | `session.step.started` | `S, A, agent, model, snapshot?, started` |
| | `session.step.streamed` | `S, A` |
| | `session.step.ended` | `S, A, finish, rawFinish?, providerState?, cost, tokens, snapshot?, files?` |
| | `session.step.failed` | `S, A, error, finish?: "content-filter", rawFinish?, providerState?, cost?, tokens?, snapshot?, files?` |
| Text | `session.text.started` | `S, A, O` |
| | `session.text.delta` | `S, A, O, delta` |
| | `session.text.ended` | `S, A, O, text, state?` |
| Reasoning | `session.reasoning.started` | `S, A, O, state?` |
| | `session.reasoning.delta` | `S, A, O, delta` |
| | `session.reasoning.ended` | `S, A, O, text, state?` |
| Tool streaming | `session.tool.input.started` | `S, A, I, name` |
| | `session.tool.input.delta` | `S, A, I, delta` |
| | `session.tool.input.ended` | `S, A, I, text` |
| | `session.tool.called` | `S, A, I, input, executed, state?` |
| | `session.tool.progress` | `S, A, I, metadata` |
| | `session.tool.success` | `S, A, I, nonempty content, metadata?, executed, resultState?` |
| | `session.tool.failed` | `S, A, I, error, content?, metadata?, executed, resultState?` |
| Retry | `session.retry.scheduled` | `S, A, attempt, at, error` |
| Compaction | `session.compaction.started` | `S, reason: "auto" \| "manual", recent, inputID?` |
| | `session.compaction.delta` | `S, text` |
| | `session.compaction.ended` | `S, reason, model?, providerState?, providerContext?, text, recent, cost?, tokens?` |
| | `session.compaction.failed` | `S, reason, error, inputID?, cost?, tokens?` |
| Revert | `session.revert.staged` | `S, revert: SessionRevert` |
| | `session.revert.cleared` | `S` |
| | `session.revert.committed` | `S, to` |
| Session shell | `session.shell.started` | `S, shell: ShellInfo` |
| | `session.shell.ended` | `S, shell, output: { output, cursor, size, truncated }` |
| Forms | `form.created` | `form: FormInfo1` |
| | `form.replied` | `id, sessionID, answer: FormAnswer2` |
| | `form.cancelled` | `id, sessionID` |
| Permissions | `permission.asked` | `id, sessionID, action, resources, save?, metadata?, source?, message?` |
| | `permission.replied` | `sessionID, requestID, reply: PermissionReply` |
| Credentials | `credential.updated` | `{}` |
| | `credential.switched` | `integrationID, credentialID: string \| null` |
| Inventories | `models-dev.refreshed`, `integration.updated`, `provider.updated`, `model.updated`, `agent.updated` | `{}` each |
| | `reference.updated`, `plugin.updated`, `command.updated`, `config.updated`, `skill.updated`, `websearch.updated` | `{}` each |
| Project | `project.updated` | `id, canonical, vcs?, name?, icon?, commands?, time, sandboxes` |
| Worktree | `worktree.updated` | `projectID` |
| | `worktree.resolved` | `projectID, directory, previous, adopted?` |
| Filesystem | `filesystem.changed` | `file, event: "add" \| "change" \| "unlink"` |
| Location | `location.shutdown` | `{}` |
| VCS | `vcs.branch.updated` | `branch?` |
| MCP | `mcp.status.changed`, `mcp.resources.changed` | `server` each |
| PTY | `pty.created`, `pty.updated` | `info: Pty` each |
| | `pty.exited` | `id, exitCode` |
| | `pty.deleted` | `id` |
| Persistent PTY | `persistent-pty.added` | `sessionID, terminal: PersistentPtyInfo` |
| | `persistent-pty.removed` | `sessionID, ptyID` |
| Shell process | `shell.created` | `info: ShellInfo` |
| | `shell.exited` | `id, exit?, status: "running" \| "exited" \| "timeout" \| "killed"` |
| | `shell.deleted` | `id` |
| Compatibility | `session.status` | `sessionID, status: SessionStatus` |
| | `session.idle` | `sessionID`; deprecated schema member, not emitted by current execution producer |
| TUI bridge | `tui.prompt.append` | `text` |
| | `tui.command.execute` | `command: string` |
| | `tui.toast.show` | `title?, message, variant: "info" \| "success" \| "warning" \| "error", duration?` |
| | `tui.session.select` | `sessionID` |
| Installation | `installation.updated`, `installation.update-available` | `version` each |
| Custom RPC | `rpc.${string}` | Contract-defined payload; required location |
| Client transport | `server.connected` | `{}`; client marker, not synthesized by plugin bus host |

Use execution terminal events for completion. Core emits one terminal outcome per busy period, potentially covering coalesced drains, rather than one success per user prompt. `session.usage.recorded` and `session.message.content.updated` are internal/replay-only, absent from this public live stream. LSP/internal workspace events are also outside `EventManifest.ServerDefinitions`. TUI bridge events in the union do not give server context an event-publish or UI-control method.

Sources: `packages/schema/src/event-manifest.ts`, `packages/schema/src/{session-event,session-status-event,form,permission}.ts`, `packages/client/src/promise/generated/types.ts` (`V2Event` and individual payload declarations), `packages/core/src/plugin/host.ts`, `packages/core/src/session/execution.ts`, `packages/plugin/src/promise/adapter.ts`.

## Runtime hook reference

Register `domain.hook(name, callback)`; callbacks mutate the event and return void/Promise<void>. Return values are not replacements. All 18 public hook names appear below. Except `prompt`, every session hook accepts optional third argument `{ providerID?: string }`; AI SDK hooks also accept it. Tool, permission, and shell hooks have no scope argument. There is no plugin priority setting; later callbacks observe earlier edits.

Request base fields: readonly `sessionID/model`; mutable `system: SystemPart[]`, `messages: Message[]`, `options`. Agent-context variants add readonly `agent` and mutable `tools`. Transport fields also have readonly `agent/kind/model/sessionID`, with kind `"primary" | "compaction" | "title" | "generate"`.

| Domain/name | Fires when | Mutable payload | Short-circuit/result | Scope argument |
| --- | --- | --- | --- | --- |
| `session / prompt` | Before attachments/skills resolve and inbox admits user input | `prompt`, `metadata`, `delivery` | None; no typed rejection | None |
| `session / context` | Before each primary agent request/continuation | `system`, `messages`, `options`, `tools` | None | `{ providerID }?` |
| `session / compaction` | Before summary request; summary instruction appended afterward | Context fields plus `result` | Set `{ summary, providerState?, metadata?, tokens? }` to skip model | `{ providerID }?` |
| `session / generate` | Before session-backed transient generation | Context fields | None | `{ providerID }?` |
| `session / title` | Before title generation; no `agent/tools` in this hook | Request fields plus `result` | Set string, including empty string, to skip model | `{ providerID }?` |
| `session / model.request` | After assembled request, before transport options | `baseURL`, `headers` | None | `{ providerID }?` |
| `session / http.request` | Before each native provider HTTP send, including fallback | `request: Request` | Replace request; no response substitution | `{ providerID }?` |
| `session / http.response` | After native provider HTTP response, before driver | `response: Response`; `request` readonly | Replace response | `{ providerID }?` |
| `session / experimental.ws.handshake` | Per model call before socket selection/reuse | `url`, `headers` | Changed identity reopens socket | `{ providerID }?` |
| `session / experimental.ws.send` | After driver builds outbound frame, before write | `frame: string` | Replace verbatim; no stop flag | `{ providerID }?` |
| `session / experimental.ws.receive` | Before driver consumes inbound frame | `frame: string` | Replace verbatim; no stop flag | `{ providerID }?` |
| `session / retry` | After proposed retry classification, before scheduling | `decision: { retry: false } \| { retry: true; delay: number }` | Veto/allow retry or replace delay | `{ providerID }?` |
| `tool / execute.before` | Before tool lookup/validation/execution; inner Code Mode too | `tool`, `input: unknown`; IDs/agent readonly | Effect `Tool.Error` can reject call | None |
| `tool / execute.after` | After executor success/typed failure, before image/truncation pipeline | Completed `result`, or error `error: Tool.Error`; status/input/IDs readonly | No status-arm recovery | None |
| `permission / evaluate` | After rules choose ask/allow; configured deny skips hook | `effect`, `message` | Choose allow/deny/ask | None |
| `shell / create.before` | Before core shell process launch | `command`, `cwd`, `timeout`, `shell`, `env` | None | None |
| `aisdk / sdk` | SDK resolution cache miss | `sdk`; readonly `model/package/options` bindings | Supply SDK; later hooks still run | `{ providerID }?` |
| `aisdk / language` | Language resolution cache miss | `language`; readonly `model/sdk/options` bindings | Supply language; otherwise SDK fallback | `{ providerID }?` |

Retry `attempt` counts the physical attempt under consideration: first retry is 2. Delay is milliseconds; negative/nonfinite values fall back to core's calculated delay. The maximum retry count remains a hard limit. Context-overflow compaction is separate. Prefer `decision = { retry: false }` to throwing for a deliberate retry veto.

Ordinary hook typed failures are `never` in Effect; only `tool.execute.before` permits `Tool.Error`. Promise callbacks use `Effect.promise`, so rejected Promises/thrown values are defects. Runtime failures propagate to the operation and skip later callbacks; the registry does not isolate each plugin or automatically disable it. Catch expected network/parser failures inside your callback and choose the intended policy, rather than assuming generic throw means a structured denial.

Sources: `packages/plugin/src/{promise,effect}/{session,tool,permission,shell,aisdk,registration}.ts`, `packages/core/src/plugin/hooks.ts`, `packages/core/src/{aisdk,permission,shell,tool}.ts`, `packages/core/src/session/{model-request,compaction,title}.ts`, `packages/core/src/session/runner/retry.ts`, `packages/plugin/src/promise/adapter.ts`.

## Expose custom methods over RPC

Use `ctx.rpc.register(definition, handlers)` for custom server methods/events; use callable `ctx.rpc(definition)` to call another local registration. Registrations are scope-owned and independently disposable. TUI calls use `ctx.client.rpc(definition)` on their connected server. Promise contracts use portable Standard Schema/JSON Schema; Effect contracts can also use Effect codecs. Keep contracts in an importable shared module. See [rpc.md](rpc.md) for schemas, error channels, custom events, locations, HTTP clients, and complete recipes.

RPC is the supported extension seam, not an arbitrary HTTP router. Session HTTP hooks intercept provider traffic and do not register incoming routes.

Sources: `packages/plugin/src/{promise,effect}/rpc.ts`, `packages/plugin/src/rpc.ts`, `packages/schema/src/rpc.ts`.

## Verify lifecycle, ordering, and failure behavior

Setup runs once per location activation, not once per server process. A globally configured plugin can have several active location instances. Setup-local maps belong to one activation; module state can be shared across instances; storage is shared by ID. Refcount a genuinely shared resource and stop it after the final owner detaches, or keep it location-local.

Boot order is internal pre plugins, SDK-global plugins, instance-bound plugins, configured external plugins, then internal post config/policy plugins. Registrations follow actual setup order. Later domain transforms see earlier edits; later valid tool/command additions can replace earlier names. Post config can change/remove contributed agents and recreate/re-enable models. Treat a transform as a contribution whose final result you inspect, rather than unconditional final enforcement.

Plugin-generation reload preserves only the unchanged ordered prefix, closes the changed suffix in reverse order, then loads replacements sequentially. Changing an early plugin can rerun later plugins too. Module import failure retains an old active generation when possible. Replacement setup failure closes the failed scope and attempts the previous healthy definition again; that restoration reruns setup. Unchanged failed revisions are not automatically retried.

| Boundary | v2.0.20 behavior |
| --- | --- |
| Module load failure | Warning and failed inventory; previous generation can remain running. |
| Setup failure/defect | Close failed scope, record/log failure; try healthy previous definition if present. |
| Grouped transform throw | Remove all that plugin group's transforms across domains, discard failed candidate, replay without the group; queue inventory/reconciliation/scope cleanup. |
| Runtime hook failure/defect | Propagate to caller; later hooks do not run. No automatic per-plugin isolation. |
| Event consumer failure | Your task/fiber owns catch/retry policy. |
| Healthy unload/replacement | Await scope/returned cleanup; registrations dispose automatically. |

Transform-group removal is synchronous, but hook/fiber/resource cleanup follows queued scope closure; it is not an instantaneous all-behavior kill. Startup batching coalesces notifications/resource work, not registry reads or transactions. A registered MCP server may still be pending or missing its tools.

The inspected setup/cleanup/hook paths have no generic timeout wrapper. Slow setup delays readiness; slow hooks delay operations; slow cleanup delays replacement. Give external IO its own bounded timeout/cancellation and do not block setup on an infinite consumer.

Sources: `packages/core/src/plugin.ts`, `packages/core/src/plugin/{supervisor,internal,module,hooks}.ts`, `packages/core/src/state.ts`, `packages/plugin/src/promise/adapter.ts`.

## Log on the server

There is no `ctx.log`/`ctx.logger`. Promise plugins can use `console`; that output belongs to the server process, not a TUI widget. Native Effect plugins can use `Effect.logDebug/logInfo/logWarning/logError`; activation inherits host loggers/minimum level. Prefix logs with the plugin ID and useful session/location identity, excluding secrets and prompt bodies.

Host structured logs normally land in `~/.local/share/opencode/log/opencode.log`, with server work identified by `role=server`. Console routing depends on launch/stdio handling; do not promise `console.log` reaches that structured file. See [packaging.md](packaging.md) for current launch logs, debugging, and installed-artifact tests.

Max's local dev and publish workflow: the `my-opencode` skill.

Sources: `packages/core/src/plugin.ts`, `packages/util/src/observability/logging.ts`; launcher/console sinks are mapped in [packaging.md](packaging.md).

## Gotchas

- Default-export a definition; returning a v1 hooks object does not register anything.
- Fetch before synchronous transforms, then reload captured changes. Reload does not rerun setup.
- Keep cleanup for failed partial Promise setup as well as normal unload.
- Separate this activation's location from an event/session location, and account for moved sessions.
- Keep domain inputs and output envelopes exact; context is a selected client subset.
- Use `content` for model-visible tool output; declare a schema before returning `output`.
- Preserve built-in executors when their permission behavior matters; tool visibility filtering is not per-call approval.
- Use prompt admission for persisted user edits, request hooks for outgoing edits, TUI/RPC for cosmetic notices.
- Cover auxiliary request kinds and actual transports before claiming a universal model policy.
- Check final transformed inventory, active package revision, and live behavior separately; typechecking proves only API usage.

## Source map

All paths below refer to the v2.0.20 checkout. Published contracts mirror plugin files under `@opencode/plugin/dist/promise/` and `dist/effect/`.

| Read for | Files |
| --- | --- |
| Definition/context/options | `packages/plugin/src/{promise,effect}/plugin.ts`, `packages/plugin/src/{app,options}.ts` |
| Registrations/editors/hook fields | Domain files under `packages/plugin/src/{promise,effect}/`; especially `registration.ts`, `session.ts`, `tool.ts` |
| Async boundary/encoding/signals | `packages/plugin/src/promise/adapter.ts`; `packages/client/src/{promise/api,effect/api/api}.ts` |
| Selected native method behavior/storage | `packages/core/src/plugin/host.ts`, `packages/core/src/kv.ts` |
| Transform replay/failure isolation | `packages/core/src/state.ts`, `packages/core/src/plugin.ts` |
| Loading/location lifecycle/order | `packages/core/src/plugin/{module,supervisor,internal}.ts`, `packages/core/src/plugin.ts` |
| Runtime dispatch | `packages/core/src/plugin/hooks.ts`, `packages/core/src/aisdk.ts` |
| Tool schemas/exposure/validation/truncation | `packages/schema/src/tool.ts`, `packages/core/src/tool.ts`, `packages/core/src/tool/runtime.ts`, `packages/core/src/codemode/{tool,catalog}.ts`, `packages/core/src/tool-output.ts` |
| Request/prompt/auxiliary behavior | `packages/core/src/session/{prompt,model-request,generate,compaction,title}.ts`, `packages/core/src/session/runner/retry.ts`, `packages/ai/src/schema/messages.ts` |
| Permissions/shell policy | `packages/schema/src/permission.ts`, `packages/core/src/{permission,shell}.ts` |
| Skill/MCP/reference/backend shapes | `packages/schema/src/{skill,mcp,reference,vcs,file-diff,websearch}.ts`, `packages/plugin/src/worktree.ts` |
| Worktree strategy ownership | `packages/core/src/worktree.ts`, `packages/core/src/worktree/strategies.ts`, `packages/core/src/plugin/host.ts` |
| Event types versus producers | `packages/schema/src/{event-manifest,session-event,session-status-event}.ts`, `packages/client/src/promise/generated/types.ts`, `packages/core/src/session/execution.ts` |
| Plugin/client RPC | `packages/plugin/src/{promise,effect}/rpc.ts`, `packages/schema/src/rpc.ts`; [rpc.md](rpc.md) |
| Built-ins worth reading | `packages/core/src/plugin/{command,verbosity,plan}.ts`, `packages/core/src/tool/plugin/question.ts`; private service imports are not public APIs |
| Guides to compare against current declarations | `services/www/src/docs/content/build/plugins/{index,effect}.mdx`, `packages/plugin/src/README.md`, `packages/plugin/src/effect/README.md`; `effect/PLAN.md` is an obsolete plan |
