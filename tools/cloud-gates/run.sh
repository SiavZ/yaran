#!/usr/bin/env bash
# Gate dispatcher: run one Phase 03 gate, or the unattended HTTP-level recheck.
#
#   ./run.sh G02          # one gate (G2, g02 and 2 work too); extra args pass through
#   ./run.sh --list       # every gate script and its question
#   ./run.sh --recheck    # G2, G3, G8, G9, G12, G14 API/HTTP halves, no prompts
#
# The recheck is Phase 19's nightly drift check (19 WI-9): it sets
# GATES_RECHECK=1 so every operator step is recorded as skipped instead of
# blocking, collects each gate's `summary:` line, and prints one JSON document
# `{recheck, started, finished, gates:[…], ok}` as its last line (also written to
# $GATES_RECHECK_OUT when set). It exits 0 only when every gate exits 0.
#
# - Read tools/cloud-gates/README.md first; settings come from env.example.
# - Gate scripts are executed, not sourced, so each keeps its own EXIT trap.
#
# <module-headers:begin>
# Uses: none
# External: none
#
# Used by: entry point (operator shell; Phase 19 nightly drift check via --recheck)
# <module-headers:end>
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
RECHECK_GATES=(G02 G03 G08 G09 G12 G14)

usage() { sed -n '3,6p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

# gate_script <G2|G02|g02|2>: path of the matching gNN-*.sh, or empty.
gate_script() {
  local n="${1#[Gg]}"
  [[ "$n" =~ ^[0-9]{1,2}$ ]] || return 1
  n="$(printf '%02d' "$((10#$n))")"
  local f
  for f in "$HERE"/g"$n"-*.sh; do [[ -f "$f" ]] && { printf '%s' "$f"; return 0; }; done
  return 1
}

list() {
  local f
  for f in "$HERE"/g[0-9][0-9]-*.sh; do
    printf '%-32s %s\n' "$(basename "$f")" "$(sed -n '2p' "$f" | sed 's/^# //')"
  done
}

recheck() {
  local started out g f line ok=true results=()
  started="$(date -u +%FT%TZ)"
  out="$(mktemp)"
  for g in "${RECHECK_GATES[@]}"; do
    f="$(gate_script "$g")" || { results+=("{\"gate\":\"$g\",\"ok\":false,\"error\":\"script missing\"}"); ok=false; continue; }
    if GATES_RECHECK=1 bash "$f" --recheck </dev/null 2>&1 | tee "$out" >&2; then :; fi
    line="$(grep "^summary: " "$out" | tail -1 | cut -d" " -f2- || true)"
    if [[ -z "$line" ]]; then
      line="{\"gate\":\"$g\",\"ok\":false,\"error\":\"no summary (prerequisite missing or crash; see output)\"}"
    fi
    [[ "$(jq -r .ok <<<"$line")" == true ]] || ok=false
    results+=("$line")
  done
  rm -f "$out"
  local doc
  doc="$(printf '%s\n' "${results[@]}" | jq -sc --arg s "$started" --arg f "$(date -u +%FT%TZ)" --argjson ok "$ok" \
    '{recheck:true, started:$s, finished:$f, gates:., ok:$ok}')"
  [[ -n "${GATES_RECHECK_OUT:-}" ]] && printf '%s\n' "$doc" >"$GATES_RECHECK_OUT"
  printf '%s\n' "$doc"
  [[ "$ok" == true ]]
}

case "${1:-}" in
  --recheck) recheck ;;
  --list) list ;;
  "" | -h | --help) usage ;;
  *)
    f="$(gate_script "$1")" || { printf 'run.sh: no gate script for %s (try --list)\n' "$1" >&2; exit 2; }
    shift
    exec bash "$f" "$@"
    ;;
esac
