---
name: opencode-db-querying
description: Query OpenCode 2's local SQLite database for exact session history, transcripts, tool calls, token and cost totals, projects, child sessions, pending input, and schema inspection. Use when a ses_ ID is known or SQL precision is more useful than fuzzy recall.
---

# Query the OpenCode 2 database

Use direct SQL for exact lookups, ordered transcripts, structured inspection, and aggregates. Use `recall_search` for fuzzy or semantic discovery across sessions, then switch to SQL when the session ID or required structure is known.

## Open the database safely

OpenCode 2 stores its SQLite database at `~/.local/share/opencode/opencode.db`. The V1 `opencode db` command no longer exists. Query through `sqlite3` in explicit read-only mode:

```bash
DB="file:$HOME/.local/share/opencode/opencode.db?mode=ro"
sqlite3 -header -column "$DB" "SELECT id, title FROM session_v2 ORDER BY time_updated DESC LIMIT 5;"
sqlite3 -json "$DB" "SELECT id, title FROM session_v2 ORDER BY time_updated DESC LIMIT 5;"
```

Keep every agent query read-only. OpenCode owns this database and may have it open in WAL mode. Never alter rows, schema, write-affecting pragmas, or migration state.

## V2 data model

The current conversation projection is:

```text
project 1--N session_v2 1--N session_message
                    |
                    +--N session_pending
                    +--N session_inbox
                    +--1 instruction_state
```

`session_v2` is the session summary. `session_message` is the ordered transcript projection. Do not use the V1 `session`, `message`, or `part` tables for OpenCode 2 conversations.

### `session_v2`

Important columns:

- Identity and location: `id`, `project_id`, `workspace_id`, `parent_id`, `fork_session_id`, `fork_boundary`, `slug`, `directory`, `path`, `title`, `version`.
- Aggregate usage: `cost`, `tokens_input`, `tokens_output`, `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write`.
- Current execution defaults: `agent`, `model` (JSON containing `providerID`, `id`, and optionally `variant`).
- State: `metadata`, `revert`, `permission`, `share_url`, summary columns, `resume_attempts`, `idle_outcome`.
- Millisecond timestamps: `time_created`, `time_updated`, `time_idle`, `time_viewed`, `time_compacting`, `time_archived`, `time_suspended`.

`parent_id` identifies child/subagent sessions. `fork_session_id` records a fork separately; do not treat every fork as a child.

### `session_message`

Columns: `id`, `session_id`, `type`, `seq`, `time_created`, `time_updated`, `data`.

`seq` is the canonical per-session order. Always order transcripts by `seq`, not timestamps or IDs.

Current `type` values are `user`, `assistant`, `synthetic`, `system`, `skill`, `shell`, `compaction`, `model-switched`, `agent-switched`, and `location-switched`. Inspect the live database before assuming the list is unchanged:

```sql
SELECT type, count(*) AS rows
FROM session_message
GROUP BY type
ORDER BY rows DESC;
```

Message data differs by type:

- `user`: visible prompt in `data.text`, plus optional `files`, `agents`, and `skills`; timestamp in `data.time.created`.
- `assistant`: `data.agent`, `data.model`, `data.content`, `data.finish`, `data.cost`, `data.tokens`, `data.error`, `data.retry`, and `data.time`.
- `assistant.data.content`: an array whose elements commonly have `type` equal to `text`, `reasoning`, or `tool`.
- Assistant `text` and `reasoning` elements store their content in `text`.
- Assistant `tool` elements store `name`, `id`, `state.status`, `state.input`, `state.content`, `state.metadata`, and timing data. Error states use `state.error`. Shapes vary by status and tool.
- `synthetic`: generated user-like text in `data.text`.
- `system`: model-facing update in `data.text` and optional human-facing `data.description`.
- `skill`: injected skill name, ID, and text.
- `shell`: shell command lifecycle and output, separate from assistant tool content.
- `compaction`: `status`, `reason`, summary fields, error, and timing; the exact shape depends on status.

Use `json_each(data, '$.content')` to expand assistant content. SQLite's JSON operators are useful for ad hoc work, but `json_extract` is clearest in reusable queries.

### Queue and instruction tables

