type ToolState = {
  status: string
  input?: unknown
  metadata?: Record<string, unknown>
}

export function backgroundShellID(state: ToolState) {
  if (typeof state.input !== "object" || state.input === null || !("background" in state.input)) return
  if (state.input.background !== true) return
  const shellID = state.metadata?.shellID
  return typeof shellID === "string" ? shellID : undefined
}

export function backgroundSubagentSessionID(state: ToolState) {
  if (typeof state.input !== "object" || state.input === null || !("background" in state.input)) return
  if (state.input.background !== true) return
  const sessionID = state.metadata?.sessionID
  return typeof sessionID === "string" ? sessionID : undefined
}
