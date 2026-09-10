/** Coalesce repeated events, including concurrent deliveries, without logging credentials or payloads. */
export function createDelivery(
  url: string,
  away: () => Promise<boolean>,
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
) {
  const sent = new Map<string, Promise<void>>()
  return async (key: string, payload: { title: string; body: string }) => {
    if (sent.has(key)) return sent.get(key)
    const pending = (async () => {
      if (!(await away())) return false
      try {
        const response = await request(url, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(5_000),
          headers: { "Content-Type": "application/json", "Idempotency-Key": key },
          body: JSON.stringify(payload),
        })
        await response.body?.cancel()
        if (!response.ok) {
          console.warn(`[hark] Notification rejected: HTTP ${response.status}`)
          return false
        }
        return true
      } catch {
        console.warn("[hark] Notification request failed or timed out")
        return false
      }
    })().then((accepted) => {
      if (!accepted) sent.delete(key)
    })
    sent.set(key, pending)
    // Bound process-local deduplication. The HTTP idempotency key also survives
    // eviction and plugin reloads when the same event is redelivered.
    if (sent.size > 512) sent.delete(sent.keys().next().value!)
    return pending
  }
}
