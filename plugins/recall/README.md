# recall

Hybrid lexical + semantic search over **all past OpenCode conversations on this machine** — every project, full history. Gives the agent long-term conversational memory, entirely local.

Replaces ad-hoc SQL spelunking in the OpenCode database with a proper index: FTS5/BM25 for exact terms (including tool outputs and reasoning) fused with embedding similarity for fuzzy "we talked about this once" recall.

The tools form an **escalation ladder** — each rung costs more than the last, and the descriptions steer the agent to climb in order:

| Rung | Question | Tool | Cost |
|---|---|---|---|
| corpus → sessions | "which thread was that?" | `recall_search` | ~ms, local |
| session → locations | "where in this session is X?" | `recall_inspect` | ~ms, local |
| location → transcript | "show me around that point" | `recall_expand` | ~ms, local |
| session → digested answer | "just tell me the story" | `recall_summarize` | 10–30 s, worker model |

## Tools

### `recall_search`

Ranked session search. Lexical and semantic branches run in parallel and are fused with Reciprocal Rank Fusion (grouped by session, only the best 3 hits per branch count toward a session's score so many weak matches can't drown out one strong hit).

| Arg | Default | Description |
|---|---|---|
| `query` | — | Natural language or exact keywords/identifiers |
| `mode` | `hybrid` | `hybrid` fuses both branches; `lexical` = exact terms only; `semantic` = meaning only |
| `directory` | — | Substring filter on the session working directory |
| `since` / `until` | — | ISO date bounds |
| `include_tools` | `true` | Include tool outputs (bash/file contents) in lexical matching |
| `limit` | 8 | Max sessions returned |

Lexical queries are safe against FTS5 operator injection (every token is quoted) and fall back from AND to OR matching when a multi-word query has no strict match.

**Current-session handling:** hits from the calling session are excluded — the model can already see them — *except* hits from before the session's last compaction, which are included and labeled `← THIS session, before its last compaction`. That makes `recall_search` a recovery path for details lost to context compaction. The boundary is the latest assistant message with `summary = 1` in the source DB.

### `recall_expand`

Reads a transcript excerpt around a hit: user/assistant turns with timestamps and one-line tool-call summaries (consecutive identical calls collapse to `[tool edit] file (×8)`).

| Arg | Default | Description |
|---|---|---|
| `session_id` | — | `ses_...` id or slug from `recall_search` |
| `message_id` | end of session | `msg_...` to center the window on |
| `window` | 12 (2–60) | Number of messages |
| `max_chars` | 800 (100–4000) | Per-message truncation |

Slugs are not unique across sessions; an exact id always wins, otherwise the newest slug match is shown and alternates are listed.

### `recall_inspect`

Looks inside one session — the cheap middle rung between finding a session and delegating it to the summarizer. With a `query`, it hybrid-searches *within* that session and returns message-level hits in **chronological order** with `message_id`s ready for `recall_expand`. Without a query, it returns an **outline**: the session's user turns (its intent skeleton), so "what happened here?" often needs no model at all.

| Arg | Default | Description |
|---|---|---|
| `session_id` | — | `ses_...` id or slug |
| `query` | — | Search within the session; omit for the user-turn outline |
| `mode` | `hybrid` | `lexical` / `semantic` as in `recall_search` |
| `include_tools` | `true` | Include tool outputs in lexical matching |
| `limit` | 12 | Max hits in query mode |

Two scoped-search subtleties:

- The lexical filter is applied **in the FTS query itself**, not as a post-filter — a globally common term's top-500 BM25 rows might not include this session's rows at all.
- In hybrid mode, semantic hits below cosine **0.55** are dropped: within a single session there's no cross-session competition to bury weak matches, and cosine always returns top-k even for irrelevant queries (bge-small scores junk at ~0.45–0.52, real matches ~0.58+). Explicit `mode=semantic` skips the filter and gives the raw ranking.

### `recall_summarize`

The **escalation rung**: summarizes an entire session — or answers a focused question about it — by offloading to a cheap, fast, large-context model (**GLM-5.2 via OpenCode Go**, provider `opencode-go`; deliberately not OpenCode Zen) instead of spending the main model's context on transcript reading. Reach for it when `recall_inspect`/`recall_expand` can't answer cleanly, the session is too large to page, or the whole-session story is genuinely what's needed.

| Arg | Default | Description |
|---|---|---|
| `session_id` | — | `ses_...` id or slug (same resolution rules as `recall_expand`) |
| `session_ids` | — | Batch: several ids/slugs summarized **concurrently** in one call (max 24, 4 workers in parallel) |
| `focus` | — | Optional question to answer from each transcript instead of a general summary |
| `refresh` | `false` | Bypass the cache and re-summarize |

