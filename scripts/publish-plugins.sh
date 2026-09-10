#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain)" ]; then
  echo "Commit source changes before publishing plugin branches." >&2
  exit 1
fi

# Package branches keep each Git dependency at the repository root. The current
# native installer does not correctly pack npm ::path: subdirectories.
for manifest in plugins/*/package.json; do
  directory="${manifest%/package.json}"
  name="${directory##*/}"
  revision="$(git subtree split --prefix="$directory" HEAD)"
  git push origin "$revision:refs/heads/plugin-$name"
done
