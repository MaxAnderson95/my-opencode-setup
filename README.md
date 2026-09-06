# token-refresh

Keeps every OAuth credential OpenCode has stored fresh, including accounts that are not currently active.

## Why

OpenCode 2 refreshes a credential only when something calls `Integration.connection.resolve()` on it, and that happens for the *active* connection of a provider when a request is made. A second account on the same provider is never resolved, so its access token expires and stays expired until you switch to it. Anything that wants to read those tokens (a usage meter, for example) sees dead tokens for every non-active account.

## How it works

Every two minutes (plus up to a minute of random jitter) the plugin lists every integration and calls `ctx.integration.connection.resolve()` on each stored credential. Core owns the decision and the mechanics: it refreshes only when under five minutes of validity remain, calls the provider method's registered `refresh` (built-in or from another plugin), and writes the new token back to the database. This plugin never touches tokens or the token endpoints itself.

API keys are skipped after the first look. Environment-variable connections are skipped.

When a refresh throws (typically a revoked or expired refresh token), that credential is retried with exponential backoff starting at 15 minutes and capped at 6 hours, and the failure is logged once per attempt.

## Multiple server processes

A server process loads the plugin once per project instance, but runs a single loop per process (borrowing whichever instance context is alive). Every running `opencode serve` therefore runs one loop against the shared database. The jitter spreads their ticks apart, so when a token falls due one process refreshes it and the others see the new expiry on their next `resolve()`. The remaining race is two ticks landing within the same in-flight refresh call, which the jitter makes rare but not impossible.

## Log

`~/.local/share/opencode/token-refresh.log` (honours `XDG_DATA_HOME`). Each process writes one `watching N oauth credentials` line after its first pass, then one line per refresh it performed, per failure, and per recovery; silent otherwise. Other processes seeing the new expiry do not log it.

A process decides it performed the refresh when the credential was inside core's five-minute window going in, the expiry changed, and `resolve()` took at least 50ms. A refresh is a token-endpoint round trip; reading an already-fresh credential from the database takes a millisecond or two.

```
2026-09-06T17:31:26.273Z pid=76748 watching 9 oauth credentials
2026-09-06T17:33:52.177Z pid=76748 refreshed anthropic/Personal expires=2026-09-07T01:33:52.175Z took=310ms
2026-09-06T17:42:53.070Z pid=12458 failed openai/Work attempt=1 retry_in=15m: Request failed: 401
```
