#!/usr/bin/env bash
# Regression for the test-only `-PpublisherDomainOverride`: release packaging must refuse it.
#
# Asks Gradle to plan (`--dry-run`) release and debug builds with the override set: every
# release route (an APK, a bundle, the plain `assemble` that packages both) must fail with the
# guard's message, and the debug build plus the unit gate that reads the enabled App Link
# manifest must still plan. Uses `app.example.com`, a reserved test name, and never reads or
# writes mobile/publisher.properties. Needs ANDROID_HOME and a JDK 21 JAVA_HOME.
#
# <module-headers:begin>
# Uses: none
# External: none
#
# Used by: entry point (run by hand or CI: `bash mobile/scripts/check-publisher-override-guard.sh` (release refuses -PpublisherDomainOverride))
# <module-headers:end>
set -euo pipefail
cd "$(dirname "$0")/../android"
args=(-q -PappIdOverride=io.github.siavz.yaran.connectivitytest -PpublisherDomainOverride=app.example.com --dry-run)
fail=0
for task in :app:assembleFossRelease :app:bundlePlayRelease :app:assemble; do
  if out="$(./gradlew "${args[@]}" "$task" 2>&1)"; then
    echo "FAIL: $task planned a release with the override"; fail=1
  elif ! grep -q "refused for release artifacts" <<<"$out"; then
    echo "FAIL: $task failed for another reason:"; echo "$out" | tail -5; fail=1
  else
    echo "ok: $task refused"
  fi
done
for task in :app:assembleFossDebug :app:testFossDebugUnitTest; do
  if ./gradlew "${args[@]}" "$task" >/dev/null 2>&1; then echo "ok: $task allowed"; else echo "FAIL: $task refused"; fail=1; fi
done
exit "$fail"
