type ToolState = {
  status: string
  input?: unknown
  metadata?: Record<string, unknown>
}

function isBackground(state: ToolState) {
  if (state.status !== "completed") return false
  if (typeof state.input === "object" && state.input !== null && "background" in state.input) {
    if (state.input.background === true) return true
  }
  return state.metadata?.status === "running"
}

export function backgroundShellID(state: ToolState) {
  if (!isBackground(state)) return
  const shellID = state.metadata?.shellID
  return typeof shellID === "string" ? shellID : undefined
}

export function backgroundSubagentSessionID(state: ToolState) {
  if (!isBackground(state)) return
  const sessionID = state.metadata?.sessionID
  return typeof sessionID === "string" ? sessionID : undefined
}
