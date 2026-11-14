#!/usr/bin/env bash
# G07 — A reproducible `fdroid build` of the spike's foss flavor.
#
# Builds the `spikes/mobile` foss release APK twice, each in a clean
# fdroidserver buildserver container from a fresh `git archive` of HEAD, with
# Node pinned and `npm ci` from the lockfile, compares the two (SHA-256, then
# diffoscope when they differ), signs one copy with apksigner from build-tools
# 34, and writes the two draft fdroiddata recipes: variant A (npm in the
# recipe, `scandelete: node_modules`) and variant B (MapComplete style: a tag
# tree with the built shell bundle and vendored @capacitor/android). With a
# local fdroiddata checkout it then runs `fdroid readmeta`, `lint`, `build` and
# `publish` against the Binaries URL, and `apksigcopier compare`.
#
# - The keystore password reaches apksigner as `env:` only, never argv.
# - The recipes need a commit of this repo that is pushed to GitHub
#   (GATE_G07_COMMIT); F-Droid builds from the public repository.
#
# <module-headers:begin>
# Uses:
# tools/cloud-gates/g07-fdroid.sh
# └── tools/cloud-gates/lib/common.sh
# External: docker, git, apksigner (build-tools 34)
#
# Used by:
# tools/cloud-gates/g07-fdroid.sh
# └── entry point (tools/cloud-gates/run.sh G07)
# <module-headers:end>
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=tools/cloud-gates/lib/common.sh
. "$(dirname "$0")/lib/common.sh"

gate_init G07 fdroid
is_recheck && die "G07 is not part of --recheck"
require_tty
require_cmd docker git
require_env GATE_ANDROID_KEYSTORE GATE_ANDROID_KEY_ALIAS
IMAGE="${GATE_FDROID_IMAGE:-registry.gitlab.com/fdroid/fdroidserver:buildserver}"
NODE_V="${GATE_NODE_VERSION:-22.22.3}"
APKSIGNER="${GATE_APKSIGNER:-${ANDROID_HOME:-$HOME/Library/Android/sdk}/build-tools/34.0.0/apksigner}"
PKG="${GATE_SPIKE_PACKAGE:-io.github.siavz.yaran.gatespike}"
SUB="tools/cloud-gates/spikes/mobile"
APK_REL="android/app/build/outputs/apk/foss/release/app-foss-release-unsigned.apk"
[[ -x "$APKSIGNER" ]] || die "apksigner from build-tools 34 not found (set GATE_APKSIGNER)"
read_secret GATE_ANDROID_KEYSTORE_PASS "keystore password" || die "keystore password required"
export GATE_ANDROID_KEYSTORE_PASS
BUILD_CMD="${GATE_G07_BUILD_CMD:-set -e
curl -fsSL https://nodejs.org/dist/v$NODE_V/node-v$NODE_V-linux-x64.tar.xz | tar xJ -C /opt
export PATH=/opt/node-v$NODE_V-linux-x64/bin:\$PATH
cd /src/$SUB && npm ci && npm run build && npx cap sync android
cd android && ./gradlew --no-daemon assembleFossRelease}"

step "1: two clean builds"
for n in 1 2; do
  mkdir -p "$RUN_TMP/b$n" && git -C "$REPO_ROOT" archive HEAD | tar x -C "$RUN_TMP/b$n"
  docker run --rm -v "$RUN_TMP/b$n:/src" -e SOURCE_DATE_EPOCH="$(git -C "$REPO_ROOT" log -1 --format=%ct)" \
    "$IMAGE" bash -c "$BUILD_CMD" 2>&1 | record "build-$n" || die "build $n failed (see build-$n.txt)"
  [[ -f "$RUN_TMP/b$n/$SUB/$APK_REL" ]] || die "build $n produced no $APK_REL"
done
h1="$(sha256_hex <"$RUN_TMP/b1/$SUB/$APK_REL")"; h2="$(sha256_hex <"$RUN_TMP/b2/$SUB/$APK_REL")"
observe "build hashes" "sha256:$h1 sha256:$h2"
check "two clean builds are byte-identical" "sha256:$h1" "sha256:$h2"
if [[ "$h1" != "$h2" ]]; then
  cp "$RUN_TMP/b1/$SUB/$APK_REL" "$RUN_TMP/a.apk"; cp "$RUN_TMP/b2/$SUB/$APK_REL" "$RUN_TMP/b.apk"
  docker run --rm -v "$RUN_TMP:/w" registry.salsa.debian.org/reproducible-builds/diffoscope /w/a.apk /w/b.apk 2>&1 | head -400 | record diffoscope || true