- `session_pending`: admitted work not yet fully projected; ordered by `admitted_seq`. Columns include `type`, JSON `data`, nullable `delivery`, and `time_created`.
- `session_inbox`: queued input; ordered by `enqueued_seq`. The JSON column is named `payload`, not `data`.
- `instruction_state`: projected instruction state with `epoch_start`, `through_seq`, and JSON `initial_values`/`current_values`.
- `instruction_entry`: per-session instruction changes keyed by `(session_id, key)`.
- `instruction_blob`: content-addressed instruction values.

These are internal execution tables. Use them for diagnosis, not as the normal transcript source.

## Timestamps and JSON

All `time_*` columns and JSON times are Unix epoch milliseconds:

```sql
datetime(time_created / 1000, 'unixepoch', 'localtime')
```

JSON columns are stored as text. Select only needed paths because assistant content and tool output can be large:

```sql
json_extract(data, '$.model.providerID')
json_extract(data, '$.tokens.input')
json_extract(content.value, '$.state.status')
```

## Recipes

### Recent sessions

```sql
SELECT id, title, directory,
       datetime(time_created / 1000, 'unixepoch', 'localtime') AS created,
       datetime(time_updated / 1000, 'unixepoch', 'localtime') AS updated
FROM session_v2
WHERE time_archived IS NULL
ORDER BY time_updated DESC
LIMIT 20;
```

Add `AND directory LIKE '%/repo-name%'` to scope by working directory. `directory` is usually enough; joining `project` is unnecessary.

### Session by ID or slug

```sql
SELECT id, title, directory, parent_id, fork_session_id, agent,
       json_extract(model, '$.providerID') AS provider,
       json_extract(model, '$.id') AS model_id,
       json_extract(model, '$.variant') AS variant
FROM session_v2
WHERE id = 'ses_XXXX';
```

```sql
SELECT id, title, directory, time_updated
FROM session_v2
WHERE slug = 'some-slug'
ORDER BY time_updated DESC;
```

Slugs are not unique. Use the `ses_` ID for identity.

### Visible transcript

This returns user prompts and every visible assistant text content item in canonical order:

```sql
SELECT sm.seq,
       datetime(sm.time_created / 1000, 'unixepoch', 'localtime') AS time,
       sm.type AS role,
       CASE
         WHEN sm.type = 'user' THEN json_extract(sm.data, '$.text')
         ELSE json_extract(content.value, '$.text')
       END AS text
FROM session_message AS sm
LEFT JOIN json_each(sm.data, '$.content') AS content
  ON sm.type = 'assistant'
 AND json_extract(content.value, '$.type') = 'text'
WHERE sm.session_id = 'ses_XXXX'
  AND sm.type IN ('user', 'assistant')
  AND (sm.type = 'user' OR content.value IS NOT NULL)
ORDER BY sm.seq, CAST(content.key AS INTEGER);
```

To include generated prompts, add `synthetic` to the type list and handle it like `user`. To include reasoning, expand assistant content where the content type is in `('text', 'reasoning')` and return that type as a separate column.

### Search visible text across V2 sessions

```sql
WITH visible_text AS (
  SELECT sm.session_id, sm.seq, sm.time_created, sm.type AS role,
         json_extract(sm.data, '$.text') AS text
  FROM session_message AS sm
  WHERE sm.type = 'user'

  UNION ALL

  SELECT sm.session_id, sm.seq, sm.time_created, 'assistant',
         json_extract(content.value, '$.text')
  FROM session_message AS sm
  JOIN json_each(sm.data, '$.content') AS content
  WHERE sm.type = 'assistant'
    AND json_extract(content.value, '$.type') = 'text'
)
SELECT session_id, seq, role,
       datetime(time_created / 1000, 'unixepoch', 'localtime') AS time,
       substr(text, 1, 300) AS snippet
FROM visible_text
WHERE text LIKE '%SEARCH TERM%'
ORDER BY time_created DESC
LIMIT 50;
```

This is exact substring search. Prefer `recall_search` for ranking, stemming, or semantic similarity.

### Sessions active during a date window

```sql
SELECT s.id, s.directory, s.title,
       count(*) AS message_rows,
       sum(sm.type = 'user') AS user_turns,
       datetime(min(sm.time_created) / 1000, 'unixepoch', 'localtime') AS first_active,
       datetime(max(sm.time_created) / 1000, 'unixepoch', 'localtime') AS last_active
FROM session_v2 AS s
JOIN session_message AS sm ON sm.session_id = s.id
WHERE s.parent_id IS NULL
  AND datetime(sm.time_created / 1000, 'unixepoch', 'localtime') >= '2026-08-01 00:00:00'
  AND datetime(sm.time_created / 1000, 'unixepoch', 'localtime') <  '2026-09-01 00:00:00'
GROUP BY s.id
ORDER BY min(sm.time_created);
```

