import { describe, expect, test } from "bun:test"
import { backgroundShellID, backgroundSubagentSessionID } from "./jobs"

describe("backgroundShellID", () => {
  test("recognizes a completed tool call whose shell continues in the background", () => {
    expect(
      backgroundShellID({
        status: "completed",
        input: { command: "sleep 60", background: true },
        metadata: { status: "running", shellID: "sh_example" },
      }),
    ).toBe("sh_example")
  })

  test("ignores foreground shell calls", () => {
    expect(
      backgroundShellID({
        status: "completed",
        input: { command: "sleep 60" },
        metadata: { status: "completed" },
      }),
    ).toBeUndefined()
  })
})

describe("backgroundSubagentSessionID", () => {
  test("recognizes a completed tool call whose subagent continues in the background", () => {
    expect(
      backgroundSubagentSessionID({
        status: "completed",
        input: { agent: "general", description: "Sleep", background: true },
        metadata: { status: "running", sessionID: "ses_example" },
      }),
    ).toBe("ses_example")
  })
})
