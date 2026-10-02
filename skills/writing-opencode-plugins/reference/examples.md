Verified against OpenCode v2.0.20 (@opencode/plugin 2.0.20).

# Examples and reusable patterns

## Find a plugin like yours

Read the implementation named below, then its `package.json` and adjacent tests. These are source-verified v2 implementations, not a claim that every plugin feature passed a live v2.0.20 test. Older SDK pins and compatibility adapters need review before copying. API details belong in [server.md](server.md), [tui.md](tui.md), [providers.md](providers.md), [rpc.md](rpc.md), and [packaging.md](packaging.md).

Paths for Max's monorepo are relative to the linked plugin folder; other paths are repository-relative. URLs name source folders, not installation specifications.

| Task | Example and source URL | One file to read | What to copy or check |
| --- | --- | --- | --- |
| Small sidebar item showing session identity | session-id-badge: https://github.com/MaxAnderson95/my-opencode-setup/tree/main/plugins/session-id-badge | `tui.tsx` | Slot input supplies the displayed session ID; setup returns the slot disposer. |
| Sidebar showing background jobs or child sessions | background-jobs: https://github.com/MaxAnderson95/my-opencode-setup/tree/main/plugins/background-jobs | `tui.tsx` | Combine tool metadata, shell inventory, and child execution status; a completed tool call can own running background work. |
| Slash command with arguments | session-resume: https://github.com/MaxAnderson95/my-opencode-setup/tree/main/plugins/session-resume | `tui.tsx` | Mount a headless `app` controller, register a keymap layer, sync then navigate. |
| Slash command acting on the current session | session-delete: https://github.com/MaxAnderson95/my-opencode-setup/tree/main/plugins/session-delete | `tui.tsx` | Route-dependent command registration, confirmation, full TUI client call, JSON-body error handling. |
| Slash command making an external decision without a model turn | jev: https://github.com/MaxAnderson95/my-opencode-setup/tree/main/plugins/jev | `tui.tsx` | Per-session in-flight guard, current-session evidence, local toast/dialog result. |
| Tool the model calls directly | callout: https://github.com/MaxAnderson95/my-opencode-setup/tree/main/plugins/callout | `callout.ts` | Complete tool definition through `tool.transform`; `codemode: false` is an explicit exposure choice. Its file bridge is local-only. |
| Extend an existing tool's input | question-anything-else: https://github.com/MaxAnderson95/my-opencode-setup/tree/main/plugins/question-anything-else | `anything-else.ts` | Idempotent `execute.before` input edit keeps the built-in question/form path. |
| React to execution finishing or requesting attention | notifier: https://github.com/mohak34/opencode-notifier/tree/main/src | `src/v2.ts` | Execution/form/permission events, directory plus workspace filtering, bounded replay deduplication, abort-and-await cleanup. |
| Push notification on events; reuse another plugin | hark: https://github.com/MaxAnderson95/my-opencode-setup/tree/main/plugins/hark | `hark.ts` | Debounce completion, suppress child notices, import declared presence dependency, own the event pump. |
| Timer in a prompt footer | elapsed-timer: https://github.com/MaxAnderson95/my-opencode-setup/tree/main/plugins/elapsed-timer | `tui.tsx` | Setup owns start times; the mounted footer owns only its busy heartbeat. Check packaged TSX behavior. |
| Background timer shared across location instances | token-refresh: https://github.com/MaxAnderson95/my-opencode-setup/tree/main/plugins/token-refresh | `lib/loop.ts` | Refcount attached contexts, one timer chain, stop on last detach. This is for a genuinely process-shared resource. |
| Terminal escape output | ghostty-progress: https://github.com/MaxAnderson95/my-opencode-setup/tree/main/plugins/ghostty-progress | `tui.tsx` | Run terminal effects in the TUI; direct fd output avoids captured `stdout` writes. |
| System prompt or native message editing | DCP: https://github.com/Tarquinen/opencode-dynamic-context-pruning/tree/master/lib/v2 | `lib/v2/index.ts` | Session-keyed queues and outgoing context/compaction edits. Root supports both generations; study the v2 implementation. |
| Cache-stable memory instructions | agent memory: https://github.com/joshuadavidthomas/opencode-agent-memory/tree/main/src | `src/plugin.ts` | Freeze memory snapshots per session/compaction generation; isolate concurrent request metadata. |
| Request-local tool filtering | GPT-Live: https://github.com/malhashemi/opencode-gpt-live/tree/main/src/server | `src/server/index.ts` | Change `event.tools` for context/generate/compaction without removing global tool definitions. |
| OAuth on an existing integration | Claude auth: https://github.com/MaxAnderson95/opencode-claude-auth/tree/main/src | `src/v2-setup.ts` | Register authorize/refresh methods; let core own credentials; request/response hooks correlate rewritten requests. Root/server are v2; `src/index.ts` contains retained v1 code. |
| Browser and headless OAuth in upstream | OpenAI built-in: https://github.com/anomalyco/opencode/tree/v2.0.20/packages/core/src/plugin/provider | `packages/core/src/plugin/provider/openai.ts` | Browser callback, headless method, refresh, account-dependent model policy. Internal services are not public plugin APIs. |
| Discover models and refresh an inventory | model discovery: https://github.com/yuhp/opencode-models-discovery/tree/dev/src/v2 | `src/v2/catalog.ts` | Fetch outside the transform; capture inventory; replay synchronous edits and reload. |
| Filter provider/model lists | models.dev built-in: https://github.com/anomalyco/opencode/tree/v2.0.20/packages/core/src/plugin | `packages/core/src/plugin/models-dev.ts` | Filter immutable source snapshots before publishing inventories. Read internal service calls as host implementation, not an external template. |
| Modify active model policy | Claude auth: https://github.com/MaxAnderson95/opencode-claude-auth/tree/main/src | `src/v2-setup.ts` | Capture credential ownership, edit model costs synchronously, reload when credential events change ownership. |
| Native question form initiated by server code | overage-guard: https://github.com/MaxAnderson95/my-opencode-setup/tree/main/plugins/overage-guard | `lib/host.ts` | HTTP form creation and same-process server checks. Its get/cancel paths and HTTP-only coverage need correction for v2.0.20; see gaps below. |
| Change a permission evaluation without overriding deny | Supermemory: https://github.com/supermemoryai/opencode-supermemory/tree/main/src/v2 | `src/v2/runtime.ts` | Change only a matching `ask` to `allow`. **V1 root**, v2 `./server` and `./v2`. |
| Small server/TUI RPC service | Codex usage: https://github.com/jasonmit/opencode-codex-usage/tree/main | `opencode2.ts` | Share one read function between tool and RPC; clean partial setup. **V1 root/server/tui**, v2 `./opencode2` and `./opencode2/tui`. |
| Server-owned feature with terminal-local resources | GPT-Live: https://github.com/malhashemi/opencode-gpt-live/tree/main/src/tui | `src/tui/index.ts` | Server owns credentials/session operations; TUI owns audio helper, keymaps, panels, and frame cleanup. |
| Durable host storage and independent Effect runtime | Recall: https://github.com/MaxAnderson95/opencode-recall/tree/main/packages/plugin/src | `packages/plugin/src/index.ts` | Promise host boundary, own managed runtime, cleanup after failed setup as well as unload. |
| State file on disk | callout: https://github.com/MaxAnderson95/my-opencode-setup/tree/main/plugins/callout | `state.ts` | Temp-file write then rename. Atomic replacement alone does not serialize concurrent writers. |
| Edit a core-owned preference file carefully | model-favorites: https://github.com/MaxAnderson95/my-opencode-setup/tree/main/plugins/model-favorites | `favorites.ts` | Preserve unknown fields, serialize writes, coordinate with core's file lock. Private file-format coupling needs host-version checks. |
| Persistent TUI settings | bee-gee: https://github.com/parthkhxndelwal/bee-gee/tree/main | `tui.tsx` | `storage.store` initialized from options. Copy the storage mechanism, not its `any` casts or older theme names. |
| Hide/modify host UI without a slot | question-minimize: https://github.com/MaxAnderson95/my-opencode-setup/tree/main/plugins/question-minimize | `tui.tsx` | Form mode, render-tree lookup, reversible visibility mutation. Host-layout coupling requires installed-runtime tests. |
| Port a v1 tool family | PTY: https://github.com/shekohex/opencode-pty/tree/main/src/v2 | `src/v2/tools.ts` | Migration adapter only. **V1 root/server**, v2 `./v2`. New plugins should author v2 tools directly and preserve cancellation. |
| Effect-scoped RPC plus tool resources | Browser: https://github.com/anomalyco/opencode/tree/v2.0.20/packages/plugin-browser/src | `packages/plugin-browser/src/connection.ts` | Per-session attachment ownership, acquire/release, scoped event consumer, typed RPC errors. |
| Apply one request policy to every request kind | Verbosity built-in: https://github.com/anomalyco/opencode/tree/v2.0.20/packages/core/src/plugin | `packages/core/src/plugin/verbosity.ts` | Register context, compaction, generate, and title explicitly. Its model service is internal. |

