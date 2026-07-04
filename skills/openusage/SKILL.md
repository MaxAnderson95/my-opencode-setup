---
name: openusage
description: Show Max's AI-subscription usage and rate limits (session/weekly/monthly, credits, token spend) by reading the local OpenUsage menu-bar app's HTTP API. Use when Max asks about AI usage or limits, how much of a plan is left, when a limit resets, whether he's rate limited, his token spend/cost, or mentions "OpenUsage", "/usage", "my limits", or a specific provider's usage (Claude, Codex, Copilot, OpenCode Go, Cursor). Works in any client (OpenChamber, web UI, TUI) since the agent fetches the data itself.
---

# OpenUsage — AI usage & limits

Reads usage data from the locally running **OpenUsage** macOS menu-bar app
(`robinebers/openusage`), which exposes a read-only HTTP API on `127.0.0.1:6736`.

## Quick start

Run the bundled formatter and emit its output directly to Max:

```sh
~/.config/opencode/skills/openusage/scripts/usage.sh            # all enabled providers
~/.config/opencode/skills/openusage/scripts/usage.sh codex      # one provider
```

The script returns ready-to-show markdown (provider, plan, limit bars with
reset times, token spend, status). Present it as-is or lightly summarize for
the specific thing Max asked (e.g. just the reset time, or just Claude).

Valid provider ids: `claude`, `codex`, `copilot`, `opencode-go`, `cursor`
(the single-provider form also works for disabled providers, returning their
last cached snapshot).

## Why a script (not raw curl)

The OpenUsage payload is a tagged-union `lines[]` array (`progress`, `text`,
`badge`, `barChart`). The script handles the parsing, percent/credit
formatting, reset-time math, and error cases deterministically — no need to
hand-write `jq`. Just run it.

## Important behaviors

- **Loopback only.** The API binds `127.0.0.1`, so the script must run on the
  same machine OpenUsage runs on. The agent's shell already runs on the opencode
  **server host** (Max's Mac), which is where OpenUsage lives — so it works no
  matter which UI Max is viewing from (OpenChamber/web/TUI).
- **Rate-limited / missing limits.** OpenUsage only caches *successful* probes.
  When a provider's live fetch is rate-limited, it shows a status badge and
  last-good token estimates but may have **no `progress` (limit) lines**. The
  script surfaces the badge; don't claim a limit is "0%" if there's no progress
  line — say the live limit fetch is unavailable.
- **Staleness.** Each provider has a `fetchedAt`. The script appends a
  "data is ~N old" note when a snapshot is stale; mention it if Max relies on
  the numbers being current.
- **Not running.** If port 6736 is closed the script says so — tell Max the
  OpenUsage app isn't running (or its API port was taken).

## Endpoint reference

- `GET /v1/usage` → array of snapshots for **enabled** providers.
- `GET /v1/usage/:providerId` → one snapshot; `200` ok, `204` known-but-no-cache,
  `404` unknown provider. The script maps all of these to friendly output.
