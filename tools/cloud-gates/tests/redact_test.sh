#!/usr/bin/env bash
# Redaction tests: one of every secret shape is planted and none may survive.
#
# Builds its inputs at run time (synthetic JWTs, tokens, keys) so no secret-
# shaped string is committed, runs them through `lib/redact.sh`, and asserts
# that every planted value is gone, that labelled hashes, git SHAs, Access AUD
# tags and example.invalid addresses survive, and that redaction is idempotent.
# It also builds a throwaway evidence tree with one planted JWT and asserts
# `check-evidence.sh` fails on it and passes on the redacted copy.
#
# - Offline; writes only under a mktemp directory it removes.
#
# <module-headers:begin>
# Uses:
# tools/cloud-gates/tests/redact_test.sh
# └── tools/cloud-gates/lib/redact.sh
# External: base64, perl
#
# Used by:
# tools/cloud-gates/tests/redact_test.sh
# └── entry point (bash tools/cloud-gates/tests/redact_test.sh; Phase 03 Validation)
# <module-headers:end>
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=tools/cloud-gates/lib/redact.sh
. "$(dirname "$0")/../lib/redact.sh"
CHECK="$HERE/../../../docs/plans/phoneapp/evidence/check-evidence.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }

b64u() { base64 | tr '+/' '-_' | tr -d '=\n'; }
rnd() { head -c 8192 /dev/urandom | LC_ALL=C tr -dc "$1" | head -c "$2"; } # bounded input: no SIGPIPE under pipefail

aud="$(rnd 'a-f0-9' 64)"
jwt="$(printf '{"alg":"RS256","kid":"k1"}' | b64u).$(printf '{"aud":["%s"],"email":"owner@corp.test","exp":1900000000,"iat":1899999820,"iss":"https://team.cloudflareaccess.com","type":"app","sub":"u1"}' "$aud" | b64u).$(rnd 'A-Za-z0-9_-' 86)"
jwe="eyJhbGciOiJFQ0RILUVTIn0..$(rnd 'A-Za-z0-9_-' 16).$(rnd 'A-Za-z0-9_-' 40).$(rnd 'A-Za-z0-9_-' 22)"
jwe2="eyJhbGciOiJFQ0RILUVTIn0.$(rnd 'A-Za-z0-9_-' 12).$(rnd 'A-Za-z0-9_-' 16).$(rnd 'A-Za-z0-9_-' 40).$(rnd 'A-Za-z0-9_-' 22)"
oauth="oauth:$(rnd 'A-Za-z0-9' 48)"
cfat="cfat_$(rnd 'A-Za-z0-9' 40)"
legacy="$(rnd 'A-Za-z0-9' 39)Z"
tunnel="$(printf '{"a":"%s","t":"%s","s":"%s"}' "$(rnd 'a-f0-9' 32)" "$(rnd 'a-f0-9' 32)" "$(rnd 'A-Za-z0-9' 44)" | base64 | tr -d '\n')"
apns="$(rnd 'a-f0-9' 64)"
fcm="$(rnd 'A-Za-z0-9_-' 22):APA91b$(rnd 'A-Za-z0-9_-' 120)"
vapid="$(rnd 'A-Za-z0-9_-' 43)"
p256="B$(rnd 'A-Za-z0-9_-' 86)"
authsec="$(rnd 'A-Za-z0-9_-' 22)"
svc="$(rnd 'a-f0-9' 64)"
pemline="$(rnd 'A-Za-z0-9+/' 64)"
endpoint_id="$(rnd 'A-Za-z0-9_-' 40)"

cat >"$TMP/in.txt" <<EOF
Cf-Access-Jwt-Assertion: $jwt
Cookie: CF_Authorization=$jwt; CF_Session=$(rnd 'a-z0-9' 30)
cf-access-token: $jwt
Location: https://app.example.invalid/auth/callback?state=s&jwe=$jwe
fragment jwe=$jwe2
Authorization: Bearer $oauth
token=$oauth
Authorization: Bearer $cfat
api token $legacy here
TUNNEL_TOKEN=$tunnel
{"result":"$tunnel"}
apns device $apns
{"device_token":"$apns","fcm_token":"$fcm"}
raw fcm $fcm
Private Key:
$vapid
{"publicKey":"B$(rnd A-Za-z0-9_- 86)","privateKey":"$vapid"}
WP_VAPID_PRIVATE=$vapid
{"endpoint":"https://fcm.googleapis.com/fcm/send/$endpoint_id","keys":{"p256dh":"$p256","auth":"$authsec"}}
endpoint https://fcm.googleapis.com/fcm/send/$endpoint_id
CF-Access-Client-Secret: $svc
-----BEGIN PRIVATE KEY-----
$pemline
-----END PRIVATE KEY-----
{"value":"$cfat"}
GATE_CF_API_TOKEN=$legacy
owner owner@corp.test
EOF

redact <"$TMP/in.txt" >"$TMP/out.txt"
for name in jwt jwe jwe2 oauth cfat legacy tunnel apns fcm vapid p256 authsec svc pemline endpoint_id; do
  if grep -qF -- "${!name}" "$TMP/out.txt"; then bad "planted $name survived"; else ok "planted $name masked"; fi
done
grep -qF 'owner@corp.test' "$TMP/out.txt" && bad "email survived" || ok "email masked"
grep -q "<jwt aud=$aud exp=1900000000 iat=1899999820 iss=https://team.cloudflareaccess.com type=app email=<owner>>" "$TMP/out.txt" &&
  ok "jwt summary keeps non-secret claims" || bad "jwt summary shape"
grep -q 'sub=' "$TMP/out.txt" && bad "jwt summary leaked sub" || ok "jwt summary drops sub"

keep_hash="sha256:$(rnd 'a-f0-9' 64)"
keep_sha="0123456789abcdef0123456789abcdef01234567"
printf '%s\ncommit %s\nmailto:gate@example.invalid\n"aud":"%s"\n' "$keep_hash" "$keep_sha" "$aud" >"$TMP/keep.txt"
if diff -q "$TMP/keep.txt" <(redact <"$TMP/keep.txt") >/dev/null; then ok "hashes, git SHAs, AUD and example.invalid survive"
else bad "non-secrets were altered: $(redact <"$TMP/keep.txt" | tr '\n' ' ')"; fi

if diff -q "$TMP/out.txt" <(redact <"$TMP/out.txt") >/dev/null; then ok "idempotent"; else bad "not idempotent"; fi

mkdir -p "$TMP/evidence/G01-x/run-2026-01-01"
printf 'clean line\n' >"$TMP/evidence/G01-x/RESULT.md"
cp "$TMP/out.txt" "$TMP/evidence/G01-x/run-2026-01-01/log.txt"
if bash "$CHECK" "$TMP/evidence" >/dev/null 2>&1; then ok "check-evidence passes a redacted tree"; else bad "check-evidence rejected a redacted tree"; fi
printf 'Cf-Access-Jwt-Assertion: %s\n' "$jwt" >"$TMP/evidence/G01-x/run-2026-01-01/leak.txt"
if bash "$CHECK" "$TMP/evidence" >"$TMP/check.out" 2>&1; then bad "check-evidence missed a planted JWT"; else ok "check-evidence fails on a planted JWT"; fi
grep -qF -- "$jwt" "$TMP/check.out" && bad "check-evidence echoed the secret" || ok "check-evidence does not echo the secret"

((fails == 0)) && printf 'redact_test: all passed\n' || { printf 'redact_test: %d failed\n' "$fails"; exit 1; }
