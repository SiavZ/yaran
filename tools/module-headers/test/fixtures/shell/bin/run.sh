#!/usr/bin/env bash
# Runner for the shell fixture.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"
. "$(dirname "$0")/local.sh"
source "$PLUGIN_DIR/plugin.sh"
source /etc/os-release
