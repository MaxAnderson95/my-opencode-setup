Verified against OpenCode v2.0.20 (@opencode/plugin 2.0.20).

# Connect plugins and clients with RPC

## Choose RPC for server-owned operations

Use RPC for typed methods and live events shared by a server plugin, its terminal half, other plugins, or external clients. Implement methods on the server. TUI clients call methods and receive events; the TUI context has no RPC-handler registration API. Register a model-facing tool separately when the model should invoke an operation; an RPC method alone is not a tool.

| Caller or implementation | API |
| --- | --- |
| Promise server handler | `await ctx.rpc.register(contract, handlers)` |
| Effect server handler | `yield* ctx.rpc.register(contract, handlers)` |
| Server plugin calling another server plugin | `ctx.rpc(contract).method(input)` |
| TUI half | `ctx.client.rpc(contract).method(input, { location })` |
| Network client | `OpenCode.make(...)` from `@opencode/client`, then `client.rpc(contract)` |
| Embedded Promise SDK | `OpenCode.create(...)` from `@opencode/sdk`, then the returned host's `rpc(contract)` |
| Raw HTTP | `POST /api/rpc/:rpcID/:method` with `{ "input": ... }` |

Server registrations are Location-scoped. The RPC ID and plugin ID are separate identifiers; one plugin can register several RPC contracts. The registry keeps a stack per RPC ID: last registered wins, and disposing that registration reveals the previous one. Give contracts namespaced IDs to avoid accidental overrides.

## Define a shared contract with required schemas

Put an inert contract in `rpc.ts` and export it through package `./rpc`. Importing the contract must not start the server implementation. For package layouts and local directory bridges, see [packaging.md](packaging.md).

`Rpc.define` accepts `{ id, methods, events }`. Each method has **required** `input` and `output` schemas plus optional `errors`; each event has `{ schema }`. Use `events: {}` when there are no events. Method name `events` is reserved by the client shape. Error names beginning `rpc.` are reserved by `Rpc.define`.

The docs say input/output can be omitted. The v2.0.20 source and declarations require both, and runtime dispatch parses/encodes them unconditionally. Use explicit void schemas, such as `z.void()` for portable contracts or `Schema.Void` for Effect contracts, instead of leaving a schema out.

| Schema kind | Accepted by | Type behavior |
| --- | --- | --- |
| JSON Schema | Promise/Effect server and clients | Method values infer as `unknown`; event data is an object record |
| Standard Schema, for example Zod | Promise/Effect server and clients | Infer method input/output and event data |
| Effect codec | Effect server and Effect client | Decode handler input and encode output/errors/events; clients decode encoded results |

Promise and TUI APIs require `Rpc.PortableDefinition`: JSON Schema or Standard Schema, rather than Effect codecs. A shared contract used by the Promise TUI must stay portable even if the server implementation uses Effect.

Event data must be an object. Use an empty object schema and `{}` for an empty event. Scalars, arrays, null, and undefined are outside the event contract. Standard Schema validates outputs forward; Effect codecs encode handler results. For transforming schemas, distinguish handler-decoded values from client-encoded inputs. Ground truth: `packages/schema/src/rpc.ts` and `packages/core/src/rpc.ts`.

## Build a combined server and TUI plugin

This complete example uses Zod's Standard Schema implementation for inferred types. Declare Zod as a direct dependency when adopting it; the combined manifest in [packaging.md](packaging.md) pins it. The counter state belongs to one server setup and resets on reload. Replace that state with storage only if persistence is required.

### `rpc.ts`: contract

```ts
import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"

const Value = z.object({ value: z.number().int() })

export const Counter = Rpc.define({
  id: "example.counter",
  methods: {
    read: { input: z.object({}), output: Value },
    increment: {
      input: z.object({ amount: z.number().int() }),
      output: Value,
      errors: { invalid_amount: z.object({ amount: z.number() }) },
    },
  },
  events: { changed: { schema: Value } },
})
```

### `server.ts`: handlers and event emission

Promise handlers receive `(decodedInput, { signal, error })` and return a Promise of output or a declared error. Pass `signal` to cancellable I/O. Return or throw `call.error(name, message, data)` for expected failures.

```ts
import { Plugin } from "@opencode/plugin"
import { Counter } from "./rpc.js"

export default Plugin.define({
  id: "example.counter.server",
  async setup(ctx) {
    let value = 0
    const registration = await ctx.rpc.register(Counter, {
      read: async () => ({ value }),
      increment: async ({ amount }, call) => {
        if (amount <= 0) return call.error("invalid_amount", "Use a positive amount", { amount })
        value += amount
        const result = { value }
        await registration.events.emit("changed", result)
        return result
      },
    })
  },
})
```

