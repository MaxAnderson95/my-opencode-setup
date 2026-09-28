---
name: btca-local
description: Search and read the source of third-party open-source projects from local clones in ~/.btca/agent/sandbox. Use when investigating how an upstream tool, library, or app actually behaves, when the user says "use btca", or when docs are not enough.
---

# BTCA Local

Fork of `btca-local` from davis7dotsh/better-context, maintained in my-opencode-setup. The sandbox `~/.btca/agent/sandbox` holds one clone per upstream repository. Clones are read-only reference material: agents fetch into them and read from them, and never commit, pull, reset, or rebase inside them.

## Find the clone

1. List the sandbox with `ls ~/.btca/agent/sandbox` (the glob tool can hide directories there). The directory name is the repository name, for example `opencode` for `anomalyco/opencode`.
2. If the repository is absent, clone it as a blobless partial clone so large repositories finish inside the shell timeout:

   ```sh
   git clone --filter=blob:none https://github.com/<owner>/<repo>.git ~/.btca/agent/sandbox/<repo>
   ```

   Use a timeout of at least 300000 ms for large repositories (OpenCode, Chromium, Firefox). For a private repository that another GitHub account can read, pass that account per command: `GH_TOKEN="$(gh auth token --user <account>)" git clone ...`.

The clone is ready when `git -C <clone> rev-parse HEAD` succeeds.

## Select the revision

Pick the revision that matches the question before reading any file:

- **Installed software** (a CLI, plugin, or app on this Mac): read the source of the installed version. Get it from the tool itself (`opencode --version`, `<tool> --version`, `package.json`, `brew info`), then find the matching tag with `git -C <clone> tag -l '*<version>*'`.
- **Current upstream behavior**: read the remote default branch. Resolve it with `git -C <clone> symbolic-ref --short refs/remotes/origin/HEAD` rather than assuming `main`; OpenCode uses `dev`.
- **A specific PR, branch, or commit** named by the user: use that ref.

Refresh the refs without touching the checkout, then read from the ref directly:

```sh
git -C <clone> fetch --tags --prune origin
git -C <clone> ls-tree -r --name-only <ref> -- <dir>
git -C <clone> show <ref>:<path>
git -C <clone> grep -n '<pattern>' <ref> -- <dir>
```

When a task needs a real working tree at a ref (running tests, browsing many files with the read and grep tools), add a detached worktree beside the clone and work there:

```sh
git -C <clone> worktree add --detach ~/.btca/agent/sandbox/<repo>@<ref> <ref>
```

Reuse an existing `<repo>@<ref>` worktree when one is present. The clone's own checked-out branch may be stale or carry old local commits; that is expected, and reading from `<ref>` makes it irrelevant.

## Read and answer

- Locate files by listing the tree at the selected ref before reading; upstream layouts move between versions (OpenCode V2 splits into `packages/cli`, `packages/tui`, `packages/core`).
- Cite every finding as `<repo>@<ref>:<path>:<line>`, with a GitHub link when the ref exists upstream.
- Quote complete code snippets, including imports, when the snippet is the evidence.
- State the ref you read. When the installed version and upstream default branch differ in the relevant code, say which one the answer describes.

## Startup case

When the user invokes the skill with no question, list the sandbox and reply:

```md
# BTCA Local

_use your coding agent to search any git repo locally_

Previously searched:

- repo 1
- ...

Give me a question and the link to a git repo to get started!
```
