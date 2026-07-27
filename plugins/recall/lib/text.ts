/**
 * Pure text helpers: normalisation, FTS query construction, chunking for
 * embedding, segmentation for indexing, and snippet rendering.
 *
 * Nothing here touches a database or the filesystem, which is what makes the
 * ranking- and chunking-sensitive logic testable in isolation.
 */

// eslint-disable-next-line no-control-regex
export const ANSI_RE =
  /[\u001b\u009b](?:\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\[[0-9;?]*[0-9A-ORZcf-nqry=><]|[()#][0-9A-Za-z])/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "")
}

export function clean(text: string, max: number): string {
  const out = stripAnsi(text).replace(/\s+/g, " ").trim()
  return out.length > max ? out.slice(0, max) + "…" : out
}

export function shortDir(dir: string, home: string): string {
  return home && dir.startsWith(home) ? "~" + dir.slice(home.length) : dir
}

export function fmtDate(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function fmtDateTime(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${fmtDate(ms)} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export const TOKEN_RE = /[\p{L}\p{N}_./@-]+/gu

export function queryTokens(query: string): string[] {
  return query.match(TOKEN_RE) ?? []
}

/** FTS5 MATCH treats many characters as operators; quote every token. */
export function ftsQuery(query: string, op: "AND" | "OR"): string | undefined {
  const tokens = queryTokens(query)
  if (!tokens.length) return undefined
  return tokens.map((t) => `"${t.replaceAll('"', "")}"`).join(` ${op} `)
}

/**
 * Split text into non-overlapping segments for FTS indexing.
 *
 * Long parts are split rather than truncated: nothing becomes unsearchable, and
 * BM25 length normalisation stops being skewed by the occasional 400 KB message.
 * Breaks prefer a newline, then whitespace, near the end of each segment.
 */
export function segmentText(text: string, size: number): { start: number; text: string }[] {
  if (size <= 0 || text.length <= size) return text.trim() ? [{ start: 0, text }] : []
  const out: { start: number; text: string }[] = []
  let pos = 0
  while (pos < text.length) {
    let end = Math.min(pos + size, text.length)
    if (end < text.length) {
      const window = text.slice(pos + Math.floor(size * 0.6), end)
      const nl = window.lastIndexOf("\n")
      const sp = window.lastIndexOf(" ")
      const rel = nl >= 0 ? nl : sp
      if (rel >= 0) end = pos + Math.floor(size * 0.6) + rel + 1
    }
    const slice = text.slice(pos, end)
    if (slice.trim()) out.push({ start: pos, text: slice })
    pos = end
  }
  return out
}

/**
 * Sliding-window chunking for embedding.
 *
 * The previous implementation truncated each side of a turn to 900 characters,
 * which embedded roughly 30% of the prose in long agent turns; everything past
 * the cut was reachable by keyword but invisible to semantic search. Windowing
 * keeps the whole turn addressable at a fixed cost per chunk.
 *
 * `maxChars` bounds pathological turns by keeping the head and the tail, which
 * is where a turn's intent and its outcome live.
 */
export function chunkText(text: string, size: number, overlap: number, maxChars: number): string[] {
  const t = text.trim()
  if (!t) return []
  const stride = Math.max(1, size - overlap)
  let body = t
  if (maxChars > 0 && t.length > maxChars) {
    const half = Math.floor(maxChars / 2)
    body = t.slice(0, half) + "\n…\n" + t.slice(t.length - half)
  }
  if (body.length <= size) return [body]
  const out: string[] = []
  for (let pos = 0; pos < body.length; pos += stride) {
    const chunk = body.slice(pos, pos + size)
    if (chunk.trim()) out.push(chunk)
    if (pos + size >= body.length) break
  }
  return out
}

/**
 * Render a highlighted excerpt around the densest cluster of query terms.
 *
 * Contentless FTS5 tables cannot serve `snippet()` (there is no stored copy of
 * the text to snip), so snippets are produced here from the source text
 * instead. That also means excerpts come from the untruncated original.
 */
export function makeSnippet(
  text: string,
  tokens: string[],
  width = 220,
  open = "«",
  close = "»",
): string {
  const flat = stripAnsi(text).replace(/\s+/g, " ").trim()
  if (!flat) return ""
  const lower = flat.toLowerCase()
  const wanted = [...new Set(tokens.map((t) => t.toLowerCase()).filter(Boolean))]

  type Occ = { start: number; end: number; token: string }
  const occs: Occ[] = []
  for (const tok of wanted) {
    let from = 0
    for (let n = 0; n < 200; n++) {
      const i = lower.indexOf(tok, from)
      if (i < 0) break
      occs.push({ start: i, end: i + tok.length, token: tok })
      from = i + tok.length
    }
  }
  if (!occs.length) return flat.length > width ? flat.slice(0, width) + "…" : flat
  occs.sort((a, b) => a.start - b.start)

  // Pick the window covering the most distinct query terms.
  let best = { start: occs[0].start, distinct: 0 }
  for (let i = 0; i < occs.length; i++) {
    const from = occs[i].start
    const seen = new Set<string>()
    for (let j = i; j < occs.length && occs[j].start < from + width; j++) seen.add(occs[j].token)
    if (seen.size > best.distinct) best = { start: from, distinct: seen.size }
  }

  const pad = Math.floor(width / 4)
  let start = Math.max(0, best.start - pad)
  let end = Math.min(flat.length, start + width)
  start = Math.max(0, Math.min(start, flat.length - width))
  if (start > 0) {
    const sp = flat.indexOf(" ", start)
    if (sp >= 0 && sp < start + 20) start = sp + 1
  }
  end = Math.min(flat.length, start + width)

  let out = ""
  let cursor = start
  for (const o of occs) {
    if (o.start < cursor) continue
    if (o.start >= end) break
    out += flat.slice(cursor, o.start) + open + flat.slice(o.start, o.end) + close
    cursor = o.end
  }
  out += flat.slice(cursor, end)
  return (start > 0 ? "…" : "") + out.trim() + (end < flat.length ? "…" : "")
}

/**
 * Keep the head and tail of a list of blocks within a character budget.
 * A session's goals live at the start and its outcomes at the end, so the
 * middle is what gets dropped.
 */
export function middleOut(blocks: string[], budget: number, note: (omitted: number, total: number) => string): string {
  const total = blocks.reduce((n, b) => n + b.length + 1, 0)
  if (total <= budget) return blocks.join("\n")
  const head: string[] = []
  const tail: string[] = []
  let used = 0
  let lo = 0
  let hi = blocks.length - 1
  while (lo <= hi) {
    const takeHead = head.length <= tail.length
    const b = takeHead ? blocks[lo] : blocks[hi]
    if (used + b.length + 1 > budget) break
    used += b.length + 1
    if (takeHead) head.push(blocks[lo++])
    else tail.unshift(blocks[hi--])
  }
  return [...head, note(hi - lo + 1, blocks.length), ...tail].join("\n")
}
