#!/usr/bin/env bash
#
# link.sh — symlink this repo's plugins and skills into your OpenCode config.
#
# Plugins (two kinds, linked differently):
#   * Server plugins — the loader auto-scans plugins/*.{ts,js} (top-level files
#     only, follows symlinks), so we symlink the inner source file
#     (plugins/<name>/<name>.ts -> <config>/plugins/<name>.ts).
#   * TUI plugins    — OpenCode 2 auto-scans <config>/plugins/tui/ for
#     *.{ts,tsx,js,jsx} (symlinks included), so we symlink the inner entrypoint
#     (plugins/<name>/tui.tsx -> <config>/plugins/tui/<name>.tsx). No config
#     entry is needed; v1's tui.jsonc plugin[] array is gone.
#
# A plugin may be both (callout ships a server half and a TUI half); each half
# is linked independently.
#
# legacy-v1/ holds plugins still on the v1 plugin API. They are deliberately NOT
# linked — v1 plugins do not load in OpenCode 2 and would only produce load
# errors. Port one back into plugins/ if you want it.
#
# Skills:
#   * Each skills/<name>/ is symlinked as a directory into <config>/skills/<name>.
#
# Idempotent: safe to re-run.

set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"

# --- migrate away from the v1 layout ---
# v1 linked TUI plugins as directory symlinks (<config>/plugins/<name>). Those
# still resolve under OpenCode 2's package discovery, so a leftover one loads the
# v1 source alongside its v2 replacement. Only symlinks pointing back into this
# repo are removed, so unrelated entries are left alone.
mkdir -p "$CONFIG/plugins" "$CONFIG/plugins/tui"
for link in "$CONFIG"/plugins/*; do
  [ -L "$link" ] || continue
  case "$(readlink "$link")" in
    "$REPO"/plugins/*)
      [ -d "$link" ] || continue
      rm -f "$link"
      echo "unlink/v1      $(basename "$link")/ (stale v1 directory symlink)"
      ;;
  esac
done

# --- plugins ---
for dir in "$REPO"/plugins/*/; do
  name="$(basename "$dir")"
  found=false
  if [ -f "$dir$name.ts" ]; then
    ln -sfn "$dir$name.ts" "$CONFIG/plugins/$name.ts"
    echo "plugin/server  $name.ts"
    found=true
  fi
  for entry in "$dir"tui.tsx "$dir"tui.ts "$dir"tui.jsx "$dir"tui.js; do
    if [ -f "$entry" ]; then
      ln -sfn "$entry" "$CONFIG/plugins/tui/$name.${entry##*.}"
      echo "plugin/tui     tui/$name.${entry##*.}"
      found=true
      break
    fi
  done
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

echo "Done. Set the theme in <config>/cli.json (see cli.example.json)."
