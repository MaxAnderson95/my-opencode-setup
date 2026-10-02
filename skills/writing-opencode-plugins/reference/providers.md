Verified against OpenCode v2.0.20 (@opencode/plugin 2.0.20).

# Add providers, models, and authentication

Use [server.md](server.md) for plugin definitions, context, registration lifetime, transforms, and non-provider hooks. Use [migrate-v1.md](migrate-v1.md) when porting `auth.loader`, returned auth methods, or v1 provider hooks. The recipes below typecheck against the published SDK; no remote login or model inference was run.

## Choose the extension surface

Register source definitions first, authentication independently, and model policy after provider availability. Register request hooks for live edits.

| Task | Surface | Boundary |
| --- | --- | --- |
| Add a provider or replace its source models | `ctx.provider.transform` | Source records include inactive providers; models are immutable inputs. |
| Restrict available models, change costs/limits, choose default | `ctx.model.transform` | Candidates come only from available providers, including disabled models. |
| Register key, environment, OAuth, or command authentication | `ctx.integration.transform` | Providers reference `integrationID`, or core uses their provider ID. |
| Read current account/token | `ctx.integration.connection.active/resolve` | Resolve at execution time; resolution can refresh an OAuth token. |
| Supply an AI SDK factory or language model | `ctx.aisdk.hook("sdk" / "language")` | AI SDK route only; construction is cached, not per request. |
| Rewrite route headers/base URL | `ctx.session.hook("model.request")` | Mutable `headers`, optional `baseURL`; model identity stays readonly. |
| Rewrite wire requests/responses | `http.request`, `http.response` | Web `Request`/`Response`; covers HTTP, including HTTP fallback. |
| Intercept a session WebSocket | `experimental.ws.handshake/send/receive` | Experimental; independent of HTTP hooks. |
| Change retry policy | `ctx.session.hook("retry")` | Edit the proposed decision, within core's attempt limit. |

Promise registrations accept synchronous transform callbacks and async runtime hooks. General hook order and cleanup are in [server.md](server.md). Provider changes invalidate model materialization; `provider.reload()` also reapplies model transforms. Use `model.reload()` when only captured model-policy data changes.

Sources: `packages/plugin/src/promise/{provider,model,integration,aisdk,session,registration}.ts`, `packages/core/src/{provider,model}.ts`.

## Add an OpenAI-compatible provider

Use the native `@opencode/ai/providers/openai-compatible` package for chat-completions-compatible APIs. `Provider.Info.empty(id)` and `Model.Info.default(providerID, id)` supply required fields; override real capabilities and limits.

```ts
import { Integration, Model, Plugin, Provider } from "@opencode/plugin"

export default Plugin.define({
  id: "example.compatible",
  async setup(ctx) {
    const providerID = Provider.ID.make("acme")
    const model = Model.Info.default(providerID, Model.ID.make("reasoner"))
    await ctx.integration.transform((editor) => {
      editor.update("acme", (integration) => { integration.name = "Acme" })
      editor.method.update({ integrationID: "acme", method: { type: "key", label: "Acme API key" } })
      editor.method.update({ integrationID: "acme", method: { type: "env", names: ["ACME_API_KEY"] } })
    })
    await ctx.provider.transform((editor) => {
      editor.add({
        info: {
          ...Provider.Info.empty(providerID),
          integrationID: Integration.ID.make("acme"),
          name: "Acme",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: "https://api.example.com/v1", provider: "acme" },
        },
        models: [{ ...model, name: "Acme Reasoner", limit: { context: 64_000, output: 8_000 } }],
      })
      editor.update("acme", (provider) => {
        provider.headers = { ...provider.headers, "x-client": "example-plugin" }
        provider.settings = { ...provider.settings, timeout: 60_000 }
      })
      editor.models.update("acme", "reasoner", (draft) => {
        draft.capabilities = { tools: true, input: ["text"], output: ["text"] }
      })
    })
  },
})
```

This recipe keeps `activation: "auto"`: connecting a key or setting `ACME_API_KEY` makes the provider available. Core resolves the connection and injects `apiKey`; do not copy tokens into provider metadata. For a deliberately unauthenticated local service, use `activation: "enabled"` and omit the integration, as the discovery recipe does.

Provider options live in `settings`, headers in `headers`, and raw body overlays in `body`. There is no provider-editor `env` or `options` field. Register environment key names as an integration method. Core consumes `timeout`, `chunkTimeout`, `transport`, and compaction settings separately from the native package's protocol options.

