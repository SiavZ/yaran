# Cloud gates (Phase 03)

Re-runnable proofs of the external platform facts the phone app and the Cloudflare control
plane depend on. Each gate G1–G14 in `docs/plans/phoneapp/03-platform-verification-gates.md`
has one script here; its verdict is recorded in
`docs/plans/phoneapp/evidence/G<NN>-<slug>/RESULT.md` and tracked in
`docs/plans/phoneapp/evidence/TRACKING.md`.

These scripts create and delete real resources on a **staging** Cloudflare account. Never
point them at a production account.

## Layout

| Path | What |
|---|---|
| `run.sh` | `./run.sh G02` runs one gate; `./run.sh --list`; `./run.sh --recheck` runs the unattended HTTP-level halves of G2, G3, G8, G9, G12 and G14 and prints one JSON summary (Phase 19's nightly drift check) |
| `g01-…sh` … `g14-…sh` | one script per gate: the API/HTTP half automated, the device half printed as a checklist with prompts |
| `lib/common.sh` | prerequisites, evidence directory, `record` (redacting tee), `check`/`observe`/`skip`, prompts, cleanup stack, HTTP probe |
| `lib/cf.sh` | Cloudflare API client: auth header off argv, error envelope, permission-group lookup, token template URL |
| `lib/jwt.sh` | JWT header/claims decoding without verification |
| `lib/redact.sh` | the one list of secret patterns; every recorded line passes through it |
| `lib/access.sh` | tagged create/delete helpers (Access apps, reusable policies, tunnels, DNS, Worker domains, service tokens), the machine fixture, and `sweep` |
| `origin/` | echo origin (HTTP + WebSocket, `/g6` and `/expiry` test pages), `ws-probe.mjs`, `webpush-send.mjs` |
| `workers/` | probe Workers: `apns-probe` (G4), `public-path-probe` (G8), `domain-probe` (G14), `deploy-probe` (G11), `callback-probe` (G13) |
| `spikes/mobile/` | Capacitor 8.6.2 spike app (flavors `foss`/`play`) with MachineViewSpike, AuthSpike, PushSpike and the G13 hijack module |
| `tests/` | offline tests for the libraries and the redaction filter |

## Prerequisites

The maintainer provides the accounts and devices listed in the phase's Prerequisites table:
staging account A (Zero Trust created after 2026-10-05, Workers Paid, one zone), optionally
account B (older org, G3) and scratch account C (no org, G10), an account-owned gate runner
token with the G9 permission set, an Apple developer account (G4, G13), the devices (G1, G3,
G5, G6, G13), and a test identity.

Tools: bash (3.2 or newer), curl, jq, perl, Node 22+, cloudflared ≥ 2026.11.0, git; Docker and
Android build-tools 34 for G7; adb optionally for G5.

```bash
cd tools/cloud-gates
(cd origin && npm ci)
for w in workers/*/; do (cd "$w" && npm ci); done
cp env.example .env.local      # gitignored; fill in non-secret values
set -a; . ./.env.local; set +a
./run.sh G09                   # week 1 starts with the token, then G10, G14, G11, G2, G8
```

Every script stops at once, naming every missing setting, before it creates anything.
Interactive gates refuse to run without a terminal.

## Secrets and evidence rules

- Secrets come only from the environment or a hidden prompt, never from argv. curl reads
  credentials from owner-only header files or a config on a file descriptor; wrangler gets the
  token as `CLOUDFLARE_API_TOKEN` in its environment; cloudflared gets `TUNNEL_TOKEN` the same way.
- Every recorded line goes through `lib/redact.sh`: JWTs become `<jwt aud=… exp=… iat=… iss=… type=…>`
  (the email claim becomes `<owner>`), and API tokens, `oauth:` tokens, tunnel tokens, device
  tokens, VAPID private keys, PEM keys, push endpoints and email addresses are masked. Hashes
  are printed as `sha256:<hex>` and survive.
- Evidence lands in `docs/plans/phoneapp/evidence/G<NN>-<slug>/run-YYYY-MM-DD/`: `log.txt`,
  per-step files, `checklist.md`, `observations.tsv`/`.md` and `summary.json`. Commit it with
  the RESULT.md update; `docs/plans/phoneapp/evidence/check-evidence.sh` must pass first.
  Screenshots and HAR excerpts are scrubbed by hand (pipe text through `lib/redact.sh`).
- Resources are named `gate-<gate>-<run-id>` (DNS records carry it as their comment; Workers
  are `yaran-gate-*`) and deleted by each script's exit trap, in the reverse of D21's order.
  `./lib/access.sh sweep [--dry-run] [--max-age-hours N]` removes what a dead run left.

## Exit codes and the recheck

A gate exits 0 when every criterion it checked was met, 1 when one was not, and 2 when a
prerequisite or the infrastructure failed. Its last stdout line is `summary: {…}` with the
counts. `./run.sh --recheck` sets `GATES_RECHECK=1` (operator steps are recorded as skipped),
collects those lines and prints `{recheck, started, finished, gates, ok}`; it exits 0 only if
every gate did. JWT-dependent recheck steps need `GATE_IDENTITY_JWT_CMD` (Phase 19).

## Mobile spike

```bash
cd tools/cloud-gates/spikes/mobile
npm ci && npm run build && npx cap sync      # the web assets in the native projects are placeholders until then
(cd android && ./gradlew assemblePlayDebug assembleFossDebug :hijack:assembleDebug -PgateCallbackHost=<gate-callback-host>)
(cd android && ./gradlew testFossDebugUnitTest testPlayDebugUnitTest)
(cd ios/GateSpikeCore && bash test.sh)       # pure Swift logic; the App needs Xcode 26
# with Xcode: xcodebuild test -project ios/App/App.xcodeproj -scheme GateSpike -destination 'platform=iOS Simulator,name=iPhone 16'
```

Debug screens take JWTs, tokens and keys only through paste fields; nothing travels in a deep
link or an Intent, and no bridge method hands a cookie back to JavaScript.

## Tests

```bash
bash tests/redact_test.sh && bash tests/lib_test.sh
(cd origin && node --test)
for w in workers/*/; do (cd "$w" && npx tsc --noEmit && npx vitest run); done
bash ../../docs/plans/phoneapp/evidence/check-evidence.sh
```
