# model-favorites

Adds a favorites manager to the OpenCode TUI so you can put your favorite models in any order. The built-in "Select model" picker lists favorites in the order they are saved, but it can only add new favorites to the top and has no way to reorder them.

Requires OpenCode 2.0.14 or later.

## Usage

Open the manager in any of these ways:

- Run `/favorites`.
- Choose **Manage favorite models** in the command palette.
- Press `ctrl+g` while the built-in model picker is open.

The manager shows your favorites in saved order, followed by every other model grouped by provider. Type to filter by model name, provider, or ID.

| Key | Action |
| --- | --- |
| `up` / `down` | Move the highlight |
| `shift+up` / `shift+down` | Move the highlighted favorite up or down |
| `ctrl+f` | Add or remove the highlighted model as a favorite (new favorites go to the bottom) |
| `enter` | Return to the built-in model picker |
| `esc` | Close |

Choosing which model to use still happens in the built-in picker.

## How it works

Favorites live in the `favorite` array of `$XDG_STATE_HOME/opencode/model.json` (default `~/.local/state/opencode/model.json`). The plugin rewrites only that array and preserves every other field. It takes the same lock directory OpenCode uses for that file, so the TUI's own preference writes wait for it. OpenCode watches the file and reloads favorites live, so every open TUI picks up the new order without a restart.

The plugin API does not expose the built-in picker's highlighted row, so reordering happens in this separate dialog rather than inside the picker itself.
