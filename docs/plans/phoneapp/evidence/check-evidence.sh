#!/usr/bin/env bash
# CI check: no unredacted secret under docs/plans/phoneapp/evidence/.
#
# Runs every text file in the evidence tree through the gate redaction filter
# (`tools/cloud-gates/lib/redact.sh`) and fails when the filter would change
# anything, because redaction is idempotent: a file that changes still holds a
# JWT, token, key or device token. Reusing the filter keeps one pattern list.
#
# - Prints the file and line NUMBER of each hit, never the line itself.
# - Binary files (screenshots) are skipped; scrub those by hand before commit.
# - Usage: check-evidence.sh [dir]   (default: this script's own directory).
#   Phase 18 wires it into the always-reporting CI aggregator.
#
# <module-headers:begin>
# Uses:
# docs/plans/phoneapp/evidence/check-evidence.sh
# └── tools/cloud-gates/lib/redact.sh
# External: none
#
# Used by: entry point (CI and tools/cloud-gates/tests/redact_test.sh)
# <module-headers:end>
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=tools/cloud-gates/lib/redact.sh
. "$(dirname "$0")/../../../../tools/cloud-gates/lib/redact.sh"
ROOT="${1:-$HERE}"
[[ -d "$ROOT" ]] || { printf 'check-evidence: no such directory %s\n' "$ROOT" >&2; exit 2; }

hits=0
while IFS= read -r -d '' f; do
  grep -Iq . "$f" 2>/dev/null || continue # binary or empty
  lines="$(diff <(cat "$f") <(redact <"$f") | grep -Eo '^[0-9]+(,[0-9]+)?[acd]' | tr -d 'acd' | tr '\n' ' ' || true)"
  if [[ -n "$lines" ]]; then
    printf 'check-evidence: unredacted secret in %s (lines %s)\n' "${f#"$ROOT"/}" "$lines" >&2
    hits=$((hits + 1))
  fi
done < <(find "$ROOT" -type f ! -name check-evidence.sh -print0)

if ((hits)); then
  printf 'check-evidence: %d file(s) failed; re-run the gate (its output is redacted) or pipe the file through tools/cloud-gates/lib/redact.sh\n' "$hits" >&2
  exit 1
fi
printf 'check-evidence: clean (%s)\n' "$ROOT"