fi

step "2: sign one copy with apksigner (build-tools 34)"
"$APKSIGNER" sign --ks "$GATE_ANDROID_KEYSTORE" --ks-key-alias "$GATE_ANDROID_KEY_ALIAS" --ks-pass env:GATE_ANDROID_KEYSTORE_PASS \
  --out "$RUN_TMP/signed.apk" "$RUN_TMP/b1/$SUB/$APK_REL" 2>&1 | record sign
CERT="$("$APKSIGNER" verify --print-certs "$RUN_TMP/signed.apk" | grep -m1 'SHA-256 digest' | awk '{print $NF}')"
observe "signing certificate SHA-256 (AllowedAPKSigningKeys)" "sha256:$CERT"
OUT="${GATE_G07_OUT_DIR:-$HOME}"
cp "$RUN_TMP/signed.apk" "$OUT/$PKG-gate-foss-release.apk"
log "signed APK copied to $OUT (outside the repo); upload it to the Binaries URL before fdroid publish"

step "3: draft fdroiddata recipes"
COMMIT="${GATE_G07_COMMIT:-$(git -C "$REPO_ROOT" rev-parse HEAD)}"
BIN="${GATE_FDROID_BINARIES_URL:-https://github.com/SiavZ/yaran/releases/download/gate-fdroid-%v/app-foss-release.apk}"
common_head() {
  cat <<EOF
Categories:
  - Development
License: MIT
SourceCode: https://github.com/SiavZ/yaran
IssueTracker: https://github.com/SiavZ/yaran/issues
AutoName: yaran gate spike
RepoType: git
Repo: https://github.com/SiavZ/yaran.git
Binaries: $BIN
Builds:
  - versionName: 0.0.1
    versionCode: 1
    commit: $COMMIT
    subdir: $SUB/android/app
EOF
}
{ common_head; cat <<EOF
    sudo:
      - apt-get update
      - apt-get install -y npm
    init: cd ../.. && npm ci
    gradle:
      - foss
    prebuild: cd ../.. && npm run build && npx cap sync android
    scandelete:
      - $SUB/node_modules
AllowedAPKSigningKeys: $CERT
AutoUpdateMode: None
UpdateCheckMode: None
EOF
} >"$EVIDENCE_DIR/metadata-variant-A.yml"
{ common_head; cat <<EOF
    gradle:
      - foss
AllowedAPKSigningKeys: $CERT
AutoUpdateMode: None
UpdateCheckMode: None
EOF
} >"$EVIDENCE_DIR/metadata-variant-B.yml"
observe "variant B tree" "commit must name a tag tree holding $SUB/dist (built) and vendored @capacitor/android; Phase 18 produces it"

step "4: fdroid readmeta / lint / build / publish"
if [[ -n "${GATE_FDROIDDATA_DIR:-}" ]]; then
  pause "upload $OUT/$PKG-gate-foss-release.apk so that $BIN serves it"
  for v in A B; do
    cp "$EVIDENCE_DIR/metadata-variant-$v.yml" "$GATE_FDROIDDATA_DIR/metadata/$PKG.yml"
    docker run --rm -v "$GATE_FDROIDDATA_DIR:/repo" -w /repo "$IMAGE" bash -c \
      "fdroid readmeta && fdroid lint $PKG && fdroid build -v -l $PKG && fdroid publish -v $PKG" 2>&1 | record "fdroid-$v" && rc=0 || rc=$?
    check "variant $v: readmeta, lint, build and publish succeed" 0 "$rc"
    built="$(find "$GATE_FDROIDDATA_DIR/unsigned" -name "${PKG}_*.apk" 2>/dev/null | head -1 || true)"
    if [[ -n "$built" ]] && command -v apksigcopier >/dev/null; then
      apksigcopier compare "$RUN_TMP/signed.apk" --unsigned "$built" 2>&1 | record "apksigcopier-$v" && c=0 || c=$?
      check "variant $v: apksigcopier compare matches" 0 "$c"
    else skip "variant $v: apksigcopier compare" "no fdroid-built APK or apksigcopier missing"; fi
  done
  confirm_check "F-Droid scanner raised no non-free dependency in foss (fdroid-A.txt)" "scanner clean of non-free deps?"
else
  skip "fdroid readmeta/lint/build/publish" "GATE_FDROIDDATA_DIR unset (point it at a local fdroiddata checkout)"
fi