| Provider editor operation | Action |
| --- | --- |
| `list()`, `get(providerID)` | Read records `{ provider, models: ReadonlyMap, sourceConnection? }`, including inactive templates. |
| `add({ info, models, sourceConnection? })` | Replace the complete record for that ID. |
| `update(providerID, callback)` | Edit metadata; creates a missing provider from `Info.empty`. |
| `remove(providerID)` | Remove that source provider. |
| `models.set(providerID, models)` | Replace the source inventory. |
| `models.update(providerID, modelID, callback)` | Edit an owned model copy; creates a missing source model from defaults. |
| `models.remove(providerID, modelID)` | Remove a source model. |

`Provider.Info` has `id`, `canonical?`, `integrationID?`, `name`, `activation`, `package`, and overlays. `canonical` identifies inherited provider behavior; it is not an authentication-method ID. Editor operations preserve the provider/model IDs used as their keys.

Availability checks run before model policy: `disabled` excludes a provider; a mismatched `sourceConnection` excludes it; `enabled` permits it without a credential; `auto` otherwise needs an active connection unless no integration exists for the provider. Enabling a provider does not prove its endpoint accepts requests.

Sources: `packages/schema/src/{provider,model}.ts`, `packages/core/src/{provider,model-resolver}.ts`, `packages/ai/src/providers/openai-compatible.ts`.

## Discover remote models and refresh the inventory

Fetch and validate the inventory before registering a transform. Capture the result, replace it after a successful refresh, and call `provider.reload()`. The following local endpoint uses an illustrative OpenAI-style `{ data: [{ id }] }` response.

```ts
import { Model, Plugin, Provider } from "@opencode/plugin"
import { Schema } from "effect"
import { setTimeout as delay } from "node:timers/promises"

const Inventory = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) })
const providerID = Provider.ID.make("local-models")
const baseURL = "http://127.0.0.1:8000/v1"

export default Plugin.define({
  id: "example.discovery",
  async setup(ctx) {
    const abort = new AbortController()
    async function load() {
      const response = await fetch(`${baseURL}/models`, {
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5_000)]),
      })
      if (!response.ok) throw new Error(`Model discovery failed: ${response.status}`)
      const body = Schema.decodeUnknownSync(Inventory)(await response.json())
      return [...new Set(body.data.map((item) => item.id))].sort().map((id) => ({
        ...Model.Info.default(providerID, Model.ID.make(id)),
        capabilities: { tools: false, input: ["text"], output: ["text"] },
        limit: { context: 8_192, output: 2_048 },
      }))
    }
    let models = await load()
    await ctx.provider.transform((editor) => {
      editor.add({
        info: {
          ...Provider.Info.empty(providerID),
          activation: "enabled",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL, provider: "local-models", apiKey: "" },
        },
        models,
      })
    })
    const task = (async () => {
      while (!abort.signal.aborted) {
        await delay(60_000, undefined, { signal: abort.signal }).catch(() => {})
        if (abort.signal.aborted) return
        try {
          const next = await load()
          if (abort.signal.aborted) return
          if (JSON.stringify(next) === JSON.stringify(models)) continue
          models = next
          await ctx.provider.reload()
        } catch (error) {
          if (!abort.signal.aborted) console.warn("example.discovery: refresh failed", error)
        }
      }
    })()
    return async () => { abort.abort(); await task }
  },
})
```

The recipe fails setup on the initial discovery failure, retains the last successful inventory during later outages, and serializes refreshes. The small limits and text-only capabilities are explicit example policy, not facts discoverable from `/models`. Replace them with the endpoint's verified metadata. `Model.Info.default` otherwise advertises tools, image input, a 200,000-token context, and 32,000-token output.

Read upstream `ollama.ts` and `lmstudio.ts` for richer discovery: capability probing, loaded-context limits, endpoint/key-sensitive caches, and configuration-change handling. Their `Config.Service`, HTTP services, and `foldSettings` helper are internal. External plugins use their options, public reads, and owned network calls.

### Bind account-specific discovery to the selected connection

Pass `sourceConnection` when an account determines models or endpoints. Core hides the captured provider record after an account switch until a matching inventory is published. Verify the account again after slow network discovery; do not attach old data to a new connection.

```ts
import type { Credential, Model, Plugin } from "@opencode/plugin"

type Connection = NonNullable<Awaited<ReturnType<Plugin.Context["integration"]["connection"]["active"]>>>
const identity = (connection: Connection | undefined) => connection?.type === "credential"
  ? `credential:${connection.id}` : connection ? `env:${connection.name}` : undefined

export async function bindInventory(ctx: Plugin.Context, fetchInventory: (value: Credential.Value) => Promise<Model.Info[]>) {
  async function load() {
    const connection = await ctx.integration.connection.active("acme")
    if (!connection) return
    const credential = await ctx.integration.connection.resolve(connection)
    if (!credential) return
    const models = await fetchInventory(credential)
    const active = await ctx.integration.connection.active("acme")
    if (identity(active) !== identity(connection)) return
    return { models, connection }
  }
  let inventory = await load()
  await ctx.provider.transform((editor) => {
    const source = editor.get("acme")
    if (!source || !inventory) return
    editor.add({ info: source.provider, models: inventory.models, sourceConnection: inventory.connection })
  })
  return async () => {
    inventory = await load()
    await ctx.provider.reload()
  }
}
```

