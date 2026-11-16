# G12 Access session_duration versus JWT exp, and an open WebSocket after expiry: OPEN

Not run yet. This record is the Phase 03 template with the verdict pending; the gate closes only
when a run fills it in and the decision owner and the maintainer sign it off.

- **Date / operator role / commit of tools/cloud-gates used:** pending
- **Versions:** cloudflared pending; wrangler 4.162.0 (pinned in the scripts); Capacitor 8.6.2 (spike);
  Android API / WebView M-version / browser pending; iOS + Xcode pending; account A org creation date
  (strict mode yes/no) pending
- **Procedure:** `tools/cloud-gates/run.sh G12` plus the device checklist it prints (kept as
  `run-YYYY-MM-DD/checklist.md`)

## Observations

Paste the run's `run-YYYY-MM-DD/observations.md` here. Pass criteria (Phase 03):

| Criterion | Observed | Met? |
|---|---|---|
| exp - iat matches the effective session duration | pending | pending |
| Open-socket behaviour observed and recorded | pending | pending |
| Revoked tokens refused within 60 s on new requests and new upgrades | pending | pending |

## Verdict and sign-off

- **Verdict:** OPEN (PASS or FALLBACK ADOPTED with its level, once run)
- **Decision owner:** Phase 15 lead, pending
- **Maintainer sign-off:** pending
- **Affected phases to update in the closing PR:** 15, 11, 07, 13 (none updated yet)

## Re-run triggers

Any Access session-management changelog entry; Cloudflare network WebSocket behaviour changes.

## What is ready, and what closing it needs

- **Ready to run:** `g12-session-expiry.sh` sets app 5m / policy 3m, checks exp - iat, holds a cookie WebSocket past exp, probes after exp, and replays after logout, revoke_tokens and revoke_user. Steps 1 and 3-6 run under `run.sh --recheck` when GATE_IDENTITY_JWT_CMD is set.
- **The maintainer must provide:** Staging account A, the test identity (several fresh sign-ins), and the devices for the yaran-socket half.
- **Later-phase dependency:** The yaran-socket half needs yaran behind the tunnel and the G1 credential (Phase 11 live host rule).
