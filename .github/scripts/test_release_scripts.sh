#!/usr/bin/env bash
# Offline tests for the release helpers check_apk_cert.sh and publish_deploy_branch.sh.
#
# check_apk_cert.sh runs against a stub apksigner that prints canned --print-certs
# output; publish_deploy_branch.sh runs against a local bare repository standing in
# for origin, so the orphan creation, append-only history and semver refusal are all
# exercised without GitHub.
#
# - No network; everything lives in a temp dir removed on exit.
#
# Usage: .github/scripts/test_release_scripts.sh
#
# <module-headers:begin>
# Uses: none
# External: none
#
# Used by: entry point (workflow-policy.yml: bash .github/scripts/test_release_scripts.sh)
# <module-headers:end>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
pass=0
fails=0
check() { # check <label> <expected exit> <command...>
  local label="$1" want="$2" status=0
  shift 2
  "$@" >"$WORK/out" 2>&1 || status=$?
  if [ "$status" -eq "$want" ]; then pass=$((pass + 1)); echo "ok   $label"
  else fails=$((fails + 1)); echo "FAIL $label (exit $status, wanted $want)"; cat "$WORK/out"
  fi
}

# --- check_apk_cert.sh ---------------------------------------------------------
GOOD=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
OTHER=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
printf '%s\n' "$GOOD" > "$WORK/cert"
printf '<app-signing-cert-sha256>\n' > "$WORK/placeholder"
cat > "$WORK/apksigner" <<'STUB'
#!/usr/bin/env bash
# Prints the signer lines listed in the APK stand-in file ($3).
while IFS= read -r d; do echo "Signer #$((++n)) certificate SHA-256 digest: $d"; done < "$3"
STUB
chmod +x "$WORK/apksigner"
printf '%s\n' "$GOOD" > "$WORK/release.apk"
printf '%s\n' "$OTHER" > "$WORK/debug.apk"
printf '%s\n%s\n' "$GOOD" "$OTHER" > "$WORK/two.apk"
export APKSIGNER="$WORK/apksigner"
check "apk signed by the app key passes" 0 bash "$SCRIPT_DIR/check_apk_cert.sh" "$WORK/release.apk" "$WORK/cert"
check "debug-signed apk fails" 1 bash "$SCRIPT_DIR/check_apk_cert.sh" "$WORK/debug.apk" "$WORK/cert"
check "second signer fails" 1 bash "$SCRIPT_DIR/check_apk_cert.sh" "$WORK/two.apk" "$WORK/cert"
check "placeholder cert file fails" 1 bash "$SCRIPT_DIR/check_apk_cert.sh" "$WORK/release.apk" "$WORK/placeholder"

# --- publish_deploy_branch.sh --------------------------------------------------
git init --quiet --bare "$WORK/origin.git"
git clone --quiet "$WORK/origin.git" "$WORK/src" 2>/dev/null
mkdir -p "$WORK/src/.github" "$WORK/src/tools"
cp -R "$SCRIPT_DIR" "$WORK/src/.github/scripts"
cp -R "$SCRIPT_DIR/../../tools/release-trains" "$WORK/src/tools/release-trains"
rm -rf "$WORK/src/tools/release-trains/node_modules"
git -C "$WORK/src" add -A
git -C "$WORK/src" -c user.name=t -c user.email=t@t commit --quiet -m main
git -C "$WORK/src" push --quiet origin HEAD:main

tree() { # tree <version>
  rm -rf "$WORK/tree"; mkdir -p "$WORK/tree/src"
  printf '{"version":"%s"}\n' "$1" > "$WORK/tree/release.json"
  printf 'export default {};\n' > "$WORK/tree/src/index.ts"
}
publish() { (cd "$WORK/src" && bash .github/scripts/publish_deploy_branch.sh cloud-deploy "$WORK/tree" "$1" deadbeef); }
count() { git -C "$WORK/origin.git" rev-list --count cloud-deploy; }

tree 1.0.0; check "first stable release creates the branch" 0 publish yaran-cloud-v1.0.0
check "the branch is an orphan (no history shared with main)" 1 git -C "$WORK/origin.git" merge-base main cloud-deploy
check "the tree lands under worker/" 0 git -C "$WORK/origin.git" cat-file -e cloud-deploy:worker/src/index.ts
check "re-running the same tag is refused" 1 publish yaran-cloud-v1.0.0
tree 0.9.0; check "an older tag is refused" 1 publish yaran-cloud-v0.9.0
tree 1.1.0-rc.1; check "a tag/manifest mismatch is refused" 1 publish yaran-cloud-v1.1.0
tree 1.1.0; check "a newer tag appends" 0 publish yaran-cloud-v1.1.0
check "history is append-only, one commit per release" 0 test "$(count)" -eq 2
check "the commit message names the tag and source" 0 bash -c "git -C '$WORK/origin.git' log -1 --format=%s cloud-deploy | grep -qx 'yaran-cloud-v1.1.0: generated from deadbeef'"

echo "$pass passed, $fails failed"
[ "$fails" -eq 0 ]
