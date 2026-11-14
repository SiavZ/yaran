#!/usr/bin/env bash
# Shared runtime for every gate script: prerequisites, evidence, criteria, cleanup.
#
# A gate script sources this file, calls `gate_init`, records everything it sees
# through `record` (which redacts), states each pass criterion with `check`, and
# exits through the EXIT trap, which runs cleanups in reverse order and writes
# the run's `observations.tsv`, `observations.md` and `summary.json` into
# `docs/plans/phoneapp/evidence/<gate>/run-YYYY-MM-DD/`.
#
# - Secrets come only from the environment or a hidden prompt on /dev/tty,
#   never argv: `header_file` writes them to an owner-only temp file for curl.
# - Exit codes: 0 every criterion met, 1 a criterion unmet, 2 a prerequisite or
#   infrastructure failure (`die`). `run.sh --recheck` relies on this.
# - `GATES_RECHECK=1` (set by `run.sh --recheck`) means unattended: every prompt
#   is answered "skipped" instead of blocking.
# - Bash 3.2 compatible (the macOS system bash): no associative arrays.
#
# <module-headers:begin>
# Uses:
# tools/cloud-gates/lib/common.sh
# └── tools/cloud-gates/lib/redact.sh
# External: curl, jq, mktemp, shasum|sha256sum
#
# Used by:
# tools/cloud-gates/lib/common.sh
# ├── tools/cloud-gates/lib/cf.sh
# ├── tools/cloud-gates/lib/access.sh
# ├── tools/cloud-gates/tests/lib_test.sh
# ├── tools/cloud-gates/g01-cookie-injection.sh
# ├── tools/cloud-gates/g02-cloudflared-origin.sh
# ├── tools/cloud-gates/g03-access-responses.sh
# ├── tools/cloud-gates/g04-apns.sh
# ├── tools/cloud-gates/g05-embedded-fcm.sh
# ├── tools/cloud-gates/g06-machine-view.sh
# ├── tools/cloud-gates/g07-fdroid.sh
# ├── tools/cloud-gates/g08-public-paths.sh
# ├── tools/cloud-gates/g09-token-template.sh
# ├── tools/cloud-gates/g10-idp.sh
# ├── tools/cloud-gates/g11-deploy-button.sh
# ├── tools/cloud-gates/g12-session-expiry.sh
# ├── tools/cloud-gates/g13-system-browser-auth.sh
# └── tools/cloud-gates/g14-custom-domain.sh
# <module-headers:end>

GATES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$GATES_DIR/../.." && pwd)"
EVIDENCE_ROOT="${GATES_EVIDENCE_ROOT:-$REPO_ROOT/docs/plans/phoneapp/evidence}"
BROWSER_UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
# shellcheck source=tools/cloud-gates/lib/redact.sh
. "$(dirname "${BASH_SOURCE[0]}")/redact.sh"

GATE="${GATE:-gates}"
_CLEANUPS=()
_MET=0 _UNMET=0 _SKIPPED=0

log() { printf '[%s] %s\n' "$GATE" "$*" | redact | _tee_log >&2; }
die() { log "ERROR: $*"; exit 2; }
step() { log "== $*"; }
is_recheck() { [[ "${GATES_RECHECK:-0}" == 1 ]]; }

# Append to the run log when a run is active; pass through either way.
_tee_log() {
  if [[ -n "${EVIDENCE_DIR:-}" ]]; then tee -a "$EVIDENCE_DIR/log.txt"; else cat; fi
}

