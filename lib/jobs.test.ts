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

  test("recognizes a foreground shell moved to the background", () => {
    expect(
      backgroundShellID({
        status: "completed",
        input: { command: "sleep 60" },
        metadata: { status: "running", shellID: "sh_example" },
      }),
    ).toBe("sh_example")
  })

  test("ignores a shell that is still blocking in the foreground", () => {
    expect(
      backgroundShellID({
        status: "running",
        input: { command: "sleep 60" },
        metadata: { status: "running", shellID: "sh_example" },
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

  test("recognizes a foreground subagent moved to the background", () => {
    expect(
      backgroundSubagentSessionID({
        status: "completed",
        input: { agent: "general", description: "Sleep" },
        metadata: { status: "running", sessionID: "ses_example" },
      }),
    ).toBe("ses_example")
  })

  test("ignores a subagent that is still blocking in the foreground", () => {
    expect(
      backgroundSubagentSessionID({
        status: "running",
        input: { agent: "general", description: "Sleep" },
        metadata: { status: "running", sessionID: "ses_example" },
      }),
    ).toBeUndefined()
  })
})
