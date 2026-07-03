#!/usr/bin/env bash
#
# link.sh — symlink each plugin in this repo into your OpenCode config.
#
# Two kinds of plugin, linked differently:
#   * Server plugins  — the loader auto-scans plugins/*.{ts,js} (top-level files
#     only, follows symlinks), so we symlink the inner source file
#     (plugins/<name>/<name>.ts -> ~/.config/opencode/plugins/<name>.ts).
#   * TUI plugins     — expose a ./tui entrypoint and are NOT auto-scanned, so we
#     symlink the whole directory; you still must list it in tui.jsonc.
#
# Idempotent: safe to re-run.

set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}/plugins"
mkdir -p "$DEST"

for dir in "$REPO"/plugins/*/; do
  name="$(basename "$dir")"
  if [ -f "$dir$name.ts" ]; then
    ln -sfn "$dir$name.ts" "$DEST/$name.ts"
    echo "server  $name.ts -> $dir$name.ts"
  elif compgen -G "$dir"tui.* >/dev/null; then
    ln -sfn "${dir%/}" "$DEST/$name"
    echo "tui     $name/  -> ${dir%/}   (add it to tui.jsonc's plugin[] array)"
  else
    echo "skip    $name (no <name>.ts or tui.* entrypoint)"
  fi
done

echo "Done. TUI plugins must also be listed in tui.jsonc — see tui.example.jsonc."
