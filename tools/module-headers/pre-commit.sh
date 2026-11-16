#!/bin/sh
# Opt-in pre-commit check: module-header blocks of the staged files, plus the line gate.
#
# Enable it once per clone with `git config core.hooksPath tools/module-headers/hooks`.
# CI (`.github/workflows/gates.yml`) is the real gate; this only catches drift before a
# push. It reads the working tree, not the index, so stage what you checked.
#
# - Checks only staged files that still exist; the tool skips files outside scope.
# - Needs `npm ci` in tools/module-headers; says so instead of failing obscurely.
# - Fix drift with: node tools/module-headers/bin/module-headers.mjs --write <path>
#
# <module-headers:begin>
# Uses: none
# External: none
#
# Used by: entry point (opt-in git hook, run by tools/module-headers/hooks/pre-commit)
# <module-headers:end>
set -eu

root=$(git rev-parse --show-toplevel)
tool="$root/tools/module-headers"
if [ ! -d "$tool/node_modules" ]; then
  echo "module-headers pre-commit: run 'npm ci' in tools/module-headers first (or unset core.hooksPath)" >&2
  exit 1
fi

staged=$(git diff --cached --name-only --diff-filter=ACMR)
status=0
if [ -n "$staged" ]; then
  (cd "$root" && printf '%s\n' "$staged" | tr '\n' '\0' | xargs -0 node "$tool/bin/module-headers.mjs" --check) || status=1
fi
(cd "$root" && node "$tool/bin/module-headers.mjs" --lines --check) || status=1
exit "$status"
