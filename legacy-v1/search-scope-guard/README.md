# search-scope-guard

Prevents `glob` and `grep` from recursively searching filesystem roots that can make an OpenCode session appear frozen.

The plugin rejects searches rooted at:

- The current user's home directory
- Any ancestor of the home directory, including the filesystem root
- The macOS `~/Library` tree

Narrower project, configuration, and scratch directories continue normally. A blocked call returns an actionable tool error so the model can retry with a specific path. The guard also adds the restriction to the `glob` and `grep` tool descriptions sent to the model.

The effective search root is the tool's `path`, or the OpenCode process directory when `path` is omitted. Existing paths are canonicalized before comparison so symlinks cannot bypass the guard.

## Test

```bash
bun test plugins/search-scope-guard
```
