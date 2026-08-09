import { tool, type Plugin } from "@opencode-ai/plugin"
import { execFile } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)

const env = (name: string, fallback: number) => {
  const parsed = Number(process.env[name])
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

// HID idle time is the primary signal: a raw nanosecond counter with
// sub-second resolution, reset by any human input device including the ones
// hanging off a dock. Two macOS signals are deliberately NOT used:
//
//   * UserIsActive (pmset -g assertions) lingers for a full 60 minutes after
//     the last input before it times out, and IOPMAssertionDeclareUserActivity
//     is callable by any unprivileged process (that is all `caffeinate -u` is),
//     so a 1 proves nothing and a 0 is just a lagging restatement of idle time.
//   * AppleClamshellState is meaningless for anyone who works docked with the
//     lid shut, since it reads "closed" while they sit right there.
const AT_SECONDS = env("PRESENCE_AT_SECONDS", 90)
const RECENT_SECONDS = env("PRESENCE_RECENT_SECONDS", 300)
const SURE_AWAY_SECONDS = env("PRESENCE_SURE_AWAY_SECONDS", 900)
const PHONE_MIN_BPS = env("PRESENCE_PHONE_MIN_BPS", 250)
const HANDSHAKE_FRESH_SECONDS = env("PRESENCE_HANDSHAKE_FRESH_SECONDS", 120)
// Bounds the worst case: only paid when no usable cached byte sample exists.
const SAMPLE_MS = env("PRESENCE_SAMPLE_MS", 700)
const MAX_BUFFER = 8 << 20
const SAMPLE_FILE = join(tmpdir(), "opencode-presence-phone.json")

type Confidence = "high" | "medium" | "unknown"

const humanDuration = (seconds: number) => {
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

const idleSeconds = async () => {
  // `-d 1` would prune the depth that carries HIDIdleTime, so the full tree is
  // required here.
  const { stdout } = await run("ioreg", ["-c", "IOHIDSystem"], { timeout: 3000, maxBuffer: MAX_BUFFER })
  const match = stdout.match(/"HIDIdleTime"\s*=\s*(\d+)/)
  if (!match) throw new Error("HIDIdleTime missing from ioreg output")
  return Number(match[1]) / 1e9
}

const screenLock = async () => {
  const { stdout } = await run("ioreg", ["-n", "Root", "-d1", "-a"], { timeout: 3000, maxBuffer: MAX_BUFFER })
  const locked = /<key>CGSSessionScreenIsLocked<\/key>\s*<true\/>/.test(stdout)
  const since = stdout.match(/<key>CGSSessionScreenLockedTime<\/key>\s*<integer>(\d+)<\/integer>/)
  return { locked, lockedAt: locked && since ? Number(since[1]) : null }
}

const screensaverRunning = async () => {
  try {
    await run("pgrep", ["-x", "ScreenSaverEngine"], { timeout: 2000 })
    return true
  } catch (error) {
    if ((error as { code?: number }).code === 1) return false
    throw error
  }
}

type PeerSample = { name: string; active: boolean; online: boolean; tx: number; handshakeAgo: number | null }

// The GUI app's binary reports "Tailscale is stopped" whenever the daemon is a
// separate userspace tailscaled, so it is tried last.
const binaries = [
  process.env.PRESENCE_TAILSCALE_BIN,
  "tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
].filter((candidate): candidate is string => Boolean(candidate))

// `null` means "no --socket flag", i.e. whatever daemon the CLI defaults to.
// An explicitly configured socket has to be tried before that default, because
// a machine can run both a userspace tailscaled and the GUI app's daemon.
const sockets: (string | null)[] = [process.env.PRESENCE_TAILSCALE_SOCKET, null].filter(
  (candidate): candidate is string | null => candidate !== undefined,
)
sockets.splice(sockets.length - 1, 0, join(homedir(), ".config/tailscale/tailscaled.sock"))

type Status = {
  BackendState?: string
  Peer?: Record<string, { DNSName?: string; OS?: string; Active?: boolean; Online?: boolean; TxBytes?: number; LastHandshake?: string }>
}

const mobilePeer = async (): Promise<PeerSample | null> => {
  let status: Status | undefined
  for (const binary of binaries) {
    for (const socket of sockets) {
      const args = socket ? [`--socket=${socket}`, "status", "--json"] : ["status", "--json"]
      try {
        const { stdout } = await run(binary, args, { timeout: 4000, maxBuffer: MAX_BUFFER })
        const parsed = JSON.parse(stdout) as Status
        // A stopped daemon still answers with well-formed JSON full of stale
        // peers (Active false, no handshakes), which would otherwise look like
        // an authoritative "phone is not talking to this Mac".
        if (parsed.BackendState === "Running") {
          status = parsed
          break
        }
      } catch {
        continue
      }
    }
    if (status) break
  }
  if (!status) throw new Error("no running tailscale daemon found")

  const now = Date.now()
  const candidates = Object.values(status.Peer ?? {})
    .filter((peer) => peer.OS === "iOS" || peer.OS === "iPadOS")
    .map((peer) => {
      const handshake = peer.LastHandshake ? Date.parse(peer.LastHandshake) : NaN
      return {
        // The JSON's HostName can come back as "localhost" for a phone, so the
        // DNS name is the only dependable label.
        name: (peer.DNSName ?? "mobile").replace(/\..*$/, ""),
        active: Boolean(peer.Active),
        online: Boolean(peer.Online),
        tx: Number(peer.TxBytes ?? 0),
        handshakeAgo: Number.isFinite(handshake) && handshake > 0 ? Math.max(0, (now - handshake) / 1000) : null,
      }
    })
  if (!candidates.length) return null
  return candidates.sort((a, b) => (a.handshakeAgo ?? Infinity) - (b.handshakeAgo ?? Infinity))[0]
}

type Rate = { bytesPerSecond: number; windowSeconds: number } | null

const byteRate = async (peer: PeerSample): Promise<Rate> => {
  const now = Date.now()
  const cached = await readFile(SAMPLE_FILE, "utf8")
    .then((text) => JSON.parse(text) as { at: number; tx: number; name: string })
    .catch(() => null)

  const persist = (tx: number) =>
    writeFile(SAMPLE_FILE, JSON.stringify({ at: Date.now(), tx, name: peer.name })).catch(() => undefined)

  const age = cached ? (now - cached.at) / 1000 : Infinity
  // A counter that went backwards means tailscaled restarted, so the old
  // sample is not comparable.
  const usable = cached && cached.name === peer.name && age >= 2 && age <= 900 && peer.tx >= cached.tx
  if (usable && cached) {
    await persist(peer.tx)
    return { bytesPerSecond: (peer.tx - cached.tx) / age, windowSeconds: Math.round(age) }
  }

  if (SAMPLE_MS <= 0) {
    await persist(peer.tx)
    return null
  }

  await new Promise((resolve) => setTimeout(resolve, SAMPLE_MS))
  const second = await mobilePeer().catch(() => null)
  await persist(second?.tx ?? peer.tx)
  if (!second || second.tx < peer.tx) return null
  return { bytesPerSecond: (second.tx - peer.tx) / (SAMPLE_MS / 1000), windowSeconds: SAMPLE_MS / 1000 }
}

export type Verdict = { atComputer: boolean; confidence: Confidence; reason: string }

export type Evidence = {
  idleSeconds: number | null
  locked: boolean
  saverOn: boolean
  phoneLive: boolean
  streaming: boolean
  phoneBytesPerSecond: number | null
}

// Kept pure and exported so every branch is testable without a real Mac in a
// particular state.
export const decide = ({ idleSeconds, locked, saverOn, phoneLive, streaming, phoneBytesPerSecond }: Evidence): Verdict => {
  let verdict: Verdict

  if (idleSeconds === null) {
    verdict = {
      atComputer: false,
      confidence: "unknown",
      reason: "Could not read HID idle time, so presence is unverified. Assuming away, since a wasted push beats silence.",
    }
  } else if (locked) {
    verdict = {
      atComputer: false,
      confidence: "high",
      reason: `Screen is locked (last input ${humanDuration(idleSeconds)} ago).`,
    }
  } else if (saverOn) {
    verdict = {
      atComputer: false,
      confidence: "high",
      reason: `Screensaver is running and there has been no input for ${humanDuration(idleSeconds)}.`,
    }
  } else if (idleSeconds <= AT_SECONDS) {
    verdict = {
      atComputer: true,
      confidence: "high",
      reason: `Input ${humanDuration(idleSeconds)} ago on an unlocked screen.`,
    }
  } else if (idleSeconds <= RECENT_SECONDS) {
    verdict = {
      atComputer: true,
      confidence: "medium",
      reason: `Screen is unlocked and the last input was ${humanDuration(idleSeconds)} ago, so probably still nearby.`,
    }
  } else if (idleSeconds >= SURE_AWAY_SECONDS) {
    verdict = {
      atComputer: false,
      confidence: "high",
      reason: `No input for ${humanDuration(idleSeconds)}.`,
    }
  } else {
    verdict = {
      atComputer: false,
      confidence: "medium",
      reason: `No input for ${humanDuration(idleSeconds)}, which is past the ${humanDuration(RECENT_SECONDS)} presence window.`,
    }
  }

  if (!verdict.atComputer && phoneLive && idleSeconds !== null) {
    const detail = streaming
      ? ` A phone on the tailnet is actively exchanging data with this Mac${phoneBytesPerSecond ? ` (~${phoneBytesPerSecond} B/s)` : ""}, so a push is likely to be seen right away.`
      : " A phone on the tailnet holds a live connection to this Mac, so a push is likely to be seen."
    return { ...verdict, confidence: "high", reason: verdict.reason + detail }
  }

  if (verdict.atComputer && phoneLive) {
    return { ...verdict, reason: verdict.reason + " A phone is also connected over the tailnet, but recent input wins." }
  }

  return verdict
}

const settle = async <T>(work: Promise<T>) =>
  work.then((value) => ({ ok: true as const, value })).catch((error) => ({ ok: false as const, error: String((error as Error)?.message ?? error) }))

export const presence = async () => {
  const [idle, lock, saver, peer] = await Promise.all([
    settle(idleSeconds()),
    settle(screenLock()),
    settle(screensaverRunning()),
    settle(mobilePeer()),
  ])

  const warnings: string[] = []
  if (!idle.ok) warnings.push(`idle time unavailable: ${idle.error}`)
  if (!lock.ok) warnings.push(`lock state unavailable: ${lock.error}`)
  if (!saver.ok) warnings.push(`screensaver state unavailable: ${saver.error}`)

  const phoneConnected = peer.ok && peer.value !== null && (peer.value.active || peer.value.online)
  // The byte counter is the ground truth for "is this phone actually talking to
  // this Mac", so it is sampled whenever a peer exists rather than trusting
  // tailscale's own Active flag, which drops to false the moment a live
  // connection goes quiet for a few seconds.
  const rate = peer.ok && peer.value ? await byteRate(peer.value).catch(() => null) : null
  const streaming = rate !== null && rate.bytesPerSecond >= PHONE_MIN_BPS
  // WireGuard rekeys roughly every two minutes while traffic flows, so a
  // handshake older than that means the tunnel has been idle.
  const handshakeFresh =
    peer.ok && peer.value?.handshakeAgo !== null && (peer.value?.handshakeAgo ?? Infinity) <= HANDSHAKE_FRESH_SECONDS
  const phoneLive = phoneConnected && (Boolean(peer.ok && peer.value?.active) || streaming || handshakeFresh)

  const phone = !peer.ok
    ? { unavailable: peer.error }
    : peer.value === null
      ? { present: false, note: "no iOS/iPadOS peer on this tailnet" }
      : {
          present: true,
          name: peer.value.name,
          active: peer.value.active,
          online: peer.value.online,
          live: phoneLive,
          streaming,
          bytesPerSecond: rate ? Math.round(rate.bytesPerSecond) : null,
          sampleWindowSeconds: rate ? rate.windowSeconds : null,
          lastHandshakeSecondsAgo: peer.value.handshakeAgo === null ? null : Math.round(peer.value.handshakeAgo),
        }

  const locked = lock.ok ? lock.value.locked : false
  const saverOn = saver.ok ? saver.value : false
  const idleValue = idle.ok ? idle.value : null

  const { atComputer, confidence, reason } = decide({
    idleSeconds: idleValue,
    locked,
    saverOn,
    phoneLive,
    streaming,
    phoneBytesPerSecond: rate ? Math.round(rate.bytesPerSecond) : null,
  })

  const lastInputAt = idleValue === null ? null : new Date(Date.now() - idleValue * 1000).toISOString()

  return {
    atComputer,
    confidence,
    reason,
    idleSeconds: idleValue === null ? null : Math.round(idleValue),
    idleHuman: idleValue === null ? null : humanDuration(idleValue),
    lastInputAt,
    signals: {
      screenLocked: lock.ok ? locked : null,
      screenLockedAt: lock.ok && lock.value.lockedAt ? new Date(lock.value.lockedAt * 1000).toISOString() : null,
      screensaverRunning: saver.ok ? saverOn : null,
      phone,
    },
    thresholdsSeconds: { atComputer: AT_SECONDS, recent: RECENT_SECONDS, sureAway: SURE_AWAY_SECONDS },
    degraded: warnings.length > 0,
    warnings,
  }
}

export const PresencePlugin: Plugin = async () => {
  if (process.platform !== "darwin") return {}

  return {
    tool: {
      is_user_at_computer: tool({
        description:
          "Check whether the user is physically at their Mac right now, to decide where to put something that needs their attention. " +
          "Returns atComputer (boolean) with a confidence level, the reason, and the underlying signals: keyboard/mouse idle time, " +
          "screen lock and screensaver state, and whether a phone on the tailnet holds a live connection to this Mac. " +
          "atComputer false means send it to their phone instead (e.g. a Hark notification or approval prompt) rather than writing it " +
          "only into the session; atComputer true means they are looking at the screen, so answer in the session and do not push. " +
          "Use before sending a phone notification, before blocking on an approval or question in a long-running task, and when " +
          "deciding whether to wait for a reply or keep working.",
        args: {},
        async execute() {
          const result = await presence()
          const phone =
            "present" in result.signals.phone && result.signals.phone.present && result.signals.phone.live
              ? " · phone live"
              : ""
          const state = result.atComputer ? "At computer" : "Away"
          const idle = result.idleHuman ? ` · ${result.idleHuman} idle` : ""
          return {
            title: `${state} (${result.confidence})${idle}${phone}`,
            output: JSON.stringify(result, null, 2),
            metadata: result,
          }
        },
      }),
    },
  }
}

export default PresencePlugin