## Reusable patterns

The snippets below are small adaptations, typechecked against 2.0.20. They illustrate ownership and composition; use the linked references for complete API signatures.

### Keep state with its owner

Use setup-local maps keyed by session ID for running work. Use server `ctx.storage` for durable JSON. Follow every storage scan cursor, as Recall's `packages/plugin/src/storage.ts` does:

```ts
import type { Plugin } from "@opencode/plugin"

export async function readQueue(ctx: Pick<Plugin.Context, "storage">) {
  const entries = []
  let after: string | undefined
  do {
    const page = await ctx.storage.scan({ prefix: "dirty/", after })
    entries.push(...page.entries)
    after = page.next
  } while (after !== undefined)
  return entries
}
```

`storage.set` replaces one key. The public storage domain has no transaction or compare-and-set method. Recall gives each observed work item its own key and lets the receiving hub deduplicate uploads; it does not implement a lease with `get` followed by `set`. GPT-Live uses durable `link/<sessionID>` keys for voice-session links.

Use TUI `storage.memory` for state that survives plugin hot reload until TUI exit, and `storage.store` for durable TUI settings. Updates to the durable store return a Promise. Message-timestamps uses memory; bee-gee uses store. They are separate from server storage:

```tsx
/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { Show } from "solid-js"

export default Plugin.define({
  id: "example.state",
  setup(ctx) {
    const [seen, update] = ctx.storage.memory("seen", { initial: { count: 0 } })
    const [settings] = ctx.storage.store("settings", { initial: { enabled: true } })
    const off = ctx.data.on("session.execution.succeeded", () => {
      update((draft) => { draft.count += 1 })
    })
    const release = ctx.ui.slot({
      append: "sidebar.content",
      render: () => (
        <Show when={settings.enabled}>
          <text>{seen.count}</text>
        </Show>
      ),
    })
    return () => { off(); release() }
  },
})
```