Call this helper once during setup for an existing provider; invoke its returned refresh function on relevant credential changes. Serialize refreshes and give the real `fetchInventory` cancellation/timeouts. A reload replays the transform; registering a new transform on every poll accumulates registrations.

Sources: `packages/core/src/provider.ts`, `packages/core/src/plugin/provider/{github-copilot,ollama,lmstudio}.ts`; model-discovery `src/v2/catalog.ts` supplies the capture/replace/reload pattern.

## Restrict models and edit metadata

Use `model.transform` for policy across the active-provider candidates. Convert deep-mutable branded IDs to strings at editor-call boundaries instead of weakening types with `as never`.

```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "example.model-policy",
  async setup(ctx) {
    const allowed = new Set(["reasoner", "chat"])
    await ctx.model.transform((editor) => {
      for (const model of editor.list("acme")) {
        const providerID = String(model.providerID)
        const modelID = String(model.id)
        if (!allowed.has(modelID) || model.status === "deprecated") {
          editor.remove(providerID, modelID)
          continue
        }
        editor.update(providerID, modelID, (draft) => {
          draft.enabled = draft.capabilities.tools
          draft.limit.output = Math.min(draft.limit.output, 8_000)
        })
      }
      if (editor.get("acme", "reasoner")?.enabled) editor.default.set("acme", "reasoner")
    })
  },
})
```

`list(providerID?)` and `get(providerID, modelID)` return candidates, including disabled candidates. `remove` deletes one; `update` edits raw overrides or creates a missing model only within an available provider. `default.get/set` read/write the selection. `editor.provider.list/get` read immutable provider inputs before model transforms, including inactive templates.

Core merges provider overlays once when committing the result, then filters enabled models. A transform's model settings do not contain the final inherited provider settings. `Model.Ref` uses `{ providerID, id, variant? }`; `Model.Info.modelID` is the upstream wire ID and may differ from the catalog ID. Construct schema values with `Provider.ID.make`, `Model.ID.make`, and `Model.VariantID.make`.

Explicit user config runs after external plugin policy. It can recreate removed models, re-enable disabled models, override limits, and replace the default. A model-list filter is therefore not an unoverrideable security or billing gate. Enforce required runtime behavior separately and account for every transport.

### Set prices and limits

Use USD per million tokens, including cache rates. These example prices are illustrative:

```ts
import { Model, Provider } from "@opencode/plugin"
import { Money } from "@opencode/schema/money"

export const model: Model.Info = {
  ...Model.Info.default(Provider.ID.make("acme"), Model.ID.make("reasoner")),
  limit: { context: 64_000, input: 56_000, output: 8_000 },
  cost: [{
    input: Money.USDPerMillionTokens.make(1),
    output: Money.USDPerMillionTokens.make(5),
    cache: { read: Money.USDPerMillionTokens.make(0.1), write: Money.USDPerMillionTokens.make(1.25) },
  }],
}
```

`cost: []` produces zero estimated cost; it does not prevent paid usage. A tier with `{ type: "context", size }` applies when input plus cache-read/cache-write tokens exceed `size`; core picks the highest exceeded threshold, otherwise the untiered rate. Output pricing counts visible output plus reasoning tokens.

Other model metadata: `capabilities.tools/input/output`, `status: "alpha" | "beta" | "deprecated" | "active"`, `family?`, `time.released`, `compatibility?`, and `variants[]` containing `id` plus overlays. Compatibility has `reasoningField`, `requireReasoning`, `maxTokensField`, `requireFinishReason`, `requireAssistantAfterTool`, and `supportsPromptCacheKey`. Set these only for a verified protocol requirement.

Primary and compaction calls start with a context-fitted `maxTokens`; title/generate do not get that initial cap. Changing a catalog limit affects future request preparation, not an already-captured request or the provider's actual quota.

Sources: `packages/schema/src/{model,money}.ts`, `packages/core/src/{model,model-resolver}.ts`, `packages/core/src/config/plugin/provider.ts`, `packages/core/src/session/{usage,model-request}.ts`.

## Register integrations and OAuth methods

Use `integration.transform` to register methods. `method.update` creates the integration if absent; `editor.update(id, callback)` edits its name and also creates a missing integration. `list/get/remove` manage integration refs; `method.list/remove` inspect/remove methods.