# require_env VAR...: fail once, naming every missing variable.
require_env() {
  local v missing=()
  for v in "$@"; do [[ -n "${!v:-}" ]] || missing+=("$v"); done
  if ((${#missing[@]})); then
    die "missing environment: ${missing[*]} (see tools/cloud-gates/env.example; copy it to an untracked .env.local and source it)"
  fi
}

# require_tty: interactive gates stop at once rather than skipping every step.
require_tty() { { : </dev/tty; } 2>/dev/null || die "this gate needs an interactive terminal (operator steps and device checklists)"; }

require_cmd() {
  local c missing=()
  for c in "$@"; do command -v "$c" >/dev/null 2>&1 || missing+=("$c"); done
  ((${#missing[@]} == 0)) || die "missing commands on PATH: ${missing[*]}"
}

# gate_init <G01..G14> <slug>: start a run, its evidence dir, temp dir and traps.
gate_init() {
  GATE="$1"
  local slug="$2" day lower
  require_cmd curl jq perl
  day="$(date -u +%F)"
  lower="$(printf '%s' "$GATE" | tr '[:upper:]' '[:lower:]')"
  RUN_ID="$(date -u +%m%d%H%M)$(printf '%04x' "$RANDOM")"
  GATE_TAG="gate-$lower-$RUN_ID"
  EVIDENCE_DIR="$EVIDENCE_ROOT/$GATE-$slug/run-$day"
  [[ -e "$EVIDENCE_DIR" ]] && EVIDENCE_DIR="$EVIDENCE_DIR-$(date -u +%H%M%S)"
  mkdir -p "$EVIDENCE_DIR"
  RUN_TMP="$(mktemp -d "${TMPDIR:-/tmp}/cloud-gates.XXXXXX")"
  chmod 700 "$RUN_TMP"
  printf 'criterion\texpected\tobserved\tresult\n' >"$EVIDENCE_DIR/observations.tsv"
  trap _gate_exit EXIT
  trap 'exit 130' INT TERM
  log "run $RUN_ID, resources tagged $GATE_TAG, evidence in ${EVIDENCE_DIR#"$REPO_ROOT"/}"
  is_recheck && log "unattended recheck mode: interactive steps are skipped"
  return 0
}

# cleanup_push <shell words>: run at exit, last pushed first.
cleanup_push() { _CLEANUPS+=("$*"); }

_gate_exit() {
  local code=$? i
  for ((i = ${#_CLEANUPS[@]} - 1; i >= 0; i--)); do
    eval "${_CLEANUPS[$i]}" >/dev/null 2>&1 || log "cleanup failed (resource may remain; run lib/access.sh sweep): ${_CLEANUPS[$i]}"
  done
  [[ -n "${RUN_TMP:-}" ]] && rm -rf "$RUN_TMP"
  # A run that stopped on a prerequisite before observing anything leaves no evidence.
  if ((code == 2 && _MET + _UNMET + _SKIPPED == 0)) && [[ -n "${EVIDENCE_DIR:-}" ]] && ! grep -q 'observed$' "$EVIDENCE_DIR/observations.tsv"; then
    rm -rf "$EVIDENCE_DIR"
    exit 2
  fi
  if [[ -n "${EVIDENCE_DIR:-}" ]]; then
    write_observations_md "$EVIDENCE_DIR/observations.tsv" >"$EVIDENCE_DIR/observations.md"
    write_summary "$code" >"$EVIDENCE_DIR/summary.json"
    printf 'summary: %s\n' "$(jq -c . "$EVIDENCE_DIR/summary.json")"
  fi
  if ((code == 0 && _UNMET > 0)); then exit 1; fi
  exit "$code"
}

# write_summary <exit code>: the JSON line run.sh --recheck aggregates.
write_summary() {
  jq -n --arg gate "$GATE" --arg run "$RUN_ID" --arg date "$(date -u +%FT%TZ)" \
    --argjson met "$_MET" --argjson unmet "$_UNMET" --argjson skipped "$_SKIPPED" \
    --argjson code "$1" --arg recheck "${GATES_RECHECK:-0}" \
    --arg evidence "${EVIDENCE_DIR#"$REPO_ROOT"/}" \
    '{gate:$gate, run_id:$run, finished:$date, recheck:($recheck=="1"), met:$met, unmet:$unmet,
      skipped:$skipped, exit_code:(if $code==0 and $unmet>0 then 1 else $code end),
      ok:($code==0 and $unmet==0 and $met>0), evidence:$evidence}'
}

# write_observations_md <tsv>: the Observations table RESULT.md pastes in.
write_observations_md() {
  printf '| Criterion | Expected | Observed | Met? |\n|---|---|---|---|\n'
  tail -n +2 "$1" | while IFS=$'\t' read -r c e o r; do
    printf '| %s | %s | %s | %s |\n' "${c//|/\\|}" "${e//|/\\|}" "${o//|/\\|}" "$r"
  done
}

_row() { printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" | tr -d '\r' | redact >>"$EVIDENCE_DIR/observations.tsv"; }

# check <criterion> <expected> <observed>: expected is a literal, or `re:<ERE>`.
check() {
  local name="$1" exp="$2" obs="$3" ok=1
  if [[ "$exp" == re:* ]]; then [[ "$obs" =~ ${exp#re:} ]] || ok=0; else [[ "$obs" == "$exp" ]] || ok=0; fi
  if ((ok)); then _MET=$((_MET + 1)); _row "$name" "$exp" "$obs" met; log "MET    $name: $obs"
  else _UNMET=$((_UNMET + 1)); _row "$name" "$exp" "$obs" UNMET; log "UNMET  $name: expected $exp, observed $obs"; fi
}

# observe <what> <value>: a recorded fact with no pass/fail of its own.
observe() { _row "$1" "-" "$2" observed; log "OBSERVE $1: $2"; }

skip() { _SKIPPED=$((_SKIPPED + 1)); _row "$1" "-" "skipped: $2" skipped; log "SKIP   $1: $2"; }

# record [name]: stdin, redacted, to the terminal and evidence/<name>.txt.
record() { redact | tee -a "$EVIDENCE_DIR/${1:-log}.txt"; }

# checklist <title>: print a device checklist from stdin and keep it as evidence.
checklist() {
  { printf '\n### Device checklist: %s\n\n' "$1"; cat; printf '\n'; } | tee -a "$EVIDENCE_DIR/checklist.md" >&2
}

_tty_read() { # _tty_read <silent 0|1> <prompt>
  [[ -r /dev/tty ]] || return 1
  printf '%s ' "$2" >/dev/tty
  local ans
  if [[ "$1" == 1 ]]; then IFS= read -rs ans </dev/tty; printf '\n' >/dev/tty; else IFS= read -r ans </dev/tty; fi
  printf '%s' "$ans"
}

# read_secret <VAR> <prompt>: keep VAR if already in the env, else prompt hidden.
# Returns 1 (VAR left empty) in recheck mode or with no terminal.
read_secret() {
  [[ -n "${!1:-}" ]] && return 0
  is_recheck && return 1
  local val
  val="$(_tty_read 1 "$2 (input hidden, empty to skip):")" || return 1
  [[ -n "$val" ]] || return 1
  printf -v "$1" '%s' "$val"
}

# obtain_jwt <VAR> <host> <prompt>: an Access JWT for <host>. Order: VAR already
# in the env; GATE_IDENTITY_JWT_CMD (Phase 19's automated sign-in, run with
# GATE_IDENTITY_HOST=<host>, printing one JWT); a hidden prompt.
obtain_jwt() {
  [[ -n "${!1:-}" ]] && return 0
  if [[ -n "${GATE_IDENTITY_JWT_CMD:-}" ]]; then
    local t; t="$(GATE_IDENTITY_HOST="$2" bash -c "$GATE_IDENTITY_JWT_CMD" 2>/dev/null | tail -1)" || t=""
    [[ -n "$t" ]] && { printf -v "$1" '%s' "$t"; return 0; }
  fi
  read_secret "$1" "$3"
}

# ask <VAR> <prompt>: a non-secret answer, recorded as an observation.
ask() {
  [[ -n "${!1:-}" ]] && return 0
  is_recheck && return 1
  local val; val="$(_tty_read 0 "$2:")" || return 1
  printf -v "$1" '%s' "$val"
  [[ -n "$val" ]] && observe "$2" "$val"
  [[ -n "$val" ]]
}

# confirm_check <criterion> <question>: an operator-observed pass criterion.
confirm_check() {
  if is_recheck; then skip "$1" "operator observation"; return 0; fi
  local a; a="$(_tty_read 0 "$2 [y/n/s=skip]:")" || { skip "$1" "no terminal"; return 0; }
  case "$a" in
    y | Y) check "$1" yes yes ;;
    s | S | '') skip "$1" "operator skipped" ;;
    *) check "$1" yes no ;;
  esac
}

pause() { is_recheck || _tty_read 0 "$1 — press Enter when done" >/dev/null || true; }

# header_file <name> <header lines...>: owner-only file for `curl -H @file`.
header_file() {
  local f="$RUN_TMP/hdr-$1"; shift
  (umask 077; printf '%s\n' "$@" >"$f")
  printf '%s' "$f"
}

sha256_hex() { if command -v sha256sum >/dev/null; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi; }

# version_ge <a> <b>: true when dotted version a >= b (numeric per field).
version_ge() {
  local i a b
  IFS=. read -ra a <<<"$1"
  IFS=. read -ra b <<<"$2"
  for ((i = 0; i < 4; i++)); do
    ((10#${a[i]:-0} > 10#${b[i]:-0})) && return 0
    ((10#${a[i]:-0} < 10#${b[i]:-0})) && return 1
  done
  return 0
}

# bg_start <name> <cmd...>: background process, output recorded, killed at exit.
bg_start() {
  local name="$1"; shift
  ("$@" 2>&1 | redact >>"$EVIDENCE_DIR/$name.txt") &
  local pid=$!
  cleanup_push "pkill -P $pid; kill $pid"
  log "started $name (pid $pid)"
}

# wait_until <seconds> <cmd...>: poll every 2 s until cmd succeeds.
wait_until() {
  local deadline=$((SECONDS + $1)); shift
  until "$@" >/dev/null 2>&1; do ((SECONDS < deadline)) || return 1; sleep 2; done
}

# probe <get|nav|fetch|xhr|ws|preflight> <url> [header-file]
# Prints: status<TAB>location (no query)<TAB>content-type<TAB>www-authenticate<TAB>body (200 bytes).
probe() {
  local kind="$1" url="$2" hdr="${3:-/dev/null}" key
  local -a a=(-sS -o "$RUN_TMP/probe.body" -D "$RUN_TMP/probe.head" --max-time "${PROBE_TIMEOUT:-8}" -H "@$hdr")
  case "$kind" in
    get) ;;
    nav) a+=(-A "$BROWSER_UA" -H 'Accept: text/html,application/xhtml+xml') ;;
    fetch) a+=(-H 'Accept: application/json') ;;
    xhr) a+=(-H 'X-Requested-With: XMLHttpRequest' -H 'Accept: */*') ;;
    ws)
      key="$(head -c 16 /dev/urandom | base64)"
      a+=(--http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H "Sec-WebSocket-Key: $key")
      ;;
    preflight) a+=(-X OPTIONS -H 'Origin: https://gate-origin.example.invalid' -H 'Access-Control-Request-Method: GET') ;;
    *) die "probe: unknown kind $kind" ;;
  esac
  : >"$RUN_TMP/probe.head"; : >"$RUN_TMP/probe.body"
  curl "${a[@]}" "$url" 2>/dev/null || true # a 101 runs into --max-time by design
  parse_probe_head "$RUN_TMP/probe.head" "$RUN_TMP/probe.body"
}

# parse_probe_head <header-dump> <body-file>: the probe line, testable offline.
parse_probe_head() {
  local status loc ct wa body
  status="$(awk 'toupper($1) ~ /^HTTP\// {s=$2} END {print (s ? s : "000")}' "$1")"
  loc="$(grep -i '^location:' "$1" | tail -1 | cut -d' ' -f2- | tr -d '\r')"
  ct="$(grep -i '^content-type:' "$1" | tail -1 | cut -d' ' -f2- | tr -d '\r')"
  wa="$(grep -i '^www-authenticate:' "$1" | tail -1 | cut -d' ' -f2- | tr -d '\r')"
  body="$(head -c 200 "$2" | tr '\t\r\n' '   ')"
  printf '%s\t%s\t%s\t%s\t%s\n' "$status" "${loc%%\?*}" "${ct:--}" "${wa:--}" "${body:--}"
}

probe_status() { probe "$@" | cut -f1; }