The host runs a slot's render body once, untracked (`packages/tui/src/plugin/render.tsx`). A top-level `settings.enabled ? ... : null` in the render function is evaluated once and never updates; put conditions in `<Show>` or JSX expressions so Solid tracks them. Setup owns the listener, so the slot remounting does not create another subscription or request. Elapsed-timer similarly keeps execution start times above the transient footer while the component owns only its heartbeat.

Local disk bridges in callout and todo assume server and TUI see the same path. Use RPC for a remote client. Atomic rename protects readers from a partial file, but callout's PID-only temporary name does not protect simultaneous writes in one process. Model-favorites adds a unique temporary name, write queue, and lock because it edits a shared core-owned document.

### Start subscriptions without blocking setup; abort and await cleanup

Hark and caffeinate own reconnecting Promise consumers. Notifier aborts and awaits its consumer without a plugin-owned retry loop. Browser uses an Effect-scoped consumer. Pick a reconnect policy and a missed-event repair policy explicitly:

```ts
import { Plugin } from "@opencode/plugin"
import { setTimeout as delay } from "node:timers/promises"

export default Plugin.define({
  id: "example.events",
  setup(ctx) {
    const abort = new AbortController()
    const task = (async () => {
      while (!abort.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
            if (event.type === "session.execution.succeeded") {
              await ctx.storage.set(`finished/${event.data.sessionID}`, event.created)
            }
          }
        } catch (error) {
          if (!abort.signal.aborted) console.warn("example.events: subscription failed", error)
        }
        if (!abort.signal.aborted) {
          await delay(1000, undefined, { signal: abort.signal }).catch(() => {})
        }
      }
    })()
    return async () => { abort.abort(); await task }
  },
})
```

