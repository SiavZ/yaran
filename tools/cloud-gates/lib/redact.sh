#!/usr/bin/env bash
# Redaction filter for gate evidence: masks every secret shape a gate can print.
#
# Every line a gate script records passes through `redact` (stdin to stdout)
# before it reaches the terminal or `docs/plans/phoneapp/evidence/`. The same
# filter is the single home of the secret patterns: `check-evidence.sh` runs
# committed evidence through it and fails when anything would change, so a
# pattern added here is enforced in CI with no second list to keep in step.
#
# - JWTs become `<jwt aud=… exp=… iat=… iss=… type=…>`; the email claim is
#   never kept, and JWEs (five segments) become `<jwe>`.
# - Masks `oauth:` bearer tokens, Bearer/Authorization values, Cloudflare API
#   tokens (cfat_/cfut_ and 40-char legacy tokens), tunnel tokens (base64 JSON
#   with `a`/`t`/`s` keys), APNs/FCM device tokens, PEM private keys, VAPID
#   private keys, Web Push subscription secrets, service-token secrets,
#   CF_* cookie values and secret-named env assignments.
# - Hashes printed as `sha256:<hex>` survive; any other run of 64+ hex digits
#   is treated as a device token and masked. 40-hex git SHAs survive.
# - Emails become `<email>`, except the reserved `example.invalid` domain.
# - Idempotent: redacting redacted text changes nothing (check-evidence relies
#   on this). Needs only perl with core modules (JSON::PP, MIME::Base64).
#
# Run directly as a filter: `some-command | tools/cloud-gates/lib/redact.sh`.
#
# <module-headers:begin>
# Uses: none
# External: none
#
# Used by:
# tools/cloud-gates/lib/redact.sh
# ├── docs/plans/phoneapp/evidence/check-evidence.sh
# ├── tools/cloud-gates/lib/common.sh
# └── tools/cloud-gates/tests/redact_test.sh
# <module-headers:end>

# The perl program is kept in a variable so the filter is one process per
# stream, not one per line.
_REDACT_PL='
use strict; use warnings;
use MIME::Base64 qw(decode_base64);
use JSON::PP ();
my $in_pem = 0; my $next_is_key = 0;
sub b64url { my $s = shift; $s =~ tr{-_}{+/}; $s .= "=" x ((4 - length($s) % 4) % 4); return decode_base64($s); }
sub jwt_summary {
  my ($tok) = @_;
  my @p = split /\./, $tok;
  return "<jwe>" if @p == 5;
  my $c = eval { JSON::PP->new->decode(b64url($p[1])) };
  return "<jwt>" unless ref $c eq "HASH";
  my @kv;
  for my $k (qw(aud exp iat iss type)) {
    next unless exists $c->{$k};
    my $v = ref $c->{$k} eq "ARRAY" ? join(",", @{$c->{$k}}) : $c->{$k};
    $v =~ s/[^A-Za-z0-9._:\/,-]//g;
    push @kv, "$k=$v";
  }
  push @kv, "email=<owner>" if exists $c->{email};
  return "<jwt" . (@kv ? " " . join(" ", @kv) : "") . ">";
}
while (my $line = <STDIN>) {
  if ($in_pem) { $in_pem = 0 if $line =~ /-----END [A-Z ]*PRIVATE KEY-----/; next; }
  if ($line =~ /-----BEGIN [A-Z ]*PRIVATE KEY-----/) {
    print "<private-key redacted>\n";
    $in_pem = 1 unless $line =~ /-----END [A-Z ]*PRIVATE KEY-----/;
    next;
  }
  if ($next_is_key) { $next_is_key = 0; if ($line =~ /^\s*[A-Za-z0-9_-]{40,}\s*$/) { print "<vapid-private-key>\n"; next; } }
  $next_is_key = 1 if $line =~ /Private Key:\s*$/i;
  # JWT / JWE first: later rules must not chew on their segments.
  $line =~ s{\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)?}{jwt_summary($&)}ge;
  $line =~ s{\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+}{<jwe>}g;
  # Tunnel tokens: base64 JSON starting {"a":" (eyJhIjoi).
  $line =~ s{\beyJhIjoi[A-Za-z0-9+/=_-]{16,}}{<tunnel-token>}g;
  $line =~ s{\boauth:(?!<)[A-Za-z0-9._~+/=-]{6,}}{oauth:<redacted>}g;
  $line =~ s{\b(Bearer|bearer)\s+(?!<)[^\s",;]+}{$1 <redacted>}g;
  $line =~ s{\b(cfat|cfut|cfk)_[A-Za-z0-9_-]{10,}}{<cf-api-token>}g;
  # Legacy 40-char API tokens: random base64url, so never all-hex like a git SHA.
  $line =~ s{(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]{40}(?![A-Za-z0-9_-]))(?![0-9a-fA-F]{40})[A-Za-z0-9_-]{40}}{<cf-api-token>}g;
  # Header-style secrets.
  $line =~ s{\b(cf-access-client-secret|x-auth-key|x-probe-key)(["\x27]?\s*[:=]\s*["\x27]?)(?!<)[^\s",;\x27]+}{$1$2<redacted>}gi;
  # Secret-named JSON fields and form fields.
  $line =~ s{("(?:token|tunnel_secret|secret|client_secret|private_key|privateKey|vapid_private|p256dh|auth|value|jwt|cookie|device_token|fcm_token|endpoint)"\s*:\s*")(?!<)[^"]+(")}{$1<redacted>$2}g;
  # CLI flags carrying secrets.
  $line =~ s{(--(?:vapid-pvtkey|key|auth|endpoint|token)[= ])(?!<)\S+}{$1<redacted>}g;
  # Secret-named env assignments (FOO_TOKEN=..., WP_AUTH=..., DATA_KEY=...).
  $line =~ s{\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|_KEY|_P8|_AUTH|P256DH|ENDPOINT|SETUP_CODE|PRIVATE))=(?!<)("[^"]*"|\S+)}{$1=<redacted>}g;
  # Cookie values other than an already-summarised JWT.
  $line =~ s{\b(CF_[A-Za-z_]+|cf_clearance)=(?!<)[^;\s"]+}{$1=<redacted>}g;
  # Push endpoints carry a capability in their path.
  $line =~ s{(https://[A-Za-z0-9.-]+)/(fcm/send|wpush|wp|push|up|v1/push)/(?!<)[A-Za-z0-9._:~%/-]+}{$1/$2/<redacted>}g;
  $line =~ s{\b[A-Za-z0-9_-]{8,}:APA91b[A-Za-z0-9_-]{20,}}{<fcm-token>}g;
  # Long hex = device token, unless labelled as a hash or an Access AUD tag
  # (the AUD is public: every JWT for the app carries it).
  $line =~ s{(?<!sha256:)(?<!aud=)(?<!"aud":")(?<!"aud": ")(?<!audTag":\[")(?<!audTag": \[")(?<![0-9A-Fa-f])[0-9A-Fa-f]{64,200}(?![0-9A-Fa-f])}{<hex-token>}g;
  # Emails, except the reserved test domain.
  $line =~ s{\b[A-Za-z0-9._%+-]+@(?!example\.invalid\b)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b}{<email>}g;
  print $line;
}
'

# redact: stdin to stdout with every secret masked.
redact() {
  perl -e "$_REDACT_PL"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  redact
fi