| Method | Definition | Implementation |
| --- | --- | --- |
| Key | `{ type: "key", label?, form? }` | Core accepts the key; form answers become credential `configuration`. |
| Environment | `{ type: "env", names: string[] }` | Core exposes nonempty server-process variables as key connections. |
| OAuth | `{ id, type: "oauth", label, form? }` | Supply `authorize`, optional `refresh`, optional credential `label`. |
| Command | `{ id, type: "command", label, command: string[] }` | Core launches the command connection attempt. |

A command method's executable must follow core's protocol (`packages/core/src/integration.ts`): stdin is ignored; stderr streams into the attempt's progress and failure message; a nonzero exit fails the attempt; on exit 0, the trimmed stdout becomes a **key** credential (`{ type: "key", key }`), and empty stdout fails. Print only the secret on stdout. Banners, prompts, or JSON wrappers become part of the saved key. Command methods cannot produce OAuth credentials.

OAuth/command methods match by type plus ID. Key/env each have one entry per integration. Removing an auth method changes available behavior; it does not delete stored credentials. `integration.reload()` replays captured integration policy.

`authorize(answer)` returns `Promise<IntegrationOAuthAuthorization>`: `url`, `instructions`, optional attempt `expiresAt`, and either `mode: "auto"` with a **Promise** callback or `mode: "code"` with `callback(code)`. Both complete to `Credential.OAuth`. The following registration expects your already-implemented OAuth client; it does not implement a vendor protocol.

```ts
import { Credential, Integration, Plugin } from "@opencode/plugin"
import type { IntegrationOAuthAuthorization } from "@opencode/plugin/promise/integration"

type OAuthClient = {
  manual(): Promise<{ url: string; exchange(code: string): Promise<Credential.OAuth> }>
  automatic(): Promise<{ url: string; completion: Promise<Credential.OAuth> }>
  refresh(credential: Credential.OAuth): Promise<Credential.OAuth>
}

export function subscriptionPlugin(oauth: OAuthClient) {
  return Plugin.define({
    id: "example.subscription",
    async setup(ctx) {
      await ctx.integration.transform((editor) => {
        editor.method.update({
          integrationID: "acme",
          method: {
            id: "subscription", type: "oauth", label: "Acme subscription",
            form: [{
              key: "login", type: "string", title: "Authorization mode", default: "code",
              options: [{ value: "code", label: "Paste code" }, { value: "auto", label: "Browser callback" }],
            }],
          },
          async authorize(answer): Promise<IntegrationOAuthAuthorization> {
            if (answer.login === "auto") {
              const flow = await oauth.automatic()
              return { mode: "auto", url: flow.url, instructions: "Finish signing in.", callback: flow.completion }
            }
            const flow = await oauth.manual()
            return { mode: "code", url: flow.url, instructions: "Paste the code.", callback: flow.exchange }
          },
          refresh: (credential) => oauth.refresh(credential),
          label: () => "Acme subscription",
        })
      })
    },
  })
}

export function tokenCredential(tokens: { access: string; refresh: string; expiresIn: number }): Credential.OAuth {
  return Credential.OAuth.make({
    type: "oauth", methodID: Integration.MethodID.make("subscription"),
    access: tokens.access, refresh: tokens.refresh, expires: Math.trunc(Date.now() + tokens.expiresIn * 1000),
  })
}
```

Set `expires` to epoch milliseconds. Return a native credential with `type: "oauth"`, matching `methodID`, `access`, `refresh`, `expires`, optional `metadata`. Preserve a refresh token when the vendor omits a replacement. An API key resolves to `{ type: "key", key, metadata?, configuration? }`. V1 `type: "success"` wrappers and authorization `method: "auto"` are not this contract.

Forms are nonempty `Form.Fields`: string, number, integer, boolean, multiselect, external-link fields. Use `key`, optional `title/description/required`, defaults, string `options: [{ value, label, description? }]`, and `when: [{ key, op: "eq" | "neq", value }]` referring to earlier fields. Hidden authentication fields use their defaults unless supplied. Answers are a record of string, number, boolean, or string-array values; validate vendor-specific meaning in your client.

Own callback listeners, device-code polling, state/PKCE checks, timeout, and cleanup. The Promise authorize signature has no cancellation signal; core cancelling an attempt cannot automatically close a Node listener your Promise started. Use the Effect contract when scoped cancellation is needed, or explicitly own resource teardown and a bounded lifetime. A loopback callback runs on the server, which may be remote from the user's browser; provide code/device flow when that browser cannot reach it.

Sources: `packages/plugin/src/{promise,effect}/integration.ts`, `packages/schema/src/{credential,integration-id,form}.ts`, `packages/core/src/integration.ts`.

## Resolve accounts and react to credential changes

Call `active(integrationID): Promise<ConnectionInfo | undefined>`, then `resolve(connection): Promise<Credential.Value | undefined>`. Narrow the result by `type` and, for owned OAuth behavior, `methodID`.