Registrations belong to plugin lifetime automatically. Call `await registration.dispose()` to remove one early. Event emission validates the payload before publishing; a publishing failure does not undo earlier application state changes.

### `tui.ts`: connected-server call and subscription

Use `ctx.client`, not a new independently discovered server client. Select the Location explicitly and filter events separately. Return the unsubscribe function; clean it up on setup failure as well.

```ts
import { Plugin } from "@opencode/plugin/tui"
import { Counter } from "./rpc.js"

export default Plugin.define({
  id: "example.counter.tui",
  async setup(ctx) {
    const location = ctx.location ?? ctx.data.location.default()
    const counter = ctx.client.rpc(Counter)
    const stop = counter.events.on("changed", (event) => {
      if (event.location.directory !== location.directory) return
      ctx.ui.toast.show({ message: `Counter: ${event.data.value}`, variant: "info" })
    })
    try {
      const initial = await counter.read({}, { location })
      ctx.ui.toast.show({ message: `Counter ready: ${initial.value}`, variant: "info" })
    } catch (error) {
      stop()
      throw error
    }
    return stop
  },
})
```

Configure the package/directory in server `opencode.json(c)`. Active inventory advertises its TUI feature, which the terminal resolves locally without installing inventory-derived targets. A same-machine combined install needs only the server entry; remote setups must also make the terminal package available locally, as described in [packaging.md](packaging.md). The TUI example captures a Location once; follow [tui.md](tui.md)'s reactive component guidance for interfaces that must follow later Location changes. The initial method result reads current state without assuming the event listener attached before the first response. This example does not provide an atomic snapshot/subscription protocol.

## Call from another server plugin

Call through `ctx.rpc(contract)` in the same Location. Local calls use the server registry, not HTTP; Promise call options permit `signal`, not Location or request headers. Order the provider plugin before a caller that calls during setup. Runtime callers must handle an unavailable provider after disable/reload/failure.

```ts
import { Plugin } from "@opencode/plugin"
import { Counter } from "./rpc.js"

export default Plugin.define({
  id: "example.counter.caller",
  async setup(ctx) {
    const counter = ctx.rpc(Counter)
    const result = await counter.increment({ amount: 1 })
    await ctx.storage.set("last-value", result.value)
  },
})
```

In a separate package, import the contract from the provider's exported `/rpc` subpath. The example's increment runs on every setup, so use a read method instead when startup must not mutate state.

## Call from HTTP clients and the SDK

Use the generated network client `@opencode/client` for HTTP. Supply the intended server URL and its existing authentication headers. Import only the shared contract in external applications.

```ts
import { OpenCode } from "@opencode/client"
import { Counter } from "./rpc.js"

export async function increment(baseUrl: string, directory: string, headers: Record<string, string>) {
  const client = OpenCode.make({ baseUrl, headers })
  try {
    return await client.rpc(Counter).increment({ amount: 1 }, { location: { directory } })
  } catch (error) {
    if (typeof error === "object" && error !== null && "type" in error && error.type === "invalid_amount") {
      console.error("Counter rejected the amount")
    }
    throw error
  }
}
```

Method options accept `location`, `signal`, and `headers`. The generated client's lower-level `client.rpc.call` also remains available for dynamic RPC ID/method calls without a typed contract. Runtime input validation comes from the registered server definition, not the caller's TypeScript contract.

For the embedded SDK, the Promise `OpenCode.create({ plugins })` result includes the same network-client-shaped `rpc` API, backed by the embedded host's fetch implementation rather than an HTTP listener. Pass server definitions in its plugin list or register one through its `plugin` callable, then call `host.rpc(contract)` and close the host when finished. Verify this API in `packages/sdk/src/promise.ts`; it is distinct from `@opencode/plugin/host`, which only resolves/imports files.

### Send a raw HTTP call

Request body is `{ "input": value }`; success is `{ "output": value }`, or `{}` for undefined output. Use the standard deep-object query `location[directory]` to select the directory. The HTTP handler waits for plugin activation before dispatch.

```sh
opencode api --server http://127.0.0.1:4096 post '/api/rpc/example.counter/increment?location%5Bdirectory%5D=%2Fabsolute%2Fproject' --data '{"input":{"amount":1}}'
```

