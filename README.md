# Jev

`/jev <binary question>` asks TypeSafe's Jev about the current OpenCode session. The TUI plugin reads the session API and calls TypeSafe directly. It does not create a prompt, invoke the session's model, or change conversation history.

```text
/jev so did you fix it?
```

The result appears in a dialog: `Yes · 92.0% confidence`. Confidence is the probability of the selected answer; below 60% the result includes `(uncertain)`. An exact 50/50 tie returns No with the uncertainty label.

## Installation

Add `github:MaxAnderson95/my-opencode-setup#plugin-jev` to the OpenCode `plugins` list. The package's server entrypoint advertises its TUI entrypoint. Requires OpenCode 2.0.4 or later.

Set `TYPESAFE_API_KEY` in the TUI process environment or `~/.env_private` on the machine running the TUI. The plugin parses that file as dotenv data on each invocation when the process environment lacks the key. It uses the official `@typesafe-ai/sdk` JavaScript SDK's `TypeSafeClient.systemOne()` and `noul()` to query `jev-latest` directly through TypeSafe. Requests have a 30-second timeout and retries disabled.

## Conversation evidence

The plugin fetches the first user message separately so it survives conversation compaction. It fetches the newest 40 session records and takes up to 12 user/assistant messages from those records. Assistant text and tool status/output are included; reasoning, system instructions, and binary attachments are omitted. Recent evidence has a 24,000-character budget, with up to 6,000 characters per entry, keeping the newest content when truncating.

Jev judges the supplied evidence. It does not independently inspect files or run checks. API errors and timeouts appear as errors rather than decisions.