Stored connections have `{ type: "credential", id, label, method: "key" | "oauth" }`; environment connections have `{ type: "env", name }`. Core prefers selected stored credentials over env keys. Resolve re-reads the credential and refreshes OAuth tokens within five minutes of expiry when the registered method has `refresh`. Missing methods do not cause core to invent a refresh implementation.

Use `credential.updated` to re-read inventory/ownership; its data is empty. `credential.switched` has `{ integrationID, credentialID: string | null }` and can be filtered by integration. Token-only persistence during refresh does **not** emit `credential.updated` in this version; resolve fresh tokens for every authenticated request instead of waiting for that event.

```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "example.subscription-cost",
  async setup(ctx) {
    let subscription = false
    async function readOwnership() {
      const connection = await ctx.integration.connection.active("acme")
      const credential = connection ? await ctx.integration.connection.resolve(connection) : undefined
      subscription = credential?.type === "oauth" && credential.methodID === "subscription"
    }
    await readOwnership()
    await ctx.model.transform((editor) => {
      if (!subscription) return
      for (const model of editor.list("acme")) {
        editor.update(String(model.providerID), String(model.id), (draft) => { draft.cost = [] })
      }
    })
    const abort = new AbortController()
    const task = (async () => {
      for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
        if (event.type === "credential.updated" ||
            (event.type === "credential.switched" && event.data.integrationID === "acme")) {
          subscription = false
          await readOwnership()
          await ctx.model.reload()
        }
      }
    })().catch((error: unknown) => {
      if (!abort.signal.aborted) console.warn("example.subscription-cost: event stream failed", error)
    })
    try {
      await readOwnership()
      await ctx.model.reload()
    } catch (error) {
      abort.abort()
      await task
      throw error
    }
    return async () => { abort.abort(); await task }
  },
})
```

This consumer rechecks after subscribing to close the initial read/subscription gap. It logs and stops after an unexpected stream failure; a long-lived account policy needs an explicit reconnect/reconciliation policy, as in [server.md](server.md) and [examples.md](examples.md).

Report a runtime connection problem with `connection.status({ integrationID, connection, status: { status: "needs_auth", message, url? } })`; pass `status: undefined` to clear it. The status is process-local, does not replace/delete the credential, and is exposed through integration reads.

Public operations also include `integration.list/get`, `connect.key({ integrationID, key, answer?, label? })`, `oauth.connect({ integrationID, methodID, answer?, label? })`, `oauth.status/complete/cancel` using `attemptID`, and `command.connect/status/cancel`. Located reads/attempts return `{ location, data }`; active/resolve return their values directly. The plugin context omits `wellknown` and has no top-level credential CRUD domain.

Core stores credentials globally in the SQLite `credential` table, whose JSON `value` contains token/key material. The CLI normally selects `opencode.db` under its data directory; channel-specific names and `OPENCODE_DB` can change that path. Core persists successful OAuth completion and refreshed values. Keep plugin state in `ctx.storage`, but keep native credentials in core, not config, a v1 `auth.json` assumption, or a duplicate token file.

Sources: `packages/core/src/{integration,credential}.ts`, `packages/core/src/credential/sql.ts`, `packages/cli/src/database-path.ts`, `packages/schema/src/{connection,credential}.ts`, published `dist/promise/integration.d.ts`.

## Supply an AI SDK package or language model

Choose the native route unless the required behavior specifically needs AI SDK. A native provider package exports `model(modelID, settings)` returning OpenCode's `LanguageModel`; it is a different contract from an AI SDK factory. For a custom, unmapped AI SDK package, set `package: "aisdk:<package-name>"` and supply `event.sdk` through `aisdk.hook("sdk")`.

`sdk` events have readonly `model`, `package` (prefix removed), `options`, and mutable `sdk`. `language` events have readonly `model`, `sdk`, `options`, and mutable `language?: LanguageModelV3`. The `options` reference is readonly; its entries can be edited. Both accept `{ providerID }` scoping. Assign output fields; returning a factory result does nothing.

```ts
import { Plugin } from "@opencode/plugin"
import type { LanguageModelV3 } from "@ai-sdk/provider"

type SDK = { languageModel(modelID: string): LanguageModelV3 }
type Factory = (options: Record<string, unknown>) => Promise<SDK>

export function sdkPlugin(create: Factory, select?: (sdk: SDK, modelID: string) => LanguageModelV3) {
  return Plugin.define({
    id: "example.aisdk",
    async setup(ctx) {
      await ctx.provider.transform((editor) => {
        editor.update("acme", (provider) => { provider.package = "aisdk:acme-ai-provider" })
      })
      await ctx.aisdk.hook("sdk", async (event) => {
        if (event.package !== "acme-ai-provider") return
        event.sdk = await create(event.options)
      }, { providerID: "acme" })
      await ctx.aisdk.hook("language", (event) => {
        if (event.model.package !== "aisdk:acme-ai-provider" || !select) return
        const sdk: SDK = event.sdk
        event.language = select(sdk, event.model.modelID)
      }, { providerID: "acme" })
    },
  })
}
```