Scope activity by message timestamps rather than session creation or update time.

### Child and forked sessions

```sql
SELECT id, title, agent, model, time_created
FROM session_v2
WHERE parent_id = 'ses_PARENT'
ORDER BY time_created;
```

```sql
SELECT id, title, fork_boundary, time_created
FROM session_v2
WHERE fork_session_id = 'ses_SOURCE'
ORDER BY time_created;
```

### Tool calls in a session

```sql
SELECT sm.seq,
       CAST(content.key AS INTEGER) AS content_index,
       json_extract(content.value, '$.name') AS tool,
       json_extract(content.value, '$.state.status') AS status,
       json_extract(content.value, '$.state.input') AS input,
       substr(json_extract(content.value, '$.state.content'), 1, 500) AS content_preview,
       json_extract(content.value, '$.state.error') AS error
FROM session_message AS sm
JOIN json_each(sm.data, '$.content') AS content
WHERE sm.session_id = 'ses_XXXX'
  AND sm.type = 'assistant'
  AND json_extract(content.value, '$.type') = 'tool'
ORDER BY sm.seq, CAST(content.key AS INTEGER);
```

Tool output is an array of typed content and is not uniform. Inspect `content.value` when a preview is insufficient:

```sql
SELECT json_pretty(content.value)
FROM session_message AS sm
JOIN json_each(sm.data, '$.content') AS content
WHERE sm.session_id = 'ses_XXXX'
  AND json_extract(content.value, '$.type') = 'tool'
LIMIT 5;
```

### Failed, running, and retried work

Find tool calls requiring attention:

```sql
SELECT sm.session_id, sm.seq,
       json_extract(content.value, '$.name') AS tool,
       json_extract(content.value, '$.state.status') AS status,
       json_extract(content.value, '$.state.error') AS error,
       json_extract(content.value, '$.state.input') AS input
FROM session_message AS sm
JOIN json_each(sm.data, '$.content') AS content
WHERE sm.type = 'assistant'
  AND json_extract(content.value, '$.type') = 'tool'
  AND json_extract(content.value, '$.state.status') IN ('error', 'running')
ORDER BY sm.time_updated DESC
LIMIT 50;
```

Find assistant-level provider failures and retries:

```sql
SELECT session_id, seq,
       json_extract(data, '$.model.providerID') AS provider,
       json_extract(data, '$.model.id') AS model,
       json_extract(data, '$.finish') AS finish,
       json_extract(data, '$.error') AS error,
       json_extract(data, '$.retry') AS retry
FROM session_message
WHERE type = 'assistant'
  AND (json_type(data, '$.error') IS NOT NULL OR json_type(data, '$.retry') IS NOT NULL)
ORDER BY time_updated DESC
LIMIT 50;
```

### Compactions and model changes

```sql
SELECT seq, type,
       json_extract(data, '$.status') AS status,
       json_extract(data, '$.reason') AS reason,
       substr(json_extract(data, '$.summary'), 1, 300) AS summary_preview,
       json_extract(data, '$.error') AS error
FROM session_message
WHERE session_id = 'ses_XXXX'
  AND type = 'compaction'
ORDER BY seq;
```

```sql
SELECT seq, type,
       coalesce(json_extract(data, '$.model.providerID') || '/' || json_extract(data, '$.model.id'),
                json_extract(data, '$.agent'),
                json_extract(data, '$.location')) AS selected,
       json_extract(data, '$.previous') AS previous
FROM session_message
WHERE session_id = 'ses_XXXX'
  AND type IN ('model-switched', 'agent-switched', 'location-switched')
ORDER BY seq;
```

### Per-message and per-session usage

```sql
SELECT sm.seq,
       json_extract(sm.data, '$.model.providerID') AS provider,
       json_extract(sm.data, '$.model.id') AS model,
       json_extract(sm.data, '$.cost') AS cost,
       json_extract(sm.data, '$.tokens.input') AS input,
       json_extract(sm.data, '$.tokens.output') AS output,
       json_extract(sm.data, '$.tokens.reasoning') AS reasoning,
       json_extract(sm.data, '$.tokens.cache.read') AS cache_read,
       json_extract(sm.data, '$.tokens.cache.write') AS cache_write
FROM session_message AS sm
WHERE sm.session_id = 'ses_XXXX'
  AND sm.type = 'assistant'
ORDER BY sm.seq;
```

