import { describe, expect, test } from "bun:test"
import { displayedSessionBusy } from "./tui"

describe("displayedSessionBusy", () => {
  test("ignores a busy hidden tab when the active tab is idle", () => {
    expect(
      displayedSessionBusy(
        true,
        [
          { active: false, busy: true },
          { active: true, busy: false },
        ],
        undefined,
        () => false,
      ),
    ).toBe(false)
  })

  test("shows progress when the active tab is busy", () => {
    expect(
      displayedSessionBusy(
        true,
        [
          { active: true, busy: true },
          { active: false, busy: false },
        ],
        undefined,
        () => false,
      ),
    ).toBe(true)
  })

  test("uses the routed session when tabs are disabled", () => {
    expect(displayedSessionBusy(false, [], "session-1", (sessionID) => sessionID === "session-1")).toBe(true)
  })
})