This call is a deterministic smoke test for the combined example. Keep authentication in the CLI/server's existing credential context rather than pasting secrets into the command.

## Emit and subscribe to live events

Emit with the registration returned by the **server's** `ctx.rpc.register`: `registration.events.emit("changed", { value })`. Subscribe with the local event name (`changed`), not the wire name (`rpc.example.counter.changed`). Payloads include type, data, and Location metadata.

| API | Consumption and cleanup |
| --- | --- |
| Promise `rpc.events.on(name, callback, { signal }?)` | Return value is an unsubscribe function; callbacks may return a Promise |
| Promise `rpc.events.subscribe(name, { signal }?)` | Async iterable; abort or close the iterator when done |
| Effect `rpc.events.subscribe(name)` | Stream; run in a scoped fiber for plugin lifetime |

External/TUI clients receive events across Locations; method-call Location options do not filter subscriptions. Filter `event.location` for the intended target. Server-local subscriptions use the Location registry. Server Promise subscriptions close on unload; still return cleanup for listeners owned by a TUI/client. Events are ephemeral, with no durable replay for disconnected clients. Read current state with a method after reconnect when the UI needs recovery.

```ts
import { OpenCode } from "@opencode/client"
import { Counter } from "./rpc.js"

export async function observe(baseUrl: string, directory: string, signal: AbortSignal) {
  const client = OpenCode.make({ baseUrl })
  for await (const event of client.rpc(Counter).events.subscribe("changed", { signal })) {
    if (event.location.directory !== directory) continue
    console.log(event.type, event.data.value)
  }
}
```

The observation example assumes the target's authentication already permits the supplied client. Add headers as in the method-call example when required. Do not await an endless subscription inside setup; launch background consumption and return cleanup. Subscription callback failures are logged by adapters; they are not method responses.

## Handle declared failures and system errors

Define expected error payload schemas in the method's `errors` map. Create failures through the supplied handler error factory. A plain object with matching `type` is not a declared handler error. Invalid declared data or undeclared errors become defects.

| Failure type | Cause |
| --- | --- |
| Declared name, for example `invalid_amount` | Handler returns/throws factory-created error, or Effect fails with it |
| `rpc.unavailable` | No active registration or Location RPC has closed |
| `rpc.method_not_found` | Registered contract/handler lacks that method |
| `rpc.invalid_input` | Input fails validation/decoding |
| `rpc.invalid_output` | Handler result fails output validation/encoding |
| `rpc.internal` | Unexpected handler defect; server logs details |

HTTP maps `rpc.invalid_output` and `rpc.internal` to `RpcInternalError`; other failures use `RpcError` and retain declared data. The Promise network client throws plain `{ type, message, data? }` values for those responses; `instanceof Error` alone misses them. Other transport failures can still throw different values. Recover using the failure type and validate unknown data when needed. Effect clients expose declared failures and system/decode/transport failures in their typed error channel.

Promise handlers receive `signal` for cooperative cancellation. Effect handlers use interruption and receive only the error factory. A cancelled or failed call does not imply its side effects never ran; do not blindly retry mutating operations.

## Use the Effect variants

Import the server API from `@opencode/plugin/effect`. Effect registration requires `Scope.Scope`; plugin lifetime supplies it. Handler results are Effects with declared failure types. Emit/dispose return Effects. Convert registration/initialization failures to the plugin's required `never` error channel deliberately; the example uses `Effect.orDie`.

`effect.ts`, a complete Effect-only contract and server:

```ts
import { Plugin } from "@opencode/plugin/effect"
import { Rpc } from "@opencode/plugin/rpc"
import { Effect, Schema, Stream } from "effect"

export const Greeting = Rpc.define({
  id: "example.greeting",
  methods: {
    greet: {
      input: Schema.Struct({ name: Schema.String }),
      output: Schema.Struct({ text: Schema.String }),
      errors: { missing: Schema.Struct({ name: Schema.String }) },
    },
  },
  events: { greeted: { schema: Schema.Struct({ text: Schema.String }) } },
})

export default Plugin.define({
  id: "example.greeting.server",
  effect: (ctx) => Effect.gen(function* () {
    const registration = yield* ctx.rpc.register(Greeting, {
      greet: ({ name }, call) => name.length === 0
        ? Effect.fail(call.error("missing", "Name is empty", { name }))
        : Effect.succeed({ text: `Hello ${name}` }),
    })
    yield* ctx.rpc(Greeting).events.subscribe("greeted").pipe(
      Stream.runForEach((event) => Effect.logInfo(event.data.text)),
      Effect.forkScoped,
    )
    const result = yield* ctx.rpc(Greeting).greet({ name: "Reader" })
    yield* registration.events.emit("greeted", result)
  }).pipe(Effect.orDie),
})
```