```sql
SELECT id, title, cost, tokens_input, tokens_output, tokens_reasoning,
       tokens_cache_read, tokens_cache_write
FROM session_v2
ORDER BY tokens_input + tokens_output + tokens_reasoning DESC
LIMIT 20;
```

Subscription-backed providers can report zero cost. Token columns remain the better activity signal.

### Projects and worktrees

```sql
SELECT p.id, p.worktree, p.name, p.vcs,
       count(s.id) AS sessions,
       max(s.time_updated) AS latest_session
FROM project AS p
LEFT JOIN session_v2 AS s ON s.project_id = p.id
GROUP BY p.id
ORDER BY latest_session DESC;
```

`project.name` may be null. `project.worktree` and `session_v2.directory` are more reliable identifiers. `project_directory` and `worktree` contain additional project-directory mappings used by current and migrated data.

### Pending and queued input

```sql
SELECT admitted_seq, type, delivery,
       datetime(time_created / 1000, 'unixepoch', 'localtime') AS created,
       substr(data, 1, 500) AS data_preview
FROM session_pending
WHERE session_id = 'ses_XXXX'
ORDER BY admitted_seq;
```

```sql
SELECT enqueued_seq, type, delivery,
       datetime(time_created / 1000, 'unixepoch', 'localtime') AS created,
       substr(payload, 1, 500) AS payload_preview
FROM session_inbox
WHERE session_id = 'ses_XXXX'
ORDER BY enqueued_seq;
```

### Session outcomes and unfinished execution

```sql
SELECT id, title, idle_outcome, resume_attempts,
       datetime(time_idle / 1000, 'unixepoch', 'localtime') AS idle_since,
       datetime(time_suspended / 1000, 'unixepoch', 'localtime') AS claim_time
FROM session_v2
WHERE idle_outcome IN ('failed', 'interrupted')
   OR time_suspended IS NOT NULL
ORDER BY coalesce(time_suspended, time_idle, time_updated) DESC;
```

`time_suspended` is the historical column name for the execution-claim timestamp, not a user-facing suspended state.

## Inspect schema drift first

OpenCode 2 is a preview release and migrations change frequently. Before writing an unfamiliar query, inspect the installed schema rather than trusting this document as a frozen catalog:

```bash
sqlite3 "$DB" ".tables"
sqlite3 "$DB" ".schema session_v2"
sqlite3 "$DB" ".schema session_message"
sqlite3 "$DB" "PRAGMA table_info(session_message);"
sqlite3 "$DB" "SELECT type, count(*) FROM session_message GROUP BY type ORDER BY count(*) DESC;"
```

Inspect JSON keys without dumping full tool output:

```sql
SELECT sm.type, keys.key, count(*) AS rows
FROM session_message AS sm
JOIN json_each(sm.data) AS keys
GROUP BY sm.type, keys.key
ORDER BY sm.type, rows DESC;
```

For non-destructive integrity and size checks:

```bash
sqlite3 "$DB" "PRAGMA quick_check;"
sqlite3 -header -column "$DB" \
  "SELECT page_count * page_size AS bytes, freelist_count * page_size AS free_bytes
   FROM pragma_page_count(), pragma_page_size(), pragma_freelist_count();"
```

## Legacy V1 data

Migrated installations may retain V1 `session`, `message`, `part`, and `todo` tables alongside V2 tables. They are separate legacy projections and can overlap with V2 sessions. Query them only when the requested session is absent from `session_v2` or the user explicitly asks for V1 history.

For a legacy visible transcript, join `part` to `message`, filter `json_extract(part.data, '$.type') = 'text'`, and order by `part.time_created, part.id`. Do not union V1 and V2 tables without deduplicating by session ID.

## Query discipline

- Start with the narrowest table and a `ses_` ID when available.
- Use `session_message.seq` for transcript order.
- Expand `data.content` only for assistant rows.
- Select JSON paths or previews instead of raw assistant rows and tool outputs.
- Treat `slug`, titles, and project names as labels, not identifiers.
- Confirm current columns with `.schema` when a query touches execution internals.
- Keep the live database read-only.
