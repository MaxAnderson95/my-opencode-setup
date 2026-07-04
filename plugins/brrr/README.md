# brrr

Push notifications to your phone (via a [brrr.now](https://brrr.now) webhook) when a long-running OpenCode session needs you or finishes.

## What it does

Listens to session lifecycle events and POSTs a notification to `https://api.brrr.now/v1/$BRRR_WEBHOOK_SECRET` when:

| Trigger | Notification |
|---|---|
| Session goes idle after working | *"OpenCode finished"* — with a cleaned snippet of the last assistant message (or *"… is done."*). |
| A permission prompt appears | *"OpenCode needs permission"* |
| The `question` tool is called | *"OpenCode has a question"* |
| The session errors | *"OpenCode errored"* — with the error message. |

Each notification's **subtitle** is the project (the last path segment of the session's directory), and the interruption level is `active`.

## Noise control

- **Only long sessions notify.** A session must have been busy for at least **5 minutes** (`minBusyMs = 300_000`) before any notification fires — quick tasks stay silent.
- **Sub-agent (child) sessions are skipped** — you only hear about top-level sessions.
- Idle notifications are debounced by 1s to avoid flapping.

## Requirements & configuration

- **`BRRR_WEBHOOK_SECRET`** environment variable — your brrr.now webhook secret. **If it's unset, the plugin is a no-op** (returns immediately).
- A [brrr.now](https://brrr.now) account/webhook to receive the notifications.

No other configuration. To tune the thresholds (`idleDelay`, `minBusyMs`), edit the constants at the top of `brrr.ts`.