This helper assumes an existing provider/model inventory and your declared package's real factory. Replace the illustrative package name and connect `create` to that factory; pass `select` only for a package-specific language selector. The public SDK types use `any` for `sdk/options`; keep your own factory/result types narrow. This recipe typechecks the host boundary without claiming a nonexistent package was installed or tested.

If no hook supplies `sdk`, initialization fails. If none supplies `language`, core calls `sdk.languageModel(model.modelID ?? model.id)`. Core's dynamic factory installs/imports the package and selects its first export starting with `create`. In standard boot order it registers before external plugin hooks: your replacement hook runs only after that earlier factory succeeds. Supply a loadable package with the expected factory export; a later hook cannot rescue a failed earlier import. Declare every package you directly import, including type imports, in your plugin's manifest.

Mapped SDK package names such as `@ai-sdk/openai` and `@ai-sdk/xai` are rewritten to native provider packages during model/provider edits, even with an `aisdk:` prefix. Registering an AI SDK hook for such a package does not establish that the hook will run. Inspect `AISDKNative.rewrite` and the final model package first.

SDKs and languages are cached by provider/model/package and settings/header/body identity (language cache also includes limits). Changing hook-local account state does not invalidate an existing cached SDK. For changing auth, use request hooks or a custom fetch that resolves current credentials; retain core's provided `options.fetch` when constructing the SDK.

Core threads session HTTP middleware through that prepared fetch via async-local state. An SDK that ignores it and calls its own network transport bypasses those hooks. AI SDK's synthetic route keeps its own endpoint and has a no-op `with`; `model.request.baseURL` is not a constructor-baseURL rewrite for a cached SDK. Change the SDK settings or actual HTTP request instead.

Sources: `packages/plugin/src/promise/aisdk.ts`, `packages/core/src/{aisdk,aisdk-native,model-resolver,provider}.ts`, `packages/core/src/plugin/{provider,internal,supervisor}.ts`, `packages/core/src/plugin/provider/{factory,dynamic,sdk-factory}.ts`, `packages/ai/src/provider-package.ts`.

## Intercept model and HTTP requests

Scope provider-specific hooks with the third argument `{ providerID }`. These hooks have readonly `sessionID`, `agent`, `model`, and `kind: "primary" | "compaction" | "title" | "generate"`. Use `kind` for auxiliary requests, rather than guessing from the agent ID.

`model.request` edits `baseURL?` and `headers: Record<string, string>` after model-request assembly. `http.request` edits/replaces `request: Request` after protocol lowering. `http.response` has readonly final `request` and mutable `response: Response` before the provider consumes it.

```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "example.gateway",
  async setup(ctx) {
    const started = new WeakMap<Request, number>()
    await ctx.session.hook("model.request", (event) => {
      event.baseURL = "https://gateway.example.com/v1"
      event.headers["x-request-kind"] = event.kind
    }, { providerID: "acme" })
    await ctx.session.hook("http.request", async (event) => {
      const connection = await ctx.integration.connection.active("acme")
      const credential = connection ? await ctx.integration.connection.resolve(connection) : undefined
      if (credential?.type !== "oauth" || credential.methodID !== "subscription") return
      const original = event.request
      const url = new URL(original.url)
      if (url.origin !== "https://gateway.example.com") return
      const headers = new Headers(original.headers)
      headers.set("authorization", `Bearer ${credential.access}`)
      headers.delete("api-key")
      event.request = new Request(original, { headers })
      started.set(event.request, Date.now())
    }, { providerID: "acme" })
    await ctx.session.hook("http.response", (event) => {
      const at = started.get(event.request)
      if (at === undefined) return
      started.delete(event.request)
      const headers = new Headers(event.response.headers)
      headers.set("x-plugin-elapsed-ms", String(Date.now() - at))
      event.response = new Response(event.response.body, {
        status: event.response.status, statusText: event.response.statusText, headers,
      })
    }, { providerID: "acme" })
  },
})
```

This gateway example redirects all `acme` request kinds; only its owned subscription credential gets the auth rewrite. Request identity correlates its response without a mutable "last request" global. A later plugin replacing the `Request` can break that identity correlation; coordinate ordering or use an explicit correlation header when necessary.

Read bodies with `request.clone().text()` or `response.clone().text()` and replace the body when rewriting. Preserve method, headers, status/statusText, abort signal, and streaming behavior. Remove stale `content-length`/encoding headers when transformed bytes change. Never forward credentials to an arbitrary rewritten origin or log bearer headers. Raw HTTP-body changes apply after semantic option lowering.

