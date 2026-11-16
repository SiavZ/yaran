#!/usr/bin/env bash
# shellcheck disable=SC2016
# Gate runner for one Cloudflare proof.
#
# - Never prints secrets.
#
# <module-headers:begin>
# Uses:
# tools/cloud-gates/run.sh
# └── tools/cloud-gates/lib/common.sh
# External: std
#
# Used by: entry point (bash tools/cloud-gates/run.sh G<NN>)
# <module-headers:end>
set -eu
