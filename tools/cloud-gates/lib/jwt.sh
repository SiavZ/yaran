#!/usr/bin/env bash
# JWT inspection without verification, for gates that compare Access tokens.
#
# Gates read claims (`exp`, `iat`, `aud`, `type`) to check session lifetimes and
# to pick inputs (an expired token, a wrong-audience token). Nothing here checks
# a signature: Access and yaran do that, and the gates observe their verdicts.
#
# - Pure functions over a token in a variable; nothing is logged or written.
# - Decoding needs only `base64 --decode` and jq, so it runs on macOS and Linux.
#
# <module-headers:begin>
# Uses: none
# External: none
#
# Used by:
# tools/cloud-gates/lib/jwt.sh
# ├── tools/cloud-gates/g01-cookie-injection.sh
# ├── tools/cloud-gates/g02-cloudflared-origin.sh
# ├── tools/cloud-gates/g03-access-responses.sh
# ├── tools/cloud-gates/g12-session-expiry.sh
# └── tools/cloud-gates/tests/lib_test.sh
# <module-headers:end>

# b64url_decode <segment>: base64url (unpadded) to raw bytes.
b64url_decode() {
  local s="${1//-/+}"
  s="${s//_//}"
  case $((${#s} % 4)) in 2) s="$s==" ;; 3) s="$s=" ;; 1) return 1 ;; esac
  printf '%s' "$s" | base64 --decode 2>/dev/null
}

# jwt_shape_ok <token>: three dot-separated base64url segments, JSON header.
jwt_shape_ok() {
  [[ "$1" =~ ^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$ ]] || return 1
  jwt_header "$1" | jq -e 'type == "object"' >/dev/null 2>&1
}

jwt_header() { b64url_decode "${1%%.*}"; }
jwt_claims() { local rest="${1#*.}"; b64url_decode "${rest%%.*}"; }

# jwt_claim <token> <name>: one claim as text (arrays joined by commas).
jwt_claim() { jwt_claims "$1" | jq -r --arg k "$2" '.[$k] | if type == "array" then join(",") else (. // "") end'; }

# jwt_lifetime <token>: exp - iat in seconds.
jwt_lifetime() { jwt_claims "$1" | jq -r '(.exp // 0) - (.iat // 0)'; }

# jwt_is_expired <token> [now]: true when exp <= now.
jwt_is_expired() { local now="${2:-$(date +%s)}" exp; exp="$(jwt_claim "$1" exp)"; [[ -n "$exp" ]] && ((exp <= now)); }
