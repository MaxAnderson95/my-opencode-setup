---
name: opencode-db-querying
description: Query OpenCode's local SQLite database with SQL — conversations, sessions, messages, parts, projects, todos, tokens/cost. Use when you need structured/exact queries against the opencode DB: search past conversation text, reconstruct a full session transcript in order, look up a session by ses_ id or slug, compute token/cost stats, list projects/sessions, or inspect tool calls. Complements the recall plugin (which does fuzzy/semantic search) with precise SQL. Load this instead of re-discovering the schema through trial-and-error tool calls.
---

# Querying the OpenCode SQLite database

OpenCode stores every conversation in a local SQLite database. This skill gives you the schema and ready-to-run queries so you never have to rediscover it.

## When to use this vs the recall plugin

- **recall plugin** (`recall_search`, `recall_expand`, `recall_status`) — hybrid lexical + semantic search over past conversations, ranked and cross-session. Use for *"find where we discussed X"* / fuzzy recall.
- **this skill (direct SQL)** — exact matches, aggregations (token/cost totals), reconstructing a full ordered transcript, listing sessions/projects, inspecting tool calls, or anything where you already know the `ses_` id. Use when you need precision or structure the recall index doesn't give you.

## The database

Path: `~/.local/share/opencode/opencode.db` (the conversation store; `storage.db` and `opencode-local.db` in the same dir are separate — ignore them).

Two ways to query (both read-only-safe; **never write** to this DB while OpenCode may be running):

```bash
# 1. Built-in command — TSV by default, or --format json
opencode db "SELECT id, title FROM session ORDER BY time_created DESC LIMIT 5"
opencode db "SELECT id, title FROM session LIMIT 5" --format json

# 2. sqlite3 in explicit read-only mode (WAL-safe)
sqlite3 "file:$HOME/.local/share/opencode/opencode.db?mode=ro" \
  "SELECT id, title FROM session ORDER BY time_created DESC LIMIT 5;"
```

## Schema — the parts that matter

Relationships:

```
project ──1:N── session ──1:N── message ──1:N── part
   (id)          (project_id)     (session_id)    (message_id, session_id)
```

**Conversational text lives inside a JSON `data` column, NOT in normal columns.** `message` and `part` each have a `data TEXT` column holding a JSON object — use `json_extract(data, '$.field')`.

### `session`
Columns: `id` (the `ses_...` id), `project_id`, `parent_id` (set for **sub-agent** sessions), `slug` (human name — **not unique**, prefer `id`), `directory`, `path`, `title`, `agent`, `model`, `version`, `share_url`, `summary_additions/deletions/files`, `cost` (real), `tokens_input`, `tokens_output`, `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write`, `time_created`, `time_updated`, `time_compacting`, `time_archived`, `workspace_id`, `metadata`.

### `message` — one per turn
Columns: `id`, `session_id`, `time_created`, `time_updated`, `data`.
`data` JSON keys: `role` (`user` | `assistant`), `time.created`, `agent`, `model`; assistant messages also have `modelID`, `providerID`, `cost`, `tokens{input,output,reasoning,cache{read,write}}`, `mode`, `variant`, `parentID`, `path`.

### `part` — pieces of a message (this is where text is)
Columns: `id`, `message_id`, `session_id`, `time_created`, `time_updated`, `data`.
`data.type` is one of (by frequency): `tool`, `step-start`, `step-finish`, `reasoning`, `text`, `patch`, `file`, `compaction`.

| type | `data` JSON shape |
|---|---|
| `text` | `{type, text, synthetic, time{start,end}}` — **user-visible message text** |
| `reasoning` | `{type, text, metadata, time}` — model's internal thinking |
| `tool` | `{type, tool, callID, state{status, input, output, metadata, time}, metadata}` |
| `file` | `{type, filename, mime, source, url}` |
| `patch` | `{type, files, hash}` |
| `step-start` | `{type}` |
| `step-finish` | `{type, cost, reason, tokens}` |
| `compaction` | `{type, auto, tail_start_id}` |

