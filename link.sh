#!/usr/bin/env bash
#
# link.sh — symlink this repo's plugins and skills into your OpenCode config.
#
# Plugins (two kinds, linked differently):
#   * Server plugins — the loader auto-scans plugins/*.{ts,js} (top-level files
#     only, follows symlinks), so we symlink the inner source file
#     (plugins/<name>/<name>.ts -> <config>/plugins/<name>.ts).
#   * TUI plugins    — expose a ./tui entrypoint and are NOT auto-scanned, so we
#     symlink the whole directory; you still must list it in tui.jsonc.
#
# Skills:
#   * Each skills/<name>/ is symlinked as a directory into <config>/skills/<name>.
#
# Idempotent: safe to re-run.

set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"

# --- plugins ---
mkdir -p "$CONFIG/plugins"
for dir in "$REPO"/plugins/*/; do
  name="$(basename "$dir")"
  found=false
  if [ -f "$dir$name.ts" ]; then
    ln -sfn "$dir$name.ts" "$CONFIG/plugins/$name.ts"
    echo "plugin/server  $name.ts"
    found=true
  fi
  if compgen -G "$dir"tui.* >/dev/null; then
    ln -sfn "${dir%/}" "$CONFIG/plugins/$name"
    echo "plugin/tui     $name/   (add it to tui.jsonc's plugin[] array)"
    found=true
  fi
  if [ "$found" = false ]; then
    echo "plugin/skip    $name (no <name>.ts or tui.* entrypoint)"
  fi
done

# --- skills ---
if [ -d "$REPO/skills" ]; then
  mkdir -p "$CONFIG/skills"
  for dir in "$REPO"/skills/*/; do
    name="$(basename "$dir")"
    ln -sfn "${dir%/}" "$CONFIG/skills/$name"
    echo "skill          $name/"
  done
fi

echo "Done. TUI plugins must also be listed in tui.jsonc — see tui.example.jsonc."
