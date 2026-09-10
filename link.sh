#!/usr/bin/env bash
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"

mkdir -p "$CONFIG/skills" "$CONFIG/themes"
for dir in "$REPO"/skills/*/; do
  name="$(basename "$dir")"
  ln -sfn "${dir%/}" "$CONFIG/skills/$name"
done
for theme in "$REPO"/themes/*.json; do
  ln -sfn "$theme" "$CONFIG/themes/$(basename "$theme")"
done

echo "Skills and themes linked. Plugins are installed from GitHub package specifications in opencode.jsonc."
