# message-timestamps

Gives the model a clock.

OpenCode's system prompt carries only `Today's date`, at day granularity. So a model has no idea whether the last tool call ran two seconds or two days ago, and a session resumed with `opencode -s <id>` a week later reads as if the conversation never paused. This plugin stamps wall-clock time into the model's context.

## What it adds

**1. Every user prompt** gets a timestamp appended as an extra text part:

```
<time>2026-07-27T14:06:43-04:00 (Mon)</time>
```

ISO 8601 in local time with a real UTC offset, so the model can line the stamp up against log timestamps without guessing the timezone. Two extras are added only when they are large enough to matter:

- an **idle gap** marker when the session had been quiet before that prompt (default > 30 min)
- the **previous turn's duration** (default > 2 min)

```
<time-gap>Session resumed after 35m · Previous turn took 5m</time-gap>
```

**2. Tool results** are stamped selectively, so a long agentic turn keeps reporting the time instead of leaving the model anchored to the reading it got when the turn began. A result is stamped when the tool itself was slow (default > 30 s) or when the model's last clock reading has gone stale (default > 10 min):

```
<time>2026-07-27T14:12:03-04:00 (Mon), took 42s</time>
```

## Why it works this way

- **The v2 `session.hook("context")` rewrites the outbound request on every dispatch; nothing is persisted and nothing appears in the transcript.** Prompt caching is exact-prefix matching, so the transform is strictly deterministic: every stamp is derived from each message's persisted, immutable id, never from `Date.now()` applied to old messages. A message's stamp depends only on itself and the messages before it, so appending new turns never rewrites the cached prefix.
- **Message ids carry their creation instant.** OpenCode ids encode `(epoch_ms << 12 | counter)` truncated to 48 bits, i.e. the low 36 bits of epoch milliseconds (~795-day window). The current clock only anchors which window a message falls in; the recovered instant is exact and stable across dispatches.
- **Only real user prompts are stamped.** Real prompts always carry a metadata object in the dispatched context; synthetic reminders, compaction checkpoints, and shell records are user-role but leave it undefined, so they pass through untouched — matching what the v1 `chat.message` hook covered.
- **Tool-result stamps still use the real clock**, which is cache-safe because the `tool.hook("execute.after")` mutation happens exactly once and the mutated content is persisted with the message, then replayed verbatim. The stamp only ever extends trailing text; results ending in a file (image) are left untouched.
- **Assistant messages are left alone.** Their parts are replayed verbatim and are position-sensitive for signed reasoning blocks, so injecting text risks provider rejection for no information the surrounding user stamps do not already carry.

## Differences from v1

- Stamps are computed at dispatch, not persisted at message creation, so a session's **entire history** (including turns from before the plugin was installed) is stamped on resume.
- The idle gap and turn duration are measured between message **creation** instants (assistant completion times are not available in the dispatched context), so a turn whose final step ran long slightly inflates the following gap and deflates its own reported duration.
- `OC_SHOW_TURN_CLOCK` is gone: nothing this plugin injects is ever visible in the transcript under v2.

## Configuration

All via environment variables, read at plugin activation. Thresholds are ignored if unparseable or negative.

| Variable | Default | Effect |
|---|---|---|
| `OPENCODE_MESSAGE_TIMESTAMPS` | on | Set to `0` to disable the plugin entirely |
| `OPENCODE_MESSAGE_TIMESTAMPS_TOOLS` | on | Set to `0` to stamp only user messages, not tool results |
| `OPENCODE_MESSAGE_TIMESTAMP_GAP_MINUTES` | `30` | Idle gap before a session-was-quiet marker is added |
| `OPENCODE_MESSAGE_TIMESTAMP_TURN_MINUTES` | `2` | Previous-turn duration before it is reported |
| `OPENCODE_MESSAGE_TIMESTAMP_TOOL_SECONDS` | `30` | Tool duration before its result is stamped |
| `OPENCODE_MESSAGE_TIMESTAMP_INTERVAL_MINUTES` | `10` | How stale the model's last clock reading may get before the next tool result is stamped |
