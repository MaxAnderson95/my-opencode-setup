import type { Plugin } from "@opencode-ai/plugin"

const secret = process.env.BRRR_WEBHOOK_SECRET
const endpoint = `https://api.brrr.now/v1/${secret}`
const idleDelay = 1000
const minBusyMs = 300_000
const home = process.env.HOME

export default (async ({ client, directory }) => {
  if (!secret) return {}

  const project = directory === home ? "~/" : directory.split("/").filter(Boolean).at(-1) ?? "opencode"
  const busySince = new Map<string, number>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const sessions = new Map<string, Promise<{ title: string | null; child: boolean }>>()
  const errors = new Map<string, string>()

  const info = (sessionID: string) => {
    const cached = sessions.get(sessionID)
    if (cached) return cached

    const pending = client.session
      .get({ path: { id: sessionID } })
      .then((response) => ({
        title: response.data?.title ?? null,
        child: Boolean(response.data?.parentID),
      }))
      .catch(() => ({ title: null, child: false }))

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

  const lastAssistantText = async (sessionID: string, maxLen = 250) => {
    const result = await client.session
      .messages({ path: { id: sessionID } })
      .catch(() => undefined)
    const msgs = result?.data
    if (!msgs?.length) return undefined
    const last = msgs.findLast((m) => m.info.role === "assistant")
    if (!last) return undefined
    const raw = last.parts
      .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
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

  const send = async (title: string, message: string) => {
    await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title,
        subtitle: project,
        message,
        "interruption-level": "active",
      }),
    }).catch(() => undefined)
  }

  const notify = async (sessionID: string, title: string, message: (name: string) => string) => {
    const session = await info(sessionID)
    if (session.child) return
    await send(title, message(label(session.title)))
  }

  return {
    event: async ({ event }) => {
      if (event.type === "session.error") {
        const err = event.properties.error
        if (err && event.properties.sessionID && err.name !== "MessageAbortedError")
          errors.set(event.properties.sessionID, "data" in err && "message" in err.data ? String(err.data.message) : err.name)
        return
      }

      if (event.type === "session.status" && event.properties.status.type === "busy") {
        if (!busySince.has(event.properties.sessionID))
          busySince.set(event.properties.sessionID, Date.now())
        errors.delete(event.properties.sessionID)
        const timer = timers.get(event.properties.sessionID)
        if (!timer) return
        clearTimeout(timer)
        timers.delete(event.properties.sessionID)
        return
      }

      if (event.type === "permission.asked") {
        if (!longEnough(event.properties.sessionID)) return
        await notify(event.properties.sessionID, "OpenCode needs permission", (name) => `Waiting for approval in ${name}.`)
        return
      }

      if (event.type !== "session.idle") return
      if (!busySince.has(event.properties.sessionID)) return

      const pending = timers.get(event.properties.sessionID)
      if (pending) clearTimeout(pending)

      const sid = event.properties.sessionID
      const timer = setTimeout(async () => {
        timers.delete(sid)
        const wasLongEnough = longEnough(sid)
        busySince.delete(sid)
        const errMsg = errors.get(sid)
        errors.delete(sid)
        if (!wasLongEnough) return
        if (errMsg) {
          void notify(sid, "OpenCode errored", (name) => `${name} failed: ${errMsg}`)
        } else {
          const snippet = await lastAssistantText(sid)
          void notify(sid, "OpenCode finished", (name) => snippet ?? `${name} is done.`)
        }
      }, idleDelay)

      timers.set(event.properties.sessionID, timer)
    },
    "tool.execute.before": async (input) => {
      if (input.tool !== "question") return
      if (!longEnough(input.sessionID)) return
      await notify(input.sessionID, "OpenCode has a question", (name) => `Waiting for your answer in ${name}.`)
    },
  }
}) satisfies Plugin
