#!/usr/bin/env bash
# Workflow supply-chain policy: the static rules every .github/workflows file obeys.
#
# Run by the required `Workflow policy` job (.github/workflows/workflow-policy.yml) on
# every pull request and push to main, before actionlint. It is plain grep and awk so
# it needs nothing installed, and it reads only the files it is pointed at.
#
# - Rule 1: every `uses:` is a local path (./...) or owner/repo[/path]@<40-hex> with a
#   trailing `# <ref>` comment naming what the SHA is.
# - Rule 2: every workflow has a top-level `permissions:` block.
# - Rule 3: no `pull_request_target` (fork code must never run with secrets).
# - Rule 4: no `secrets: inherit` (a callee gets only what it is handed by name).
# - Rule 5: every `gh release create|edit` outside release.yml carries --latest=false,
#   so a cloud or mobile release can never become "latest" and break install.sh.
# - Rule 6: only release-cloud.yml names the generated cloud-deploy branches, and
#   nothing names `cloud-stable` (T52).
# - Rule 7: every literal `environment:` a workflow uses is named in
#   BRANCH_PROTECTION.md, so no environment exists without its documented reviewers.
# - Comment lines are ignored for rules 3 to 6; a rule cannot be dodged by quoting it.
#
# - Rule 1 also covers the local composite actions under .github/actions/.
#
# Usage: check_workflow_policy.sh [workflows-dir] [branch-protection-file] [actions-dir]
# Exit 0 when every rule holds, 1 with one line per violation otherwise.
#
# <module-headers:begin>
# Uses: none
# External: none
#
# Used by: entry point (workflow-policy.yml, and test_check_workflow_policy.sh)
# <module-headers:end>

set -euo pipefail

DIR="${1:-.github/workflows}"
PROTECTION="${2:-.github/BRANCH_PROTECTION.md}"
ACTIONS="${3:-.github/actions}"
failures=0

fail() {
  echo "POLICY: $1" >&2
  failures=$((failures + 1))
}

# Prints the file's lines with full-line comments blanked (line numbers kept).
code_lines() {
  sed -E 's/^[[:space:]]*#.*$//' "$1"
}

# Rule 1: pinned actions. A `uses:` value is the token after the key.
check_pins() {
  local f="$1" name="$2" hit lineno line value
  while IFS= read -r hit; do
    lineno="${hit%%:*}"
    line="${hit#*:}"
    value="$(printf '%s' "$line" | sed -E 's/^[[:space:]]*(-[[:space:]]+)?uses:[[:space:]]*//')"
    case "$value" in
      ./*) continue ;;
    esac
    if ! printf '%s' "$value" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+@[0-9a-f]{40}[[:space:]]+#[[:space:]]*[^[:space:]]+'; then
      fail "$name:$lineno: '$value' is not pinned to a 40-hex commit SHA with a '# <ref>' comment"
    fi
  done < <(code_lines "$f" | grep -nE '^[[:space:]]*(-[[:space:]]+)?uses:' || true)
}

shopt -s nullglob
files=("$DIR"/*.yml "$DIR"/*.yaml)
if [ "${#files[@]}" -eq 0 ]; then
  echo "POLICY: no workflow files under $DIR" >&2
  exit 1
fi

for f in "${files[@]}"; do
  name="$(basename "$f")"

  check_pins "$f" "$name"

  # Rule 2: top-level permissions.
  if ! grep -Eq '^permissions:' "$f"; then
    fail "$name: no top-level 'permissions:' block (least privilege must be explicit)"
  fi

  # Rule 3 and 4.
  if code_lines "$f" | grep -nq 'pull_request_target'; then
    fail "$name: uses pull_request_target, which runs fork code with the base repo's secrets"
  fi
  if code_lines "$f" | grep -nEq 'secrets:[[:space:]]*inherit'; then
    fail "$name: 'secrets: inherit' hands every secret to the callee; pass them by name"
  fi

  # Rule 5: new-train releases never become "latest".
  if [ "$name" != "release.yml" ]; then
    while IFS= read -r hit; do
      case "$hit" in
        *--latest=false*) ;;
        *) fail "$name:${hit%%:*}: 'gh release create/edit' without --latest=false on the same line" ;;
      esac
    done < <(code_lines "$f" | grep -nE 'gh release (create|edit)' || true)
  fi

  # Rule 6: the generated deploy branches have exactly one writer.
  if [ "$name" != "release-cloud.yml" ] && code_lines "$f" | grep -nq 'cloud-deploy'; then
    fail "$name: names a cloud-deploy branch; only release-cloud.yml may write it (T52)"
  fi
  if code_lines "$f" | grep -nq 'cloud-stable'; then
    fail "$name: names cloud-stable, which the plan retired in favour of cloud-deploy (D18)"
  fi

  # Rule 7: literal environments are documented. `environment: x` or `name: x` under it.
  # shellcheck disable=SC2016 # awk program and a literal '${{', not shell expansions
  while IFS= read -r env; do
    [ -n "$env" ] || continue
    if [ ! -f "$PROTECTION" ] || ! grep -q -- "\`$env\`" "$PROTECTION"; then
      fail "$name: environment '$env' is not named (in backticks) in $PROTECTION"
    fi
  done < <(code_lines "$f" | awk '
    /^[[:space:]]*environment:[[:space:]]*$/ { want = 1; next }
    want && /^[[:space:]]*name:/ { sub(/^[[:space:]]*name:[[:space:]]*/, ""); print; want = 0; next }
    want { want = 0 }
    /^[[:space:]]*environment:[[:space:]]*[^[:space:]]/ { sub(/^[[:space:]]*environment:[[:space:]]*/, ""); print }
  ' | tr -d "\"'" | grep -vF '${{' || true)
done

# Local composite actions run inside workflows, so their pins obey rule 1 too.
for f in "$ACTIONS"/*/action.yml "$ACTIONS"/*/action.yaml; do
  check_pins "$f" "${f#"$ACTIONS"/}"
done

if [ "$failures" -gt 0 ]; then
  echo "workflow policy: $failures violation(s) in $DIR" >&2
  exit 1
fi
echo "workflow policy: ${#files[@]} workflow file(s) in $DIR pass every rule"
