#!/usr/bin/env bash
# Fixture test for check_workflow_policy.sh: one passing and one failing workflow per rule.
#
# Each case writes a tiny workflow into a fresh temp directory beside a fixture
# BRANCH_PROTECTION.md and asserts the policy's exit status and, for failures, the
# message. The real .github/workflows tree is checked by the policy job itself.
#
# - Offline and side-effect free; the temp tree is removed on exit.
#
# Usage: .github/scripts/test_check_workflow_policy.sh
#
# <module-headers:begin>
# Uses: none
# External: none
#
# Used by: entry point (workflow-policy.yml: bash .github/scripts/test_check_workflow_policy.sh)
# <module-headers:end>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POLICY="$SCRIPT_DIR/check_workflow_policy.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
pass=0
fails=0

SHA=11d5960a326750d5838078e36cf38b85af677262
HEAD="name: t
on: push
permissions:
  contents: read
jobs:
  j:
    runs-on: ubuntu-24.04"

# case <label> <expect: pass|fail> <message regex or -> <file name> <body>
case_() {
  local label="$1" expect="$2" pattern="$3" file="$4" body="$5"
  local dir="$WORK/$label"
  mkdir -p "$dir/wf"
  printf '%s\n' "$body" > "$dir/wf/$file"
  # shellcheck disable=SC2016 # literal backticks, as BRANCH_PROTECTION.md writes them
  printf 'Environments: `android-release`, `cloud-release`.\n' > "$dir/BP.md"
  local out status=0
  if [ -n "${ACTION_BODY:-}" ]; then mkdir -p "$dir/actions/x"; printf '%s\n' "$ACTION_BODY" > "$dir/actions/x/action.yml"; fi
  out="$(bash "$POLICY" "$dir/wf" "$dir/BP.md" "$dir/actions" 2>&1)" || status=$?
  local ok=1
  if [ "$expect" = pass ]; then [ "$status" -eq 0 ] || ok=0
  else [ "$status" -eq 1 ] && printf '%s' "$out" | grep -Eq "$pattern" || ok=0
  fi
  if [ "$ok" -eq 1 ]; then pass=$((pass + 1)); echo "ok   $label"
  else fails=$((fails + 1)); echo "FAIL $label (exit $status): $out"
  fi
}

case_ pinned pass - a.yml "$HEAD
    steps:
      - uses: actions/checkout@$SHA # v4.4.0
      - uses: gradle/actions/wrapper-validation@8da46b539cd8fe6ab27ca75128919a18d757604c # v6.4.1
  k:
    uses: ./.github/workflows/b.yml"
case_ tag-ref fail 'not pinned' a.yml "$HEAD
    steps:
      - uses: actions/checkout@v4"
case_ sha-no-comment fail 'not pinned' a.yml "$HEAD
    steps:
      - uses: actions/checkout@$SHA"
case_ short-sha fail 'not pinned' a.yml "$HEAD
    steps:
      - uses: actions/checkout@11d5960 # v4.4.0"

case_ no-permissions fail 'top-level' a.yml "name: t
on: push
jobs:
  j:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    steps:
      - run: true"

case_ prt fail 'pull_request_target' a.yml "name: t
on: pull_request_target
permissions: {}
jobs: {}"
case_ prt-in-comment pass - a.yml "name: t
# never pull_request_target here
on: pull_request
permissions: {}
jobs: {}"

case_ inherit fail 'secrets: inherit' a.yml "$HEAD
  k:
    uses: ./.github/workflows/b.yml
    secrets: inherit"

case_ latest-missing fail 'without --latest=false' publish.yml "$HEAD
    steps:
      - run: gh release create \"\$TAG\" --verify-tag --prerelease"
case_ latest-present pass - publish.yml "$HEAD
    steps:
      - run: gh release create \"\$TAG\" --verify-tag --latest=false
      - run: gh release edit \"\$TAG\" --draft=false --latest=false"
case_ latest-binary-train-exempt pass - release.yml "$HEAD
    steps:
      - run: gh release edit \"\$TAG\" --notes x"

case_ deploy-branch-elsewhere fail 'only release-cloud.yml' other.yml "$HEAD
    steps:
      - run: git push origin HEAD:cloud-deploy"
case_ deploy-branch-owner pass - release-cloud.yml "$HEAD
    steps:
      - run: git push origin HEAD:cloud-deploy-rc"
case_ cloud-stable fail 'cloud-stable' release-cloud.yml "$HEAD
    steps:
      - run: git push origin HEAD:cloud-stable"

case_ env-documented pass - a.yml "$HEAD
    environment: android-release
    steps:
      - run: true
  k:
    runs-on: ubuntu-24.04
    environment:
      name: cloud-release
      url: https://example.invalid
    steps:
      - run: true
  e:
    runs-on: ubuntu-24.04
    environment: \${{ inputs.env }}
    steps:
      - run: true"
case_ env-undocumented fail "environment 'ios-release'" a.yml "$HEAD
    environment: ios-release
    steps:
      - run: true"
case_ env-name-undocumented fail "environment 'secret-env'" a.yml "$HEAD
    environment:
      name: secret-env
    steps:
      - run: true"

ACTION_BODY="runs:
  using: composite
  steps:
    - uses: actions/setup-node@v6" case_ composite-unpinned fail 'x/action.yml:4' a.yml "$HEAD
    steps:
      - uses: ./.github/actions/x"
ACTION_BODY="runs:
  using: composite
  steps:
    - uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6.5.0" case_ composite-pinned pass - a.yml "$HEAD
    steps:
      - uses: ./.github/actions/x"

echo "$pass passed, $fails failed"
[ "$fails" -eq 0 ]
