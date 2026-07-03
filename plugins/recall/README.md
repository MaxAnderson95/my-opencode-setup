# recall

Hybrid lexical + semantic search over **all past OpenCode conversations on this machine** — every project, full history. Gives the agent long-term conversational memory as three tools, entirely local.

Replaces ad-hoc SQL spelunking in the OpenCode database with a proper index: FTS5/BM25 for exact terms (including tool outputs and reasoning) fused with embedding similarity for fuzzy "we talked about this once" recall.

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

### `recall_status`

Index health: sessions/chunks indexed, backfill progress, embedder state, index size on disk, process RSS.

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

The OpenCode plugin loader only picks up top-level `plugins/*.ts` files — symlink the file, not the directory:

```bash
ln -s "$PWD/plugins/recall/recall.ts" ~/.config/opencode/plugins/recall.ts
```

`@huggingface/transformers` must be resolvable from the plugin file — it's in this repo's `package.json`, so `bun install` at the repo root covers it. Lifecycle scripts can stay blocked/ignored: `onnxruntime-node` ships a prebuilt darwin-arm64 binding.

Restart opencode. First search triggers the model download; the initial backfill starts automatically ~20 s after launch. Sizing from this machine: ~2,100 sessions → ~10k embedded chunks, ~183k FTS rows, ~465 MB index, ~6 minutes one-time backfill on an M-series Mac.

## Operations

- **Reset / rebuild:** delete `~/.local/share/opencode-recall/index.db*` and restart — the backfill rebuilds everything.
- **Model swap:** change `MODEL`/`DIMS` in `recall.ts`; the stored model tag mismatch triggers a full automatic reindex on next start.
- **Privacy:** everything stays on this machine. The only network access is the one-time model download from the Hugging Face hub.
