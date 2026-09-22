# question-minimize

Minimizes a pending question form in the TUI to a one-line bar so the transcript above it gets the full height of the session pane.

| Key | Where | Action |
|---|---|---|
| `alt+m` | Question form | Minimize |
| `alt+m`, `enter`, `esc` | Minimized bar | Restore the form |
| `↑` `↓` | Minimized bar | Scroll the transcript one line |
| `pgup` `pgdn` | Minimized bar | Scroll the transcript (native session bindings) |

Clicking the bar also restores the form. While the form is minimized, the plugin holds its own keymap mode, so answer and dismiss keys cannot reach the hidden form. If the form is answered from another client or replaced by a new one, the bar goes away and the new form shows expanded.

Change the key with the `keybind` plugin option:

```jsonc
{
  "plugins": [
    { "package": "github:MaxAnderson95/my-opencode-setup#plugin-question-minimize", "options": { "keybind": "alt+q" } }
  ]
}
```

## How it works

OpenCode 2.0.14 has no slot for the form. The plugin renders an anchor box in the `session.composer.top` slot, which sits in the same composer box as the host's form. When the host's `form` keymap mode is active, the form is the last visible child of that box, and the plugin toggles its `visible` flag. This depends on the host's layout in `packages/tui/src/routes/session/index.tsx`; if an upgrade moves the form, `alt+m` does nothing.