For semantic generation/provider options, use provider-scoped context/compaction/generate/title hooks described in [server.md](server.md). Request overrides beat model defaults and route defaults; non-generation keys are protocol options. These are outgoing-call edits, not stored transcript changes. Standalone `ctx.generate.text` has no session identity; do not assume session hooks cover it.

Sources: `packages/core/src/session/model-request.ts`, `packages/plugin/src/promise/session.ts`, `packages/core/src/aisdk.ts`.

## Cover WebSocket transport explicitly

HTTP hooks do not disable WebSockets. Core independently supplies HTTP middleware and the session WebSocket binding; the selected route chooses the transport. HTTP hooks cover HTTP fallback only when WebSocket traffic carries the main call.

| Hook | Mutable fields | Timing |
| --- | --- | --- |
| `experimental.ws.handshake` | `url`, `headers: Record<string, string>` | Once per model call before socket selection/reuse; URL/header changes reopen it. |
| `experimental.ws.send` | `frame: string` | After the provider driver builds a frame, before sending. |
| `experimental.ws.receive` | `frame: string` | Before the provider driver observes each received frame. |

```ts
import type { Plugin } from "@opencode/plugin"

export async function websocketAuth(ctx: Plugin.Context) {
  await ctx.session.hook("experimental.ws.handshake", async (event) => {
    if (new URL(event.url).origin !== "wss://gateway.example.com") return
    const connection = await ctx.integration.connection.active("acme")
    const credential = connection ? await ctx.integration.connection.resolve(connection) : undefined
    if (credential?.type !== "oauth" || credential.methodID !== "subscription") return
    event.headers.authorization = `Bearer ${credential.access}`
    delete event.headers["api-key"]
  }, { providerID: "acme" })
  await ctx.session.hook("experimental.ws.send", (event) => {
    if (event.kind === "primary") console.log("Sending primary frame", event.frame.length)
  }, { providerID: "acme" })
  await ctx.session.hook("experimental.ws.receive", (event) => {
    console.log("Received frame", event.frame.length)
  }, { providerID: "acme" })
}
```

All three carry the same readonly request identity and `kind` as HTTP hooks. Core forwards rewritten frames verbatim without protocol validation; the driver still tracks provider state, so changing frame meaning can invalidate its assumptions. Logging lengths avoids exposing prompt/token content.

Provider `settings.transport` selects `"http" | "websocket"`; a route without a WebSocket channel warns and falls back to HTTP. In session preparation, only requests with the durable runner's `webSocket: "session"` option and a resolved WebSocket transport receive this binding. Test actual handshake/frame traffic and HTTP fallback before claiming transport-wide gating.

Sources: `packages/core/src/session/{model-request,model-transport}.ts`, `packages/plugin/src/promise/session.ts`, `packages/schema/src/provider.ts`.

## Override retries for provider failures

Edit `event.decision: { retry: false } | { retry: true, delay: number }`. The hook receives readonly `error`, `attempt`, model, agent, session ID; it has no request `kind` field.

```ts
import type { Plugin } from "@opencode/plugin"

export async function retries(ctx: Plugin.Context) {
  await ctx.session.hook("retry", (event) => {
    if (event.attempt >= 4 || event.error.status === 401) {
      event.decision = { retry: false }
    } else if (event.error.status === 429) {
      event.decision = { retry: true, delay: 10_000 }
    }
  }, { providerID: "acme" })
}
```

The decision follows core's failure classification, before scheduling. Later hooks can change it again. `attempt` identifies the next physical attempt: first retry is `2`. Core permits at most ten retries; a hook cannot extend the exhausted schedule. Nonfinite/negative delays fall back to core's computed delay. Context-overflow compaction is separate from retrying the same request.

Use this hook for retry policy. A response hook can replace a response, but manually fetching a retry there bypasses the normal hook/attempt accounting for that fetch. Do not log whole provider errors without checking their secret-bearing fields.

Sources: `packages/core/src/session/runner/retry.ts`, `packages/plugin/src/promise/session.ts`, `packages/schema/src/session-error.ts`.

## Anatomy of an OAuth subscription provider plugin

Read the public Claude auth implementation to see these pieces together:

https://github.com/MaxAnderson95/opencode-claude-auth/tree/main/src