The retry delay is cancellation-aware. The example records observed successes only; it does not recover events lost during disconnect. Recall repairs missed events with reconciliation and periodic sweeps. Caffeinate stops owned processes when its stream ends. TUI `data.on`/`data.listen` return unsubscribe callbacks instead of async iterators.

### Validate options in setup

Decode untrusted options once before registering behavior. `Plugin.define` accepts `id` and `setup`; it has no declarative options-schema member. Question-minimize checks its keybind manually; elapsed-timer and session-id-badge check `enabled`. This schema version is an adaptation for a plugin that already depends on Effect:

```ts
import { Plugin } from "@opencode/plugin"
import { Schema } from "effect"

const Options = Schema.Struct({ enabled: Schema.optional(Schema.Boolean) })

export default Plugin.define({
  id: "example.options",
  async setup(ctx) {
    const options = Schema.decodeUnknownSync(Options)(ctx.options)
    if (options.enabled === false) return
    await ctx.session.hook("context", (event) => {
      event.system.push({ type: "text", text: "Keep changes within the requested scope." })
    })
  },
})
```

The default is enabled; malformed `enabled` fails setup. Use an existing validator or direct parsing when the plugin has no schema dependency. Options and environment variables are different contracts: Hark reads webhook configuration from the environment; Recall reads a host-wide configuration file.

### Import helpers through the other package's public boundary

Hark declares the presence package and dynamically imports its exported `presence` helper. Loading presence as a host plugin is not what makes the helper importable. The helper must ship in the installed dependency.

Hark's manifest contains this verified dependency fragment:

```json
{
  "dependencies": {
    "oc-plugin-presence": "github:MaxAnderson95/my-opencode-setup#plugin-presence"
  }
}
```

Read `plugins/hark/hark.ts` for the actual import and failure policy. Relative imports stay inside a package; `../presence/presence.ts` cannot work when Hark's standalone package omits that sibling. Dependency imports, RPC calls, and hook load order solve different problems. Claude auth and overage-guard coordinate hook order without importing one another.

### Fetch outside transforms; reload after captured data changes

Model discovery's `src/v2/catalog.ts` stores an inventory in a closure, synchronously edits the provider editor, and reloads after replacing inventory. MCP-lazy applies the same mechanism to its location-scoped enabled map. Claude auth captures account ownership before editing model costs.

```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "example.models",
  async setup(ctx) {
    const excluded = new Set<string>()
    await ctx.model.transform((editor) => {
      for (const model of editor.list()) {
        if (excluded.has(`${model.providerID}/${model.id}`)) editor.remove(String(model.providerID), String(model.id))
      }
    })
    await ctx.tool.transform((editor) => editor.add({
      name: "example_hide_model",
      description: "Hide the caller's selected model from future catalogs",
      input: { type: "object", properties: {}, additionalProperties: false },
      async execute(_, call) {
        const session = await ctx.session.get({ sessionID: call.sessionID })
        if (!session.model) return { content: "No session model is selected." }
        excluded.add(`${session.model.providerID}/${session.model.id}`)
        await ctx.model.reload()
        return { content: "Model catalog reloaded." }
      },
    }))
  },
})
```

The explicit string conversion handles the SDK's deep-mutable branded model IDs. The tool context has no `model` member; read the session or use a request hook's model. This example changes future location catalogs, not an already-captured request snapshot. A transform callback is synchronous and replayable; async fetches inside it are not awaited by its contract.

### Choose the Promise or Effect boundary deliberately

Use Promise setup for ordinary async code. Callout, notifier, agent memory, and Claude auth use it. Use native Effect plugins when sharing the host's Effect contract and scope is intentional. Browser is the public upstream example; built-in plugins may depend on private core services.

```ts
import { Plugin } from "@opencode/plugin/effect"
import { Effect, Stream } from "effect"

export default Plugin.define({
  id: "example.effect",
  effect: (ctx) => Effect.gen(function* () {
    yield* ctx.event.subscribe().pipe(
      Stream.filter((event) => event.type === "session.execution.succeeded"),
      Stream.runForEach((event) => ctx.storage.set(`finished/${event.data.sessionID}`, event.created)),
      Effect.forkScoped,
    )
  }),
})
```

