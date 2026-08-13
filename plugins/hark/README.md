# hark

Push notifications to your iPhone (via a [Hark](https://hark.ryan.ceo) webhook) when a long-running OpenCode session needs you or finishes.

## What it does

Subscribes to the v2 server event stream (`ctx.event.subscribe()`) and POSTs to the Hark notification webhook (`$HARK_WEBHOOK_URL`) when:

| Trigger (v2 event) | Notification |
|---|---|
| `session.execution.succeeded` (also a user-initiated `session.execution.interrupted`) | *"Finished"* — with a cleaned excerpt of the last assistant message, up to Hark's full 2,000-char body (or *"… is done."*). |
| `permission.asked` | *"Needs permission"* |
| `question.asked` | *"Has a question"* |
| `session.execution.failed` | *"Errored"* — with the error message. |

The finish excerpt is assembled from `session.text.ended` events (the v2 plugin context has no message-listing API). The project shown in the title is the last path segment of the **session's** directory, so notifications name the right project even when one server hosts several.

Hark has no subtitle field, so the project is appended to the notification title as `<trigger> · <project>`. Everything else — avatar, tap URL — comes from the Hark service defaults.

Bodies use Hark's full **2,000-character** allowance (`maxBody`); the finish excerpt is truncated at a word boundary only if it would exceed that. Titles are clamped to Hark's 80-character limit (`maxTitle`), so an unusually long project name can't trigger a `400`.

## Noise control

- **Only when you're away.** Every notification is gated on the `presence` plugin's probe (imported lazily from `../presence/presence.ts`). If you are sitting at the Mac, nothing is sent, since the push would land in your pocket while you read the same message on screen. If the presence check (or the module import) fails outright, the notification is sent anyway, on the logic that a wasted push beats silence. Set **`HARK_ALWAYS_NOTIFY=1`** to bypass the gate (read once at startup).
- **Only long sessions notify.** A session must have been executing for at least **5 minutes** (`minBusyMs = 300_000`) before any notification fires — quick tasks stay silent.
- **Sub-agent (child) sessions are skipped** — you only hear about top-level sessions.
- End-of-execution notifications are debounced by 1s; a new execution starting inside that window cancels the pending notification, and shutdown/supersession interruptions never notify.

## Requirements & configuration

- **`HARK_WEBHOOK_URL`** environment variable — the full secret webhook URL from the Hark dashboard (`https://hark.ryan.ceo/hooks/whk_…`). **If it's unset, the plugin is a no-op** (setup registers nothing). Treat it as a credential.
- A [Hark](https://hark.ryan.ceo) account with the iPhone app registered and a service created.

No other configuration. To tune the thresholds (`idleDelay`, `minBusyMs`, `maxBody`, `maxTitle`), edit the constants at the top of `hark.ts`.