Split `Greeting` into an inert `rpc.ts` export for distribution. This example keeps both in one file to show the Effect contract and implementation together. Its fork does not establish a ready-to-receive barrier for the immediate emitted event.

Network Effect clients import `@opencode/client/effect` and require an Effect HttpClient layer. With the file above:

```ts
import { OpenCode } from "@opencode/client/effect"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Greeting } from "./effect.js"

export function greet(baseUrl: string, directory: string) {
  return Effect.gen(function* () {
    const client = yield* OpenCode.make({ baseUrl })
    return yield* client.rpc(Greeting).greet({ name: "Reader" }, { location: { directory } })
  }).pipe(Effect.provide(FetchHttpClient.layer))
}
```

Run the returned Effect through the application's existing runtime. Pass request headers through method options or an authenticated HttpClient when required; the example assumes an already permitted endpoint. Use a portable contract, such as `Counter`, when an Effect server must also support a Promise TUI client.

## Copy the browser plugin's transport architecture when needed

`packages/plugin-browser` is a server Effect plugin consumed by desktop integration. Its package exports `.`, `./rpc`, and `./proxy`; it has **no TUI export**. Copy its transport/state pattern, not an assumed terminal half.

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Thin setup: create connection state, register tools |
| `src/rpc.ts` | Shared `experimental.browser` contract: attach/state/command/result, tunnel methods, control events, explicit protocol version |
| `src/connection.ts` | Session/connection IDs, attachments, pending Deferred results, finalizers, cancellation, timeout, Location checks |
| `src/tools.ts` | Model-facing tools that dispatch through the connection and validate client results |
| `src/proxy.ts` | Desktop-side proxy module separated from the server entrypoint |

For reverse requests, the server stores a pending command, emits a `control` event with request/connection IDs, and waits for a result. The desktop calls `command` to fetch it and `result` to complete it. The server races disconnect, sends cancellation on interruption, times out after 60 seconds, and removes pending state. Client-hosted RPC-handler registration is unnecessary. Use this pattern only when the server genuinely needs a client-owned resource; small synchronous server methods need none of that machinery.

## Gotchas

- Always supply method input/output schemas and a top-level events map; the omission advice in the docs conflicts with v2.0.20 source.
- Register handlers on the server and keep shared contract imports inert.
- Keep Promise/TUI contracts portable; Effect codecs require the Effect API.
- Select method Location and filter client event Location independently.
- Treat events as live-only, factory-created failures as typed RPC errors, and mutation outcomes after cancellation as potentially unknown.
- Typecheck, load the installed package, and observe live RPC behavior separately; [packaging.md](packaging.md) defines the verification ladder.

## Source map

All upstream paths below refer to tag `v2.0.20`.

- `packages/schema/src/rpc.ts`: required schemas, portable contracts, inference, reserved names, failure and event types.
- `packages/plugin/src/{promise,effect}/rpc.ts`: handler/registration signatures; `packages/plugin/src/promise/adapter.ts`: Promise error factories, cancellation, scoped subscriptions.
- `packages/core/src/rpc.ts`: Location-scoped registration stacks, input/output/error validation, defects, ephemeral events.
- `packages/plugin/src/tui/context.ts`: connected client and absence of terminal handler registration.
- `packages/client/src/{promise,effect}/rpc.ts`, `packages/client/src/{promise,effect}/client.ts`: typed network calls, dynamic `rpc.call`, options, errors, subscriptions, Effect HttpClient requirements.
- `packages/sdk/src/{opencode.ts,promise.ts}`: embedded Promise host and its client-shaped RPC API.
- `packages/protocol/src/groups/{rpc.ts,location.ts}`, `packages/server/src/handlers/rpc.ts`: endpoint/body/query and HTTP error mapping.
- `packages/plugin-browser/{package.json,src/index.ts,src/rpc.ts,src/connection.ts,src/tools.ts,src/proxy.ts}`: real server/desktop architecture.
- `services/www/src/docs/content/build/plugins/{rpc.mdx,effect/rpc.mdx}`: recipes; source overrides the optional-schema claim.