Here the host's scope owns the consumer. Stream failure still needs the plugin's chosen logging/retry policy. Native Effect setup exposes `effect`, not `setup`.

Recall keeps its own Effect version behind Promise APIs and owns a managed runtime. Clean that runtime on initialization failure as well as successful unload:

```ts
import { Plugin } from "@opencode/plugin"
import { Effect, Layer, ManagedRuntime } from "effect"

export default Plugin.define({
  id: "example.promise-effect",
  async setup(ctx) {
    const runtime = ManagedRuntime.make(Layer.empty)
    try {
      await ctx.tool.transform((editor) => editor.add({
        name: "example_ready",
        description: "Check readiness",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: (_, call) => runtime.runPromise(Effect.succeed({ content: "Ready" }), { signal: call.signal }),
      }))
    } catch (error) {
      await runtime.dispose()
      throw error
    }
    return () => runtime.dispose()
  },
})
```

`Layer.empty` stands in for the plugin's real services. Pass the tool's signal to cancellable work. Returning cleanup does not protect resources already started if setup throws before returning it.

### Split server ownership and TUI presentation with a shared RPC module

GPT-Live, Claude auth, and Codex usage keep a contract import separate from server initialization. Server owns credentials/state; TUI owns renderer, commands, and local notices. This minimal split performs one status read in setup, never in a slot render.

`rpc.ts`:

```ts
import { Rpc } from "@opencode/plugin/rpc"

export const Status = Rpc.define({
  id: "example.status",
  methods: {
    ready: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: { type: "boolean" },
    },
  },
  events: {},
})
```

`server.ts`:

```ts
import { Plugin } from "@opencode/plugin"
import { Status } from "./rpc"

export default Plugin.define({
  id: "example.status",
  async setup(ctx) {
    await ctx.rpc.register(Status, { ready: async () => true })
  },
})
```

`tui.tsx`:

```tsx
/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { Show } from "solid-js"
import { Status } from "./rpc"

export default Plugin.define({
  id: "example.status",
  setup(ctx) {
    let active = true
    const [state, update] = ctx.storage.memory("status", { initial: { ready: false } })
    const location = ctx.location ?? ctx.data.location.default()
    void ctx.client.rpc(Status).ready({}, { location }).then((ready) => {
      if (active) update((draft) => { draft.ready = ready === true })
    }).catch((error) => { if (active) console.warn("example.status: RPC failed", error) })
    const release = ctx.ui.slot({
      append: "prompt.footer.status",
      render: () => (
        <Show when={state.ready}>
          <text>Ready</text>
        </Show>
      ),
    })
    return () => { active = false; release() }
  },
})
```

Use schema-backed methods for stronger inferred RPC values; raw JSON Schema values are not a reason to cast arbitrary responses. Export the TUI entry as `./tui` and make the server entry discoverable; see [packaging.md](packaging.md). For TUI-only server-advertised packages, session-id-badge uses a harmless server definition with the same ID. Cosmetic RPC events/toasts can stay outside model history; `session.synthetic` enters context and `session.prompt` admits user work.

## Max's conventions

These describe the checked repositories, not SDK requirements:

- `my-opencode-setup` has one self-contained `plugins/<name>/` package with its own manifest, entrypoint, declared dependencies, and usually a local tsconfig. Helper imports stay within that package.
- Small packages ship ESM TypeScript source; TUI packages declare `./tui`. Many TUI-only features have no-op server definitions for discovery. Claude auth explicitly exports its v2 source for root/server while retaining legacy subpaths.
- Manifests pin the SDK instead of using a wildcard SDK peer. Existing small packages mostly pin 2.0.4; newer ones pin 2.0.14. Those are historical compatibility coordinates, not the 2.0.20 target for new snippets.
- Shipped TSX entries carry `/** @jsxImportSource @opentui/solid */`; TUI packages declare OpenTUI/Solid peers. Package-local tsconfigs vary, so do not assume one universal root configuration.
- Small plugin tests use `bun test`, often colocated pure-helper tests or a narrow fake host calling actual setup. MCP-lazy documents `bun test plugins/mcp-lazy` and `./node_modules/.bin/tsc -p plugins/mcp-lazy/tsconfig.json`. Recall also uses Bun tests; Claude auth uses Node's test runner and pnpm scripts.
- Tests can inject real varying boundaries: a temporary store root, timer/clock, webhook request, or quota probe. They do not prove installed TUI rendering, OAuth success, notification delivery, or remote filesystem equivalence.

