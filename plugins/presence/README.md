# presence

Exposes one tool, **`is_user_at_computer`**, so the agent can tell whether you are physically at your Mac before deciding where to put something that needs your attention: answer in the session, or push it to your phone.

macOS only. On any other platform the plugin registers nothing, so it costs no tool-schema context.

## The tool

Zero arguments. Returns a JSON object whose headline field is a boolean:

```json
{
  "atComputer": false,
  "confidence": "high",
  "reason": "Screen is locked (last input 9h 19m ago). A phone on the tailnet is actively exchanging data with this Mac (~27000 B/s), so a push is likely to be seen right away.",
  "idleSeconds": 33573,
  "idleHuman": "9h 19m",
  "lastInputAt": "2026-07-27T17:03:08.990Z",
  "signals": {
    "screenLocked": true,
    "screenLockedAt": "2026-07-27T17:08:09.000Z",
    "screensaverRunning": false,
    "phone": {
      "present": true,
      "name": "max-iphone",
      "active": true,
      "online": true,
      "live": true,
      "streaming": true,
      "bytesPerSecond": 27000,
      "sampleWindowSeconds": 61,
      "lastHandshakeSecondsAgo": 12
    }
  },
  "thresholdsSeconds": { "atComputer": 90, "recent": 300, "sureAway": 900 },
  "degraded": false,
  "warnings": []
}
```

`confidence` is `high`, `medium`, or `unknown`. `degraded` plus `warnings` flag any collector that failed; the verdict is still returned.

## Signals, and why these ones

| Signal | Source | Role |
|---|---|---|
| HID idle time | `ioreg -c IOHIDSystem` → `HIDIdleTime` | **Primary.** Raw nanosecond counter since the last input from any human input device, including ones on a dock. Sub-second resolution, no timeout of its own, so the thresholds are ours to choose. |
| Screen lock | `ioreg -n Root -d1 -a` → `CGSSessionScreenIsLocked` | Hard "away" override, even at zero idle time. `CGSSessionScreenLockedTime` supplies the timestamp. |
| Screensaver | `pgrep -x ScreenSaverEngine` | Hard "away" override. |
| Phone on the tailnet | `tailscale status --json`, iOS/iPadOS peer | Corroboration only. Raises confidence and explains the verdict; never flips it. |

Two obvious-looking macOS signals are deliberately **not** used:

- **`UserIsActive` power assertion** (`pmset -g assertions`). It lingers a full 60 minutes after the last input before timing out, verified in `pmset -g log`, so a `1` can mean "typed 59 minutes ago." And `IOPMAssertionDeclareUserActivity` is callable by any unprivileged process (that is all `caffeinate -u` is), so it is trivially spoofed. A `0` is just a lagging, lower-resolution restatement of idle time.
- **`AppleClamshellState`**. It reads "closed" for anyone working docked with the lid shut, i.e. permanently, for some setups.

## Decision table

Evaluated in order. The first match wins.

| Condition | `atComputer` | Confidence |
|---|---|---|
| Idle time unreadable | `false` | `unknown` |
| Screen locked | `false` | `high` |
| Screensaver running | `false` | `high` |
| Idle ≤ 90s | `true` | `high` |
| Idle ≤ 300s | `true` | `medium` |
| Idle ≥ 900s | `false` | `high` |
| Otherwise (300s to 900s) | `false` | `medium` |

Then, if the verdict is "away" and a phone holds a live connection, confidence is raised to `high` and the reason says so. If the verdict is "at computer," a connected phone is noted but recent input still wins.

When idle time cannot be read the plugin fails toward `false`, on the logic that a wasted push beats silence.

## The phone signal

A phone counts as `live` when an iOS/iPadOS peer is `Online` and at least one of: tailscale's own `Active` flag, a byte rate above `PRESENCE_PHONE_MIN_BPS`, or a WireGuard handshake newer than `PRESENCE_HANDSHAKE_FRESH_SECONDS` (WireGuard rekeys roughly every two minutes while traffic flows, so an older handshake means an idle tunnel).

The byte rate is the ground truth, since `Active` drops to `false` as soon as a live connection goes quiet for a few seconds. Rate needs two samples, so the plugin caches `{at, tx}` in the temp directory on every call and diffs against it. A usable cached sample from 2s to 900s ago makes the call cost about **50 ms**; with no usable sample it takes one extra reading after `PRESENCE_SAMPLE_MS` and costs about **830 ms**. A counter that moved backwards means tailscaled restarted, and that sample is discarded.

Two daemon gotchas, both handled: a machine can run a userspace `tailscaled` alongside the Tailscale GUI app's daemon, and the **stopped** one still answers `status --json` with well-formed JSON full of stale peers. So the plugin requires `BackendState == "Running"` and tries an explicitly configured socket before the CLI default. The GUI app's binary is tried last for the same reason.

## Configuration

All optional environment variables.

| Variable | Default | Meaning |
|---|---|---|
| `PRESENCE_AT_SECONDS` | `90` | Idle time within which presence is high confidence. |
| `PRESENCE_RECENT_SECONDS` | `300` | Idle time still counted as present, at medium confidence. |
| `PRESENCE_SURE_AWAY_SECONDS` | `900` | Idle time past which absence is high confidence. |
| `PRESENCE_PHONE_MIN_BPS` | `250` | Byte rate to a phone peer that counts as streaming. |
| `PRESENCE_HANDSHAKE_FRESH_SECONDS` | `120` | Handshake age still treated as a live tunnel. |
| `PRESENCE_SAMPLE_MS` | `700` | Extra sampling wait when no cached byte sample exists. `0` disables it, giving up rate detection for speed. |
| `PRESENCE_TAILSCALE_BIN` | — | Explicit tailscale binary. |
| `PRESENCE_TAILSCALE_SOCKET` | `~/.config/tailscale/tailscaled.sock`, then the CLI default | Explicit tailscaled socket. |

## Notes

- The decision logic is exported as a pure `decide(evidence)` function, so every branch is testable without putting a real Mac into that state.
- All four collectors run concurrently and each one fails independently.
- Pairs naturally with the `hark` plugin: when `atComputer` is `false`, a Hark push or approval prompt is the right channel.
