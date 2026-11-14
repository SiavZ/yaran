#!/usr/bin/env bash
# GateSpikeCore test runner: `swift test` that also works with only the Command Line Tools.
#
# With full Xcode selected, plain `swift test` finds Swift Testing on its own. With only the
# Command Line Tools, SwiftPM neither puts Testing.framework on the search path nor adds the
# rpaths for it and lib_TestingInterop.dylib, so this adds them. Extra args go to `swift test`.
#
# - Read-only apart from SwiftPM's own .build directory.
#
# <module-headers:begin>
# Uses:
# GateSpikeCore/test.sh
# External: swift, xcode-select
#
# Used by:
# GateSpikeCore/test.sh
# └── entry point (run by hand or CI: `bash test.sh`)
# <module-headers:end>
set -euo pipefail
cd "$(dirname "$0")"

dev="$(xcode-select -p)"
if [[ "$dev" == */CommandLineTools ]]; then
  fw="$dev/Library/Developer/Frameworks"
  lib="$dev/Library/Developer/usr/lib"
  exec swift test -Xswiftc -F"$fw" -Xlinker -F"$fw" \
    -Xlinker -rpath -Xlinker "$fw" -Xlinker -rpath -Xlinker "$lib" "$@"
fi
exec swift test "$@"
