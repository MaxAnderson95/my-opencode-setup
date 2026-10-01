# Permission judge

The permission judge answers OpenCode permission prompts with a Decisions model (TypeSafe's Jev by default). For each request that your permission rules resolve to `ask`, the server plugin sends the request and recent session evidence to the model, then allows it, denies it with a reason the agent can act on, or leaves the prompt for you.

It replaces OpenCode's built-in auto-accept with its own `/auto` mode, because OpenCode v2 auto-accept is client-side and the server cannot tell when a client will approve everything anyway.

## Installation

Add the package to the server `plugins` list. Requires OpenCode 2.0.21 or later.

```jsonc
{
  "plugins": [
    { "package": "github:MaxAnderson95/my-opencode-setup#plugin-permission-judge", "options": {} }
  ]
}
```

Then turn off client-side auto-accept so the plugin sees prompts: set `"permissions": "prompt"` under `session` in `~/.config/opencode/cli.json`, do not launch with `--auto`, and leave the web app's auto-accept setting off.

Set `TYPESAFE_API_KEY` (or `OPENROUTER_API_KEY` for the OpenRouter route) in the server environment or `~/.env_private` on the server machine.

## How a request is decided

Configured `allow` and `deny` rules resolve before the plugin runs. The plugin only sees `ask` results.

1. If auto mode is on for the session, the request is allowed with no model call.
2. Actions listed in `skip` (default `question`) go to you.
3. Otherwise one Decisions request asks three questions about the evidence:
   - `risk` (score): read-only, local and easy to undo, local but hard to undo, or reaches beyond this machine / cannot be undone.
   - `authorized` (noul): did the user ask for this, or is it a direct step toward what they asked?
   - `forbidden` (noul): did the user say not to do this kind of thing?
4. Code applies the policy:

| Outcome | Condition (defaults) |
| --- | --- |
| Deny | `forbidden` ≥ 0.7, or P(hard to undo or beyond) ≥ 0.8 with `authorized` < 0.3 |
| Allow | P(read-only or local) ≥ 0.8, `authorized` ≥ 0.7, `forbidden` < 0.2 |
| Ask you | anything else, and any HTTP error, timeout, or malformed answer |

A denial never overrides you: it requires the model to find no user authorization. The agent receives the reason and an instruction not to route around the block, to take a safer approach, or to ask you for explicit approval. OpenCode reports a hook denial as a generic tool error, so the plugin rewrites that tool call's error in `tool.hook("execute.after")`.

After 3 denials in a row in a session, or 20 since your last message, further denials become prompts for you. An allow resets the consecutive count; a new user message resets both.

Approvals apply to that one request. The plugin never saves `always` rules.

## Evidence

The model sees the permission request and the tool call's input, the project and home directories, your last three messages plus your first one, and the agent's last eight tool calls (inputs only). Assistant prose, reasoning, and tool outputs are left out so content the agent read cannot argue for its own approval. For a subagent, your messages come from the root session and the subagent's task appears separately as `delegated_task`.

## Auto mode

`/auto` toggles auto mode for the current root session; `/auto on` and `/auto off` set it. Subagents follow their root session. The setting persists in plugin storage. In auto mode every `ask` is allowed without a model call; configured denies still apply.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `provider` | `"typesafe"` | `"typesafe"` (`https://api.typesafe.ai/v1/systemone`) or `"openrouter"` (`https://openrouter.ai/api/alpha/decisions`) |
| `model` | `jev-latest` / `~typesafe/jev-latest` | Any model the provider's Decisions endpoint accepts |
| `timeoutMs` | `4000` | Per-request timeout; a timeout leaves the prompt for you |
| `thresholds` | see table above | `allowLowRisk`, `allowAuthorized`, `allowForbiddenBelow`, `denyForbidden`, `denyHighRisk`, `denyAuthorizedBelow` |
| `breaker` | `{ "consecutive": 3, "total": 20 }` | Denial limits before prompts take over |
| `skip` | `["question"]` | Actions that always go to you |
| `defaultAuto` | `false` | Auto mode for sessions that never ran `/auto` |
| `logFile` | `~/.local/state/opencode/permission-judge.jsonl` | One JSON line per decision with the answers and latency; `false` disables it |

## Tuning

`bun eval.ts [typesafe|openrouter]` runs labeled permission requests live against each route and prints every answer and outcome. Use it, together with the decision log, before changing questions or thresholds.

```sh
bun install
bun test
bun eval.ts
```
