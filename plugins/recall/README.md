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

Ranked session search. Lexical and semantic branches run in parallel and are fused with Reciprocal Rank Fusion (grouped by session, only the best 3 hits per branch count toward a session's score so a flood of weak matches cannot climb past its own top 3).

| Arg | Default | Description |
|---|---|---|
| `query` | — | Natural language or exact keywords/identifiers |
| `mode` | `hybrid` | `hybrid` fuses both branches; `lexical` = exact terms only; `semantic` = meaning only |
| `directory` | — | Substring filter on the session working directory |
| `since` / `until` | — | ISO date bounds |
| `include_tools` | `true` | Include tool outputs (bash/file contents) in lexical matching |
| `limit` | 8 (1–25) | Max sessions returned |

Lexical queries are safe against FTS5 operator injection (every token is quoted) and fall back from AND to OR matching when a multi-word query has no strict match.

**Every filter is applied inside the SQL**, never as a post-filter over a fixed top-N BM25 cut. For a term that is common across the corpus the best-ranked rows can all belong to sessions the filters exclude, and a post-filter would return nothing while matches exist.

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
| `limit` | 12 (1–30) | Max hits in query mode |

Hits are fused per **message**, so a message matched by both branches appears once with both counts rather than twice.

In hybrid mode, semantic hits below cosine **0.55** are dropped: within a single session there's no cross-session competition to bury weak matches, and cosine always returns top-k even for irrelevant queries (bge-small scores junk at ~0.45–0.52, real matches ~0.58+). Explicit `mode=semantic` skips the filter and gives the raw ranking.

### `recall_summarize`

The **escalation rung**: summarizes an entire session — or answers a focused question about it — by offloading to a cheap worker model (default `openai/gpt-5.6-luna` at `low` reasoning) instead of spending the main model's context on transcript reading. Reach for it when `recall_inspect`/`recall_expand` can't answer cleanly, the session is too large to page, or the whole-session story is genuinely what's needed.

| Arg | Default | Description |
|---|---|---|
| `session_id` | — | `ses_...` id or slug (same resolution rules as `recall_expand`) |
| `session_ids` | — | Batch: several ids/slugs summarized **concurrently** in one call (max 24, 4 workers in parallel) |
| `focus` | — | Optional question to answer from each transcript instead of a general summary |
| `refresh` | `false` | Bypass the cache and re-summarize |

Mechanics:

- The transcript is compacted (collapsed tool one-liners, trimmed text) and middle-out truncated to a 300k-char budget — goals live at the start of a session, outcomes at the end, so the middle goes first.
- The prompt runs in an **ephemeral worker session** via the server API with `tools: {"*": false}` (the worker model cannot call tools) and a purpose-built system prompt; the worker session is deleted afterwards and is never indexed by recall.
- Results are **cached permanently** in the sidecar DB keyed by `(session_id, model, focus)` and invalidated only if the source session's `time_updated` changes. Repeat calls are instant and free. Cached summaries survive an index reset.
- **Batching**: `session_ids` runs up to 4 workers concurrently through a promise pool with per-session error isolation (one bad id yields one error block, not a failed batch), live progress in the tool title (`recall summarize: 3/8`), and in-flight dedupe so concurrent requests for the same session share one worker. Cancelling the tool call aborts in-flight workers (`ctx.abort`), which are still cleaned up.
- Sizing: a 16-message session summarizes in ~9 s fresh, focused questions in ~2 s, cache hits in ~0 s. A batch's wall time ≈ its slowest session, not the sum: measured 51.7 s for a batch whose sequential sum was 88 s.

The worker agent is only registered when summarization is enabled and the configured provider is present, so a machine without that provider does not get a hidden agent pointing at a model it cannot reach.

### `recall_status`

Index health: sessions/chunks indexed, backfill progress, embedder state, summary-cache count, index size on disk, config source, process RSS. If recall failed to initialise, this is the **only** tool registered and it reports the reason — a silent disable leaves no way to diagnose from inside a session.

## Background work is announced with toasts

Indexing is invisible by design, which is right for the steady state and wrong for the rare long operation: a schema reset followed by a full rebuild runs for twenty minutes with nothing on screen. recall posts TUI toasts through `client.tui.showToast`, gated so routine work stays silent:

| Event | Toast |
|---|---|
| Index reset (schema or embedding-model change) | info, with the reason and MB reclaimed |
| Backfill of **< 25** sessions (the normal startup catch-up) | *nothing at all* |
| Backfill of **≥ 25** sessions | info on start, success on completion with elapsed time and chunk count |
| Backfill of **≥ 200** sessions | additionally 25/50/75% progress with a running ETA |
| Backfill that hit errors | warning instead of success, pointing at `recall_status` |
| First-ever embedding-model download | info on start, success when semantic search goes live |

So a full rebuild produces six toasts spread over its runtime, a routine restart produces none, and a session going idle never produces one. Thresholds live under `notify` in the config; `RECALL_QUIET=1` or `notify.enabled: false` turns them off entirely.

Toasts are fire-and-forget and never throw: headless runs (`opencode run`, scheduled jobs) have no TUI attached, and the call simply no-ops.

## How it works

```
~/.local/share/opencode/opencode.db   (source of truth — opened READ-ONLY)
        │  session.idle / session.deleted events + watermark backfill
        ▼
~/.local/share/opencode-recall/index.db   (sidecar index, WAL)
        ├── fts       contentless FTS5 over ALL text: messages, reasoning, tool outputs
        ├── parts     row metadata for each fts row; parts.id IS the fts rowid
        ├── chunks    sliding-window turn embeddings
        └── sessions  metadata for result headers and directory filtering
```

- **Embeddings:** `Xenova/bge-small-en-v1.5` (q8, 384-dim) via in-process transformers.js — no daemon. The model (~33 MB) is cached under `~/.local/share/opencode-recall/models/` on first use. The embedder is lazy-loaded on demand and disposed after 10 minutes idle, reclaiming ~300 MB RSS.
- **Chunking:** each turn (a user message plus the assistant messages that follow it) is windowed into overlapping 1200-character chunks rather than truncated. Windows past the first are re-anchored with the user's intent, because a bare slice of mid-turn prose retrieves poorly on its own. Pathological turns are capped head-and-tail at 60k characters.
- **Segmentation:** long text and reasoning parts are *split* across FTS rows rather than truncated, so nothing becomes unsearchable and BM25 length normalisation is not skewed by the occasional 400 KB message. Tool output is still capped (16 KB) before segmentation.
- **Contentless FTS:** the FTS table stores no copy of the indexed text. Snippets are rendered from opencode's own database using the part id and segment offset recorded at index time, which means excerpts come from the untruncated original and the index does not carry a second copy of the corpus.
- **Semantic search** is brute-force cosine over an in-memory Float32 matrix, rebuilt only when the chunks table changes (signature: row count + max id, which cannot repeat because chunk ids are AUTOINCREMENT). No ANN index — a full scan is milliseconds at this scale.
- **Indexing** is idempotent per session (delete + reinsert in one transaction), driven by `session.idle` with a startup catch-up pass ~20–30 s after launch using each session's `time_updated` watermark. Embeddings are reused across reindexes via content hash, so re-indexing a growing session costs only its new turns. Sessions deleted from the source are purged.
- **One backfiller at a time.** Every opencode process loads its own copy of the plugin, so the startup pass is gated by a heartbeated lease in the index; other processes skip it rather than each re-walking the same stale sessions. WAL plus busy timeouts keep concurrent writes safe regardless.
- **Containment:** if init fails the plugin registers only `recall_status`, which explains why. Semantic failures fall back to lexical. `dispose()` drains in-flight work (8 s cap) before releasing the ONNX session. Diagnostics go to `~/.local/share/opencode-recall/recall.log` (self-truncating at 5 MB).
- The plugin's own tool outputs are never indexed (no recursive meta-noise), and ANSI escapes are stripped at both index and display time.

## Layout

```
recall.ts            plugin wiring and tool surface
lib/config.ts        defaults, recall.json, env overrides
lib/text.ts          pure helpers: chunking, segmentation, snippets, FTS query building
lib/source.ts        everything that knows opencode's own schema
lib/schema.ts        sidecar DDL, versioned migration, backfill lease
lib/embedder.ts      lazy transformers.js embedder (+ a deterministic fake for tests)
lib/notify.ts        toast delivery and the policy for when to stay quiet
lib/indexer.ts       index writer and backfill
lib/search.ts        lexical branch, semantic branch, RRF fusion, snippet resolution
lib/summarize.ts     ephemeral worker summarizer and its cache
lib/fixture.ts       in-memory stand-in for opencode's DB, used by tests
recall.test.ts       bun test
```

Modules take their dependencies as arguments rather than reaching for module state, which is what lets the ranking- and chunking-sensitive logic be tested against an in-memory database and a deterministic fake embedder.

```bash
cd plugins/recall && bun test        # 70 tests
bunx tsc --noEmit -p tsconfig.json
```

## Configuration

Everything works with no configuration. To override, create `~/.config/opencode/recall.json` (`//` comments and trailing commas are tolerated). Unknown keys are ignored; a malformed file is reported in `recall_status` and skipped rather than being fatal.

```jsonc
{
  "embed": { "model": "Xenova/bge-small-en-v1.5", "dims": 384 },
  "chunk": { "chars": 1200, "overlap": 200, "maxPerTurn": 60000 },
  "fts": { "toolOutputChars": 16000, "segmentChars": 8000 },
  "search": { "candidates": 60, "rrfK": 60, "inspectSemMin": 0.55 },
  "notify": { "enabled": true, "announceMin": 25, "progressMin": 200 },
  "summary": {
    "enabled": true,
    "model": { "providerID": "openai", "modelID": "gpt-5.6-luna", "variant": "low" }
  }
}
```

Environment variables win over the file:

| Variable | Effect |
|---|---|
| `RECALL_CONFIG` | Path to the config file |
| `RECALL_DATA_DIR` | Where the sidecar index and model cache live |
| `RECALL_SOURCE_DB` | Path to `opencode.db` |
| `RECALL_EMBED_MODEL` / `RECALL_EMBED_DIMS` | Embedding model (changing either forces a reindex) |
| `RECALL_SUMMARY_MODEL` | `provider/model` or `provider/model/variant` |
| `RECALL_DISABLE_SUMMARIZE=1` | Drop the fourth rung and its worker agent |
| `RECALL_QUIET=1` | Suppress all background-work toasts |

## Install

From the repo root, `bun install && ./link.sh` handles everything. Manually, that amounts to symlinking the inner file (the loader only auto-scans top-level `plugins/*.ts`; relative imports still resolve through the symlink to `lib/`):

```bash
ln -s "$PWD/plugins/recall/recall.ts" ~/.config/opencode/plugins/recall.ts
```

`@huggingface/transformers` must be resolvable from the plugin file's real path — `bun install` at the repo root covers it. Lifecycle scripts can stay blocked/ignored: `onnxruntime-node` ships prebuilt bindings.

`recall_summarize` prompts the configured worker model through the local server API using your existing auth. The other recall tools work without it.

Restart opencode. First search triggers the model download; the initial backfill starts automatically ~20 s after launch.

## Sizing

Measured on this machine (M-series Mac, 3,022 sessions, a 6.4 GB `opencode.db`):

| | |
|---|---|
| Index on disk | **342 MB** (39,591 chunks, 286,729 FTS rows) |
| Full rebuild | ~47 min, one time, in the background behind toasts |
| Lexical search | p50 2.4 ms · p95 16 ms |
| Snippet rendering | p50 0.3 ms · p95 0.7 ms (8 hits, read from the source DB) |
| Semantic search | p50 20 ms (dominated by embedding the query, not by the scan) |
| Embedder resident | ~300 MB while loaded, released after 10 min idle |

A full rebuild is dominated by embedding: the sliding-window chunker produces ~3.3x the chunks that a truncating one did, which is the point, but it is why the rebuild is measured in tens of minutes rather than minutes. Incremental indexing after a session goes idle is milliseconds.

## Operations

- **Reset / rebuild:** delete `~/.local/share/opencode-recall/index.db*` and restart — the backfill rebuilds everything.
- **Schema and model changes** are automatic: the index records its schema version and embedding model, and a mismatch drops the indexed tables, `VACUUM`s, and reindexes on next start. Cached summaries are preserved across a reset.
- **Privacy:** everything stays on this machine; the only network access is the one-time model download from the Hugging Face hub. Be aware what that means locally: the index contains verbatim tool output, so anything an agent ever read — file contents, command output, tokens that passed through a terminal — is stored in plain text and is keyword-searchable. The data directory is mode 700. Set `fts.toolOutputChars` to `0` to stop indexing tool output altogether if that trade is not worth it to you.
