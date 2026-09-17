import { describe, expect, test } from "bun:test"
import { resume } from "./tui"

type ResumeContext = Parameters<typeof resume>[0]

function context(options: { sessions?: string[]; syncError?: Error } = {}) {
  const dispatched: Array<{ id: string; input?: string }> = []
  const navigated: string[] = []
  const toasts: Array<{ title?: string; message: string; variant?: string }> = []
  const sessions = new Set(options.sessions ?? [])

  const value = {
    data: {
      session: {
        sync: async () => {
          if (options.syncError) throw options.syncError
        },
        get: (sessionID: string) => (sessions.has(sessionID) ? { id: sessionID } : undefined),
      },
    },
    keymap: {
      dispatch: (id: string, input?: string) => dispatched.push({ id, input }),
    },
    ui: {
      router: {
        navigate: (route: { type: string; sessionID?: string }) => {
          if (route.type === "session" && route.sessionID) navigated.push(route.sessionID)
        },
      },
      toast: {
        show: (toast: { title?: string; message: string; variant?: string }) => toasts.push(toast),
      },
    },
  } as unknown as ResumeContext

  return { value, dispatched, navigated, toasts }
}

describe("resume", () => {
  test("keeps the existing session picker for an empty argument", async () => {
    const fixture = context()

    await resume(fixture.value, "  ")

    expect(fixture.dispatched).toEqual([{ id: "session.list", input: undefined }])
    expect(fixture.navigated).toEqual([])
  })

  test("syncs and opens a session by ID", async () => {
    const fixture = context({ sessions: ["ses_abc123"] })

    await resume(fixture.value, "  ses_abc123  ")

    expect(fixture.navigated).toEqual(["ses_abc123"])
    expect(fixture.toasts).toEqual([])
  })

  test("reports an unknown session without navigating", async () => {
    const fixture = context()

    await resume(fixture.value, "ses_missing")

    expect(fixture.navigated).toEqual([])
    expect(fixture.toasts).toEqual([
      {
        title: "Failed to resume session",
        message: "Session ses_missing was not found",
        variant: "error",
      },
    ])
  })

  test("reports a session sync failure", async () => {
    const fixture = context({ syncError: new Error("Session request failed") })

    await resume(fixture.value, "ses_broken")

    expect(fixture.navigated).toEqual([])
    expect(fixture.toasts[0]?.message).toBe("Session request failed")
  })
})
