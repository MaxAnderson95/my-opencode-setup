# overage-guard

Pauses a session family when a subscription provider starts billing beyond the plan, and asks whether to wait for the reset, allow the paid usage, or stop.

## What it does

Every model request passes through the guard. When a guarded provider's response shows that the request was paid for outside the subscription (Anthropic extra usage, OpenAI Codex credits), the guard closes a gate for that session family: the parent session and every subagent under it. Requests already in flight finish; the next request from any session in the family, on any provider, waits. Other families are unaffected.

The parent session receives a native question form (visible in the TUI and in clients that render forms, such as T3 Code). No model tool call is involved. Leaving it unanswered keeps the family paused.

- **Resume after reset** releases one waiting request on the provider that tripped the gate. The rest stay paused until that response confirms subscription usage. Continued paid usage, a response with no usable signal, or no response within a minute asks again.
- **Allow extra usage / Allow credits** permits paid usage until the provider's reported reset time, or for five minutes when no future reset time is known. The allowance belongs to the credential that tripped the gate; switching to another credential on that provider discards it.
- **Stop session and subagents** interrupts the parent and all descendants. Dismissing the form does the same. Continuing a stopped session later asks again if the gate is still closed.

One gate exists per family. Whichever provider first reports paid usage owns the question; if the family also uses another guarded provider, that provider's responses can take over the question after the current decision lapses, but the two are not tracked independently.

## Providers

`lib/adapters.ts` holds one adapter per provider. An adapter names the provider, supplies the words for the question, and turns a response into a reading: `using` (true: billed beyond the plan, false: subscription confirmed, undefined: no signal) and `reset` (epoch milliseconds).

| Provider | Guarded when | Signal |
|---|---|---|
| `anthropic` | active connection is an OAuth credential (Claude Pro/Max via a plugin such as opencode-claude-auth) | `anthropic-ratelimit-unified-overage-in-use: true`; `false` or `anthropic-ratelimit-unified-status: allowed*` confirms subscription usage; reset from `anthropic-ratelimit-unified-reset` |
| `openai` | active connection is an OAuth credential (ChatGPT sign-in, requests go to the Codex backend) | inferred: a 200 with `x-codex-primary-used-percent` or `x-codex-secondary-used-percent` at or above 100 while `x-codex-credits-has-credits` is `True`; reset from the exhausted window's `x-codex-*-reset-at` |

API-key and environment connections are never guarded; their requests only wait if the family is already paused.

The Codex backend does not state that a request was billed to credits, so the OpenAI reading is an inference from the usage headers it returns on every response. The header values at exactly 100% have not been observed yet; the threshold logic is the untested part.

Adding a provider means adding one `Adapter` object and appending it to `adapters`.

## How it fits with other plugins

The guard registers unscoped `http.request` and `http.response` hooks. OpenCode routes a provider over HTTP instead of WebSockets whenever an `http.*` hook applies to it, so Codex requests run over HTTP while this plugin is loaded.

The wait happens in `http.request`, after other plugins that run earlier have built the request. Plugins that inject a short-lived token (opencode-claude-auth resolves the Claude access token in its own `http.request` hook) should run after the guard so the token is resolved once the wait ends. OpenCode activates directory-discovered plugins before plugins listed in `opencode.jsonc`, which puts this plugin ahead of a configured one; that is an observed order, not a documented contract.

## Server requirements

Session-family lookups use the in-process plugin API and work on any server. Forms and interrupts go through the HTTP API of the managed OpenCode service, and the plugin checks that its own process owns the registration in `$XDG_STATE_HOME/opencode/service.json` (default `~/.local/state/opencode/service.json`). On a server that does not own it, requests proceed normally until paid usage is detected; then the family stays paused because the question cannot be shown there.

## State and logs

- `~/.local/state/opencode/overage-guard.json` (honours `XDG_STATE_HOME`): closed gates and time-limited allowances, as session and credential IDs plus reset times. No tokens. Malformed state fails closed rather than being discarded.
- `~/.local/share/opencode/overage-guard.log` (honours `XDG_DATA_HOME`): guard errors and event-stream reconnects only.

Pending forms live in the OpenCode process. After a restart, the next request in a paused family recreates the missing form before proceeding.

## Tests

```
bun test
bunx tsc --noEmit
```

`guard.test.ts` drives the state machine through a fake host; `adapters.test.ts` covers header parsing with captured header sets; `host.test.ts` runs the form and persistence path against a local HTTP server.