Max's local dev and publish workflow: the `my-opencode` skill.

## Known upstream gaps and workarounds

| Requirement | Confirmed v2.0.20 boundary | Example and consequence |
| --- | --- | --- |
| Arbitrary permission ask | Promise `PermissionDomain` exposes `list`, `get`, `reply`, and evaluation hooks, with no standalone `ask`. | DCP refuses its unsupported custom ask path. Use the host tool permission pipeline when it fits; never silently perform denied work. Source: `packages/plugin/src/promise/permission.ts`. |
| Native form creation through server context | Server context has no form domain, and its selected session API omits `form`. Full clients expose `session.form`. | Overage-guard uses authenticated HTTP to its owning server. Its POST creation route matches 2.0.20, but its GET `.../state` and POST `.../cancel` do not match the current GET/DELETE `.../form/:formID` contract. Current GET returns a form detail containing `state`, not a bare state. Do not copy the old paths or response shape. Sources: `packages/plugin/src/promise/plugin.ts`, `packages/plugin/src/promise/session.ts`, `packages/protocol/src/groups/session.ts`, `packages/schema/src/form.ts`. |
| Full transcript/session enumeration through server context | There is no top-level message domain; the selected session API lacks `list`/`remove`/form methods, but **does include `context` and `wait`**. | Hark accumulates text events; Recall isolates full-history SQLite reads in `source.ts`. Prefer public `session.context` when it meets the requirement. TUI `ctx.client` has a broader generated-client API. |
| Per-assistant footer or native form slot | `SlotMap` has neither. `session.composer.top` and `prompt.footer.status` are supported placements. | Message-timestamps uses a sidebar; question-minimize reversibly hides a host renderable using form mode and parent children. Treat its layout lookup as version-coupled. Source: `packages/plugin/src/tui/context.ts`, `packages/tui/src/routes/session/form.tsx`. |
| Arbitrary sidebar numeric order | Slot claims have relative placement keys and coexist in plugin enable order; there is no numeric order field. | Session-id-badge prepends and todo appends. Neither restores a v1 middle-of-sidebar order. Source: `packages/plugin/src/tui/context.ts`. |
| Built-in model picker highlighted row/favorite writer | Public `UI.model` exposes the prompt's selected model and variants, not picker highlight or a favorites mutation API. | Model-favorites owns its dialog and edits the core preference document with locking. `ui.model.current()` is public in 2.0.20, so Claude auth's older optional type shim is unnecessary for a 2.0.20-only plugin. |
| Default free-text answer through question input | The built-in question executor's `toField` maps prompt/options and sets `custom: true`; it does not forward a text default. | Question-anything-else supplies an ordinary "Nothing else" option. An invented tool-input field will not reach the form. Source: `packages/core/src/tool/plugin/question.ts`. |
| Same reactive behavior for local and installed raw TSX | OpenTUI 0.5.12's Solid transform excludes `node_modules` source paths. | Model-favorites/message-timestamps use function children; question-minimize keeps its anchor JSX static and changes visibility imperatively. Test the installed path and updates, not only first paint. Sources: `opentui@v0.5.12:packages/solid/scripts/solid-plugin.ts`, OpenCode `packages/tui/src/plugin/runtime-plugin-support.bun.ts`. |
| Model-invisible server notice | Synthetic messages are session input, not a display-only transcript facility. | Supermemory emits cosmetic RPC events; Codex usage shows terminal-local toasts. Keep display requirements separate from prompt admission. Source: `packages/plugin/src/promise/session.ts`, `packages/schema/src/session-inbox.ts`. |

### HTTP hooks do not disable WebSockets

In `packages/core/src/session/model-request.ts`, OpenCode builds an HTTP wrapper when matching HTTP hooks exist. Independently, it binds a WebSocket when session transport is requested and the model uses WebSockets. It returns both available transports; the selected route decides which carries traffic. HTTP hooks still cover HTTP fallback.