| Piece | File | OpenCode API and role |
| --- | --- | --- |
| Entrypoint | `src/v2.ts` | Default `Plugin.define({ id, setup })`; root/server use v2, with retained v1 code elsewhere. |
| Authorization | `src/oauth.ts` | PKCE/state generation, manual code or server-loopback listener, token exchange; returns native OAuth credentials. |
| Auth registration | `src/v2-setup.ts` | `integration.transform` adds `claude-subscription` to `anthropic`, form chooses login mode, `authorize/refresh/label` supply behavior. |
| Account ownership | `src/v2-setup.ts` | Resolves active connection outside transforms, captures OAuth ownership, subscribes to credential updates/switches. |
| Price policy | `src/v2-setup.ts` | `model.transform` sets `cost = []` for subscription-owned models; `model.reload()` reapplies ownership changes. |
| Request adaptation | `src/v2-setup.ts`, `src/transforms.ts` | `http.request` resolves current token, rewrites headers/URL/system/body/tool names, stores metadata keyed by rewritten `Request`. |
| Response adaptation | `src/v2-setup.ts`, `src/betas.ts` | `http.response` handles long-context beta fallback and transforms SSE/tool names; only touches requests marked by its own request hook. |
| Usage state | `src/usage-limit.ts` | Account-keyed tracker reads rate-limit headers; typed RPC exposes status to the terminal half. |

The plugin extends an existing native provider; it does not need an AI SDK hook just because it implements OAuth. Core owns credential persistence and refresh invocation. Its manual response-side retries re-resolve tokens but are plugin-owned network attempts, separate from the session retry hook.

Copy the separation and request-local state, then tighten it for your requirement: the inspected implementation's ownership check accepts any OAuth credential on `anthropic`, while a new method-specific plugin should check `methodID`. Its HTTP-only adaptation does not prove WebSocket coverage. The Promise callback listener has its own timeout; verify cancellation/unload cleanup rather than assuming core closes it.

Built-in comparisons: `provider/openai.ts` registers browser/headless auth, changes subscription routes/costs/limits and watches switches; `provider/github-copilot.ts` binds discovered models to a connection and supplies a custom SDK fallback; `provider/openrouter.ts` changes native headers/model policy. Their `Bus`, `Config`, `Provider.Service`, `ModelsDev`, `CopilotModels`, and core factory helpers are private implementation dependencies, absent from external `Plugin.Context`.

## Gotchas

- Fetch outside transforms; callbacks are synchronous, replayable edits. Captured data needs the owning domain's reload.
- Register authentication on integrations, environment names as methods, and provider options under `settings`.
- Keep immutable source inventories separate from mutable available-model overrides. Model policy cannot enable an unavailable provider.
- Inspect late user config and the final catalog; an external model filter is not a mandatory billing gate.
- Resolve current tokens at request time. Credential events describe inventory/selection changes, not every refresh.
- Distinguish OAuth `mode`, credential `type`, and credential `methodID`; automatic completion is a Promise.
- Inspect the resolved package before using AI SDK hooks; mapped packages use native routes and custom AI SDK packages need `aisdk:`.
- Preserve core's SDK fetch bridge and streaming/cancellation when wrapping transport; a cached SDK is not a per-request auth hook.
- Cover both HTTP and WebSocket paths. Registering HTTP hooks does not force HTTP transport.
- Zero price metadata changes estimates only. Test account switches, concurrent requests, all request kinds, cancellation, and fallback against the installed artifact.

## Source map

- Published `@opencode/plugin/dist/promise/{provider,model,integration,aisdk,session,registration}.d.ts`: exact compiler contract; `/effect` equivalents change executor/cancellation behavior.
- `packages/schema/src/{provider,model,credential,connection,integration-id,form,money,session-error}.ts`: IDs, metadata, credentials, forms, prices, and errors.
- `packages/core/src/{provider,model,model-resolver,integration,credential,aisdk,aisdk-native}.ts`: materialization, auth resolution, credential refresh, native mapping, SDK caches and HTTP bridge.
- `packages/core/src/credential/sql.ts`, `packages/cli/src/database-path.ts`: credential persistence and database selection.
- `packages/core/src/session/{model-request,model-transport,usage}.ts`, `packages/core/src/session/runner/retry.ts`: request lowering, HTTP/WebSocket boundaries, estimates, retry limits.
- `packages/core/src/plugin/provider/{openai,github-copilot,openrouter,ollama,lmstudio,configured,factory,dynamic,sdk-factory}.ts`, `packages/core/src/plugin/models-dev.ts`: first-party patterns; check internal service imports before copying.
- `packages/core/src/config/plugin/provider.ts`, `packages/core/src/plugin/{provider,internal,supervisor}.ts`: late config override, built-in SDK factories, and plugin order.
- `packages/ai/src/{provider-package,providers/openai-compatible}.ts`: native package contract and compatible-chat settings.
- `services/www/src/docs/content/build/plugins/index.mdx`: task-oriented upstream guide; source decides transport and request-default behavior.
- Claude auth `src/{v2,v2-setup,oauth,transforms,betas,usage-limit}.ts`; model discovery `src/v2/catalog.ts`: external provider/auth patterns.
