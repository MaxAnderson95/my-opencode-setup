#!/usr/bin/env bash
#
# link.sh — symlink this repo's plugins and skills into your OpenCode config.
#
# Plugins (two kinds, linked differently):
#   * Server-only plugins use the loader's top-level *.ts discovery.
#   * Plugins with a TUI entrypoint are linked as package directories containing
#     index.ts and tui.*, allowing the server to advertise the TUI feature.
#
# Skills:
#   * Each skills/<name>/ is symlinked as a directory into <config>/skills/<name>.
#
# Idempotent: safe to re-run.

set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"

# --- remove links from retired plugin layouts ---
mkdir -p "$CONFIG/plugins" "$CONFIG/plugins/tui"
for link in "$CONFIG"/plugins/*; do
  [ -L "$link" ] || continue
  case "$(readlink "$link")" in
    "$REPO"/plugins/*)
      rm -f "$link"
      echo "unlink/stale   $(basename "$link")"
      ;;
  esac
done
for link in "$CONFIG"/plugins/tui/*; do
  [ -L "$link" ] || continue
  case "$(readlink "$link")" in
    "$REPO"/plugins/*)
      rm -f "$link"
      echo "unlink/stale   tui/$(basename "$link")"
      ;;
  esac
done

# --- plugins ---
for dir in "$REPO"/plugins/*/; do
  name="$(basename "$dir")"
  for entry in "$dir"tui.tsx "$dir"tui.ts "$dir"tui.jsx "$dir"tui.js; do
    if [ -f "$entry" ]; then
      if [ ! -f "$dir/index.ts" ] && [ ! -f "$dir/index.js" ]; then
        echo "plugin/skip    $name (tui.* requires index.ts or index.js)"
        continue 2
      fi
      ln -sfn "${dir%/}" "$CONFIG/plugins/$name"
      echo "plugin/package $name/"
      continue 2
    fi
  done
  if [ -f "$dir$name.ts" ]; then
    ln -sfn "$dir$name.ts" "$CONFIG/plugins/$name.ts"
    echo "plugin/server  $name.ts"
  else
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