Mechanics:

- The transcript is compacted (collapsed tool one-liners, trimmed text) and middle-out truncated to a 300k-char budget — goals live at the start of a session, outcomes at the end, so the middle goes first.
- The prompt runs in an **ephemeral worker session** via the server API with `tools: {"*": false}` (the worker model cannot call tools) and a purpose-built system prompt; the worker session is deleted afterwards and is never indexed by recall.
- Results are **cached permanently** in the sidecar DB keyed by `(session_id, model, focus)` and invalidated only if the source session's `time_updated` changes. Repeat calls are instant and free.
- **Batching**: `session_ids` runs up to 4 workers concurrently through a promise pool with per-session error isolation (one bad id yields one error block, not a failed batch), live progress in the tool title (`recall summarize: 3/8`), and in-flight dedupe so concurrent requests for the same session share one worker. Cancelling the tool call aborts in-flight workers (`ctx.abort`), which are still cleaned up.
- Sizing: a 16-message session summarizes in ~9 s fresh, focused questions in ~2 s, cache hits in ~0 s. A batch's wall time ≈ its slowest session, not the sum: measured 51.7 s for a batch whose sequential sum was 88 s.

The economics vs. eager per-session summaries (the Engram model): summaries are generated lazily, only for sessions someone actually asks about, by a near-free model, and never expire.

### `recall_status`

Index health: sessions/chunks indexed, backfill progress, embedder state, summary-cache count, index size on disk, process RSS.

## How it works

```
~/.local/share/opencode/opencode.db   (source of truth — opened READ-ONLY)
        │  session.idle / session.deleted events + watermark backfill
        ▼
~/.local/share/opencode-recall/index.db   (sidecar index, WAL)
        ├── fts       FTS5 over ALL text: messages, reasoning, tool outputs (≤16 KB each)
        ├── chunks    turn-pair embeddings (user + assistant text, 900 chars each side)
        └── sessions  metadata for result headers and directory filtering
```

- **Embeddings:** `Xenova/bge-small-en-v1.5` (q8, 384-dim) via in-process transformers.js — no daemon. The model (~33 MB) is cached under `~/.local/share/opencode-recall/models/` on first use. The embedder is lazy-loaded on demand and disposed after 10 minutes idle, reclaiming ~300 MB RSS.
- **Semantic search** is brute-force cosine over an in-memory Float32 matrix, rebuilt only when the chunks table changes (signature: row count + max id). No ANN index — at ~10k chunks a full scan is ~milliseconds.
- **Indexing** is idempotent per session (delete + reinsert), driven by `session.idle` with a startup catch-up pass ~20–30 s after launch using each session's `time_updated` watermark. Embeddings are reused across reindexes via content hash. Sessions deleted from the source are purged. WAL + busy timeouts make concurrent opencode instances safe — they converge on the same index.
- **Containment:** if init fails the plugin disables itself instead of breaking opencode. Semantic failures fall back to lexical. `dispose()` drains in-flight work (8 s cap) before releasing the ONNX session. Diagnostics go to `~/.local/share/opencode-recall/recall.log` (self-truncating at 5 MB).
- The plugin's own tool outputs are never indexed (no recursive meta-noise), and ANSI escapes are stripped at both index and display time.

## Install

From the repo root, `bun install && ./link.sh` handles everything. Manually, that amounts to symlinking the inner file (the loader only auto-scans top-level `plugins/*.ts`):

```bash
ln -s "$PWD/plugins/recall/recall.ts" ~/.config/opencode/plugins/recall.ts
```

`@huggingface/transformers` must be resolvable from the plugin file's real path — `bun install` at the repo root covers it. Lifecycle scripts can stay blocked/ignored: `onnxruntime-node` ships prebuilt bindings.

`recall_summarize` needs no extra setup beyond an OpenCode Go subscription — it prompts `opencode-go/glm-5.2` through the local server API using your existing auth. The other three tools work without it.

Restart opencode. First search triggers the model download; the initial backfill starts automatically ~20 s after launch. Sizing from this machine: ~2,100 sessions → ~10k embedded chunks, ~183k FTS rows, ~465 MB index, ~6 minutes one-time backfill on an M-series Mac.

## Operations

- **Reset / rebuild:** delete `~/.local/share/opencode-recall/index.db*` and restart — the backfill rebuilds everything.
- **Model swap:** change `MODEL`/`DIMS` in `recall.ts`; the stored model tag mismatch triggers a full automatic reindex on next start.
- **Privacy:** everything stays on this machine. The only network access is the one-time model download from the Hugging Face hub.
