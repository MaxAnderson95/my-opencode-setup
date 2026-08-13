import { Plugin } from "@opencode-ai/plugin"

const endpoint = process.env.HARK_WEBHOOK_URL
const idleDelay = 1000
const minBusyMs = 300_000
const home = process.env.HOME
// Escape hatch for testing the notification path while sitting at the machine.
const alwaysNotify = process.env.HARK_ALWAYS_NOTIFY === "1"
// Hark rejects a body over 2,000 chars or a title over 80 with a 400.
const maxBody = 2000
const maxTitle = 80

export default Plugin.define({
  id: "hark",
  setup: (ctx) => {
    if (!endpoint) return
    const url = endpoint

    type ServerEvent = ReturnType<typeof ctx.event.subscribe> extends AsyncIterable<infer E> ? E : never

    const busySince = new Map<string, number>()
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    const sessions = new Map<string, Promise<{ title: string | null; child: boolean; project: string }>>()
    const errors = new Map<string, string>()
    // The v2 plugin context has no message-listing API, so the finish snippet
    // is assembled from session.text.ended events instead: the buffer always
    // holds the text parts of the newest assistant message, keyed by ordinal.
    const texts = new Map<string, { messageID: string; parts: Map<number, string> }>()

    const info = (sessionID: string) => {
      const cached = sessions.get(sessionID)
      if (cached) return cached

      const pending = ctx.session
        .get({ sessionID })
        .then((session) => ({
          title: session.title ?? null,
          child: session.parentID !== undefined,
          project:
            session.location.directory === home
              ? "~/"
              : (session.location.directory.split("/").filter(Boolean).at(-1) ?? "opencode"),
        }))
        .catch(() => ({ title: null, child: false, project: "opencode" }))

      sessions.set(sessionID, pending)
      return pending
    }

    const longEnough = (sessionID: string) => {
      const start = busySince.get(sessionID)
      return start != null && Date.now() - start >= minBusyMs
    }

    const label = (title: string | null) => {
      if (title && title.trim()) return title.trim()
      return "current session"
    }

    const lastAssistantText = (sessionID: string, maxLen = maxBody) => {
      const entry = texts.get(sessionID)
      if (!entry || entry.parts.size === 0) return undefined
      const raw = [...entry.parts.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, text]) => text)
        .join("")
      if (!raw.trim()) return undefined
      const clean = raw
        .replace(/```[\s\S]*?```/g, "")
        .replace(/[#*_`~>\[\]()!|]/g, "")
        .replace(/\n{2,}/g, "\n")
        .trim()
      if (!clean) return undefined
      if (clean.length <= maxLen) return clean
      const truncated = clean.slice(0, maxLen)
      const boundary = truncated.lastIndexOf(" ")
      return (boundary > maxLen * 0.6 ? truncated.slice(0, boundary) : truncated) + "…"
    }

    const clamp = (text: string, max: number) => {
      const trimmed = text.trim()
      return trimmed.length <= max ? trimmed : trimmed.slice(0, max - 1) + "…"
    }

    // A push is pointless when the notification would land on a phone in his
    // pocket while he is reading the same message on screen. Presence failing
    // (including the module being absent or broken) is treated as "away",
    // because a wasted push beats silence.
    const away = async () => {
      if (alwaysNotify) return true
      try {
        const { presence } = await import("../presence/presence.ts")
        const state = await presence()
        return !state.atComputer
      } catch {
        return true
      }
    }

    // Hark has no subtitle field, so the project rides along in the sender title.
    const send = async (title: string, project: string, body: string) => {
      if (!(await away())) return
      await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: clamp(`${title} · ${project}`, maxTitle),
          body: clamp(body, maxBody),
        }),
      }).catch(() => undefined)
    }

    const notify = async (sessionID: string, title: string, message: (name: string) => string) => {
      const session = await info(sessionID)
      if (session.child) return
      await send(title, session.project, message(label(session.title)))
    }

    // Debounced end-of-execution notification, cancelled if a new execution
    // starts within idleDelay so quick continue prompts do not flap.
    const finish = (sessionID: string) => {
      const pending = timers.get(sessionID)
      if (pending) clearTimeout(pending)

      const timer = setTimeout(() => {
        timers.delete(sessionID)
        const wasLongEnough = longEnough(sessionID)
        busySince.delete(sessionID)
        const errMsg = errors.get(sessionID)
        errors.delete(sessionID)
        const snippet = lastAssistantText(sessionID)
        texts.delete(sessionID)
        if (!wasLongEnough) return
        if (errMsg) {
          void notify(sessionID, "Errored", (name) => `${name} failed: ${errMsg}`)
        } else {
          void notify(sessionID, "Finished", (name) => snippet ?? `${name} is done.`)
        }
      }, idleDelay)

      timers.set(sessionID, timer)
    }

    const handle = (event: ServerEvent) => {
      switch (event.type) {
        case "session.execution.started": {
          const sid = event.data.sessionID
          if (!busySince.has(sid)) busySince.set(sid, Date.now())
          errors.delete(sid)
          const timer = timers.get(sid)
          if (timer) {
            clearTimeout(timer)
            timers.delete(sid)
          }
          return
        }
        case "session.text.ended": {
          const entry = texts.get(event.data.sessionID)
          if (!entry || entry.messageID !== event.data.assistantMessageID) {
            texts.set(event.data.sessionID, {
              messageID: event.data.assistantMessageID,
              parts: new Map([[event.data.ordinal, event.data.text]]),
            })
          } else {
            entry.parts.set(event.data.ordinal, event.data.text)
          }
          return
        }
        case "session.execution.failed": {
          const sid = event.data.sessionID
          if (!busySince.has(sid)) return
          errors.set(sid, event.data.error.message || event.data.error.type)
          finish(sid)
          return
        }
        case "session.execution.succeeded": {
          if (!busySince.has(event.data.sessionID)) return
          finish(event.data.sessionID)
          return
        }
        case "session.execution.interrupted": {
          const sid = event.data.sessionID
          // A user abort still ends the turn, matching v1's post-idle
          // "Finished". Shutdown and supersession are not endings the user
          // needs to hear about: supersession continues under a fresh
          // execution, whose started event finds busySince still set.
          if (event.data.reason === "user") {
            if (busySince.has(sid)) finish(sid)
            return
          }
          const timer = timers.get(sid)
          if (timer) {
            clearTimeout(timer)
            timers.delete(sid)
          }
          return
        }
        case "permission.asked": {
          if (!longEnough(event.data.sessionID)) return
          void notify(event.data.sessionID, "Needs permission", (name) => `Waiting for approval in ${name}.`)
          return
        }
        case "question.asked": {
          if (!longEnough(event.data.sessionID)) return
          void notify(event.data.sessionID, "Has a question", (name) => `Waiting for your answer in ${name}.`)
          return
        }
      }
    }

    const controller = new AbortController()
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms)
        controller.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer)
            resolve()
          },
          { once: true },
        )
      })

    // Setup must not block on the infinite event stream, so consumption runs
    // as a background task that resubscribes if the stream drops.
    const pump = (async () => {
      while (!controller.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) handle(event)
        } catch {
          // Stream dropped or aborted; the loop condition decides what's next.
        }
        if (!controller.signal.aborted) await sleep(1000)
      }
    })()

    return async () => {
      controller.abort()
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      await pump
    }
  },
})
