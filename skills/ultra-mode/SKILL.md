---
name: ultra-mode
description: Proactive delegation for the rest of this session. Split independent work across subagents and keep working while they run.
metadata:
  opencode/autoinvoke: false
---

# Ultra mode

Ultra mode is on for the rest of this session. Delegate proactively whenever a piece of work is independent of what you are doing and handing it off saves wall-clock time or improves quality. Reach for it without being asked; the user turned it on so you would.

Follow `subagent-workflow` for how to dispatch and review workers; this skill only changes when you dispatch.

## Dispatch

1. Before starting a task, split it into pieces that do not depend on each other's output. Anything you can describe with a narrow scope and a clear deliverable is a delegation candidate; anything that needs your running context is not.
2. Give each worker one narrowly scoped task, exclusive ownership of the files or resources it touches, and every fact it needs to start without asking. Workers begin with empty context.
3. While workers run, continue useful work that does not overlap theirs. Waiting idle is a failure of delegation, not a feature of it.
4. Coordinate anything shared: if two pieces touch the same file, interface, or config, you own that seam and you do the merge.
5. Verify every worker's result yourself (read the diff, run the check) before reporting it as done. Delegated work is unverified work until you have looked.

## Boundaries

- One task, one worker. Two workers on the same task is duplicate work.
- Workers do not spawn workers. Recursion is yours to prevent.
- Delegation that costs more than it saves (a five-line edit, a single file read) is not delegation, it is overhead. Do it yourself.
- Every applicable instruction, user request, and tool permission still applies. Ultra mode changes how much you delegate, not what you are allowed to do.
