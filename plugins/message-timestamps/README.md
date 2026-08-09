# message-timestamps

Gives the model a clock.

OpenCode's system prompt carries only `Today's date`, at day granularity. So a model has no idea whether the last tool call ran two seconds or two days ago, and a session resumed with `opencode -s <id>` a week later reads as if the conversation never paused. This plugin stamps wall-clock time into the conversation itself.

## What it adds

**1. Every user message** gets a synthetic timestamp part:

```
<time>2026-07-27T14:06:43-04:00 (Mon)</time>
```

ISO 8601 in local time with a real UTC offset, so the model can line the stamp up against log timestamps without guessing the timezone. Two extras appear as visible message text only when they are large enough to matter:

- an **idle gap** marker when the session has been quiet (default > 30 min), read from the server rather than from memory so a session resumed days later reports the true gap
- the **previous turn's duration** (default > 2 min)

Qualifying context is shown above the user's prompt in the same message:

```
Session resumed after 35m · Previous turn took 5m

Your prompt starts here.
```

**2. Tool results** are stamped selectively, so a long agentic turn keeps reporting the time instead of leaving the model anchored to the reading it got when the turn began. A result is stamped when the tool itself was slow (default > 30 s) or when the model's last clock reading has gone stale (default > 10 min).

## Why it works this way

- **`chat.message`, not the system prompt.** The stamp is written once at message creation and persisted with the message, so the request prefix stays byte-identical across turns and prompt caching keeps working. Injecting the current time into the system prompt would invalidate the whole cache on every request, since caching is exact-prefix matching. Stamping only the newest message and dropping it next turn would rewrite history and invalidate everything from that point on.
- **Routine clock parts are marked `synthetic`**, which keeps them out of the TUI transcript while still sending them to the model. Qualifying idle-gap and turn-duration context is a non-synthetic part so it is also visible to the user.
- **Assistant messages are left alone.** Their parts are replayed verbatim and are position-sensitive for signed reasoning blocks, so injecting text risks provider rejection for no information the surrounding user stamps do not already carry.
- **`tool-timing` is not a substitute.** That plugin writes `output.title`, and titles never reach the model; tool results are assembled from `part.state.output` alone.

## Configuration

All via environment variables. Thresholds are ignored if unparseable or negative.

| Variable | Default | Effect |
|---|---|---|
| `OPENCODE_MESSAGE_TIMESTAMPS` | on | Set to `0` to disable the plugin entirely |
| `OPENCODE_MESSAGE_TIMESTAMPS_TOOLS` | on | Set to `0` to stamp only user messages, not tool results |
| `OPENCODE_MESSAGE_TIMESTAMP_GAP_MINUTES` | `30` | Idle gap before a session-was-quiet marker is added |
| `OPENCODE_MESSAGE_TIMESTAMP_TURN_MINUTES` | `2` | Previous-turn duration before it is reported |
| `OPENCODE_MESSAGE_TIMESTAMP_TOOL_SECONDS` | `30` | Tool duration before its result is stamped |
| `OPENCODE_MESSAGE_TIMESTAMP_INTERVAL_MINUTES` | `10` | How stale the model's last clock reading may get before the next tool result is stamped |