To read conversation content, filter `json_extract(data,'$.type')='text'` (add `'reasoning'` only if you want the model's thoughts).

### `project`
Columns: `id`, `worktree`, `vcs`, `name`, `icon_url`, `time_created`, `time_updated`, `commands`.
In practice `name` is **usually NULL** — identify a project by `worktree` (its repo/root path). There is a special `global` project (`id='global'`, `worktree='/'`). Note that `session.directory` already holds the working path, so you often don't need to join `project` at all.

### `todo` / `session_share` / `project_directory`
- `todo`: `session_id`, `content`, `status`, `priority`, `position`, timestamps (the TodoWrite list for a session).
- `session_share`: `session_id`, `url`, `secret` (share links).
- `project_directory`: maps `project_id` → additional `directory` paths.

Other tables exist (`account`, `credential`, `event`, `permission`, `workspace`, `migration`, …) but are rarely relevant to conversation queries.

## Timestamps

All time columns and JSON `time` values are **epoch milliseconds** (integers). Divide by 1000 for SQLite date functions:

```sql
datetime(time_created/1000, 'unixepoch', 'localtime')
```

## Recipes

**Recent sessions (optionally scoped to a directory):**
```sql
SELECT id, title, directory,
       datetime(time_created/1000,'unixepoch','localtime') AS created
FROM session
WHERE directory LIKE '%/my-repo%'          -- omit line for all
ORDER BY time_created DESC LIMIT 20;
```

**Sessions active in a date window (with substance signals):**
```sql
SELECT s.id, s.directory, s.title,
       count(*) AS msgs,
       sum(json_extract(m.data,'$.role')='user') AS user_turns,
       datetime(min(m.time_created)/1000,'unixepoch','localtime') AS first_active,
       datetime(max(m.time_created)/1000,'unixepoch','localtime') AS last_active
FROM session s JOIN message m ON m.session_id = s.id
WHERE s.parent_id IS NULL                  -- top-level only; drop to include sub-agents
  AND datetime(m.time_created/1000,'unixepoch','localtime') >= '2026-06-26 18:00:00'
  AND datetime(m.time_created/1000,'unixepoch','localtime') <  '2026-07-03 22:00:00'
GROUP BY s.id
ORDER BY last_active;
```
Windows on **message activity**, not `session.time_created/updated` — a long-running session scopes to its in-window work, and `first_active`/`last_active` are true work dates. `msgs`/`user_turns` separate substantive sessions from trivia. Don't use `session.cost` for this: subscription-auth sessions record `0.00` for real work.

**Look up a session by id or slug:**
```sql
SELECT id, title, directory, agent, model FROM session WHERE id = 'ses_XXXX';
SELECT id, title, directory FROM session WHERE slug = 'some-slug' ORDER BY time_created DESC;
```

**Full transcript of a session (user + assistant text, in order):**
```sql
SELECT datetime(p.time_created/1000,'unixepoch','localtime') AS t,
       json_extract(m.data,'$.role')  AS role,
       json_extract(p.data,'$.text')  AS text
FROM part p
JOIN message m ON m.id = p.message_id
WHERE p.session_id = 'ses_XXXX'
  AND json_extract(p.data,'$.type') = 'text'
ORDER BY p.time_created, p.id;
```

**Search text across ALL conversations:**
```sql
SELECT p.session_id,
       datetime(p.time_created/1000,'unixepoch','localtime') AS t,
       substr(json_extract(p.data,'$.text'),1,200) AS snippet
FROM part p
WHERE json_extract(p.data,'$.type') = 'text'
  AND json_extract(p.data,'$.text') LIKE '%SEARCH TERM%'
ORDER BY p.time_created DESC LIMIT 50;
```

**Sessions with their project path (join):** (`project.name` is usually NULL — use `worktree`)
```sql
SELECT s.id, pr.worktree AS project_path, s.title,
       datetime(s.time_created/1000,'unixepoch','localtime') AS created
FROM session s JOIN project pr ON pr.id = s.project_id
ORDER BY s.time_created DESC LIMIT 20;
-- Often simpler: session.directory already holds the path, no join needed.
```

**Sub-agent (child) sessions of a session:**
```sql
SELECT id, title FROM session WHERE parent_id = 'ses_PARENT';
```

**Tool calls made in a session:**
```sql
SELECT json_extract(data,'$.tool')          AS tool,
       json_extract(data,'$.state.status')  AS status,
       datetime(time_created/1000,'unixepoch','localtime') AS t
FROM part
WHERE session_id = 'ses_XXXX' AND json_extract(data,'$.type') = 'tool'
ORDER BY time_created;
```

**Todos for a session:**
```sql
SELECT position, status, priority, content
FROM todo WHERE session_id = 'ses_XXXX' ORDER BY position;
```

**Token / cost leaders:**
```sql
SELECT id, title, cost, tokens_input, tokens_output, tokens_reasoning
FROM session ORDER BY cost DESC LIMIT 20;
```

## Gotchas

- **Text is in JSON, not columns** — always `json_extract(data,'$.text')` on `part`, `json_extract(data,'$.role')` on `message`.
- **Timestamps are milliseconds** — divide by 1000 before `datetime()`.
- **`slug` is not unique** — multiple sessions can share one; use `id` (`ses_...`) to identify a specific conversation.
- **Two text-bearing part types** — `text` (visible) and `reasoning` (thoughts). Default to `text`.
- **Big rows** — tool outputs and patches can be huge; select specific JSON fields or `substr(...)` instead of `SELECT *` / raw `data`.
- **Read-only** — use `opencode db` or `sqlite3 "file:...?mode=ro"`; never modify the DB.
- **Ordering a transcript** — order by `time_created, id` (id breaks ties within the same millisecond).
