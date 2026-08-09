# hark

Push notifications to your iPhone (via a [Hark](https://hark.ryan.ceo) webhook) when a long-running OpenCode session needs you or finishes.

## What it does

Listens to session lifecycle events and POSTs to the Hark notification webhook (`$HARK_WEBHOOK_URL`) when:

| Trigger | Notification |
|---|---|
| Session goes idle after working | *"Finished"* — with a cleaned excerpt of the last assistant message, up to Hark's full 2,000-char body (or *"… is done."*). |
| A permission prompt appears | *"Needs permission"* |
| The `question` tool is called | *"Has a question"* |
| The session errors | *"Errored"* — with the error message. |

Hark has no subtitle field, so the project (the last path segment of the session's directory) is appended to the notification title as `<trigger> · <project>`. Everything else — avatar, tap URL — comes from the Hark service defaults.

Bodies use Hark's full **2,000-character** allowance (`maxBody`); the finish excerpt is truncated at a word boundary only if it would exceed that. Titles are clamped to Hark's 80-character limit (`maxTitle`), so an unusually long project name can't trigger a `400`.

## Noise control

- **Only when you're away.** Every notification is gated on the `presence` plugin's `is_user_at_computer` check. If you are sitting at the Mac, nothing is sent, since the push would land in your pocket while you read the same message on screen. If the presence check fails outright, the notification is sent anyway, on the logic that a wasted push beats silence. Set **`HARK_ALWAYS_NOTIFY=1`** to bypass the gate (read once at startup).
- **Only long sessions notify.** A session must have been busy for at least **5 minutes** (`minBusyMs = 300_000`) before any notification fires — quick tasks stay silent.
- **Sub-agent (child) sessions are skipped** — you only hear about top-level sessions.
- Idle notifications are debounced by 1s to avoid flapping.

## Requirements & configuration

- **`HARK_WEBHOOK_URL`** environment variable — the full secret webhook URL from the Hark dashboard (`https://hark.ryan.ceo/hooks/whk_…`). **If it's unset, the plugin is a no-op** (returns immediately). Treat it as a credential.
- A [Hark](https://hark.ryan.ceo) account with the iPhone app registered and a service created.

No other configuration. To tune the thresholds (`idleDelay`, `minBusyMs`, `maxBody`, `maxTitle`), edit the constants at the top of `hark.ts`.