Overage-guard registers only `http.request` and `http.response`; it has no WebSocket hooks. Its README assertion that registering HTTP hooks forces Codex onto HTTP conflicts with v2.0.20 source. An HTTP-only gate does not cover a request carried by WebSocket. This is a source-level finding, not a new live billing or WebSocket test. See the experimental WebSocket hooks in [server.md](server.md) before claiming transport-wide interception.

### Drop obsolete workaround premises

Use current types rather than earlier-beta handwritten capability shims. Current server context has MCP, separate provider/model domains, and session context reads. Current session rename is `session.update`, not the docs' `session.rename` example. Native commands have an editor `add`; arbitrary startup sleeps and delayed name reclamation from old ports are not a default recipe. See [migrate-v1.md](migrate-v1.md).

This catalog omits unconfirmed current-host claims about Git subdirectory installation, stale module caching, mandatory startup retries, and old-beta runtime module mapping. Package source, published artifact, installed revision, active registration, and live behavior remain separate verification stages.

## Gotchas

- Read the exact v2 export; a v2 implementation in a repository does not make its v1 root a v2 plugin.
- Keep event consumers, timers, RPC subscriptions, and expensive synchronization outside repeatedly remounted rendering. Return resource cleanup and protect partial setup.
- Mount TUI keymap layers under a component owner, as session-resume's `app` claim does. Avoid borrowed host command IDs that inherit unrelated configured bindings.
- A server's location, an event's location, and the currently displayed session can differ. Scope state by the operation's session/location and account for session moves.
- MCP connection status and tool registry readiness are separate; MCP-lazy reports both. Neither proves a remote tool executes successfully.
- Typechecking these examples verifies API usage only. Installed rendering, network reconnects, remote clients, and external-service behavior need their own tests.

## Source map

- OpenCode v2.0.20: `packages/plugin/src/promise/{plugin,session,permission,storage,tool,rpc}.ts`, `packages/plugin/src/effect/plugin.ts`, `packages/plugin/src/options.ts`, `packages/plugin/src/tui/{plugin,context}.ts`; published `@opencode/plugin` declarations for the same entrypoints.
- Host behavior: `packages/core/src/session/model-request.ts`, `packages/core/src/tool/plugin/question.ts`, `packages/core/src/plugin/{models-dev,verbosity}.ts`, `packages/core/src/plugin/provider/openai.ts`, `packages/plugin-browser/src/{index,connection,rpc,tools}.ts`, `packages/protocol/src/groups/session.ts`, `packages/client/src/promise/generated/client.ts`, `packages/tui/src/plugin/runtime-plugin-support.bun.ts`, `packages/tui/src/context/keymap.tsx`.
- OpenTUI v0.5.12: `packages/solid/scripts/solid-plugin.ts`.
- Max's monorepo: `README.md`, each indexed `plugins/<name>/package.json` and implementation, `plugins/hark/{hark,delivery}.ts`, `plugins/token-refresh/lib/loop.ts`, `plugins/callout/state.ts`, `plugins/model-favorites/favorites.ts`, `plugins/overage-guard/{overage-guard.ts,lib/host.ts}`.
- Claude auth: `package.json`, `src/{v2,v2-setup,oauth,usage-limit}.ts`, `src/tui.tsx`; Recall: `packages/plugin/src/{index,storage,uploader,source}.ts` and `docs/adr/0001-effect-v4-and-effect-schema.md`.
- Third-party source reads: notifier `295ae63` (`src/v2.ts`); agent memory `608ff39` (`src/plugin.ts`); model discovery `e2495bf` (`src/v2/catalog.ts`); DCP `f8232fd` (`lib/v2/index.ts`); GPT-Live `v0.1.1` (`src/server/index.ts`, `src/tui/index.ts`); Supermemory `4271adf` (`package.json`, `src/server.ts`, `src/v2/runtime.ts`); Codex usage `2c708e6` (`package.json`, `opencode2.ts`); PTY `9be5126` (`package.json`, `src/v2/{index,tools}.ts`); bee-gee `d4bf68d` (`tui.tsx`). Branch URLs above can move; recheck before copying.
