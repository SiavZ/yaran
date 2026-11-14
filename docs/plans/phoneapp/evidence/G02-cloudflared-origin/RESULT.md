# G02 cloudflared preserves Host, speaks HTTP/1.1 to the origin with WebSockets, and per-rule access.required + audTag rejects a missing or invalid JWT: OPEN

Not run yet. This record is the Phase 03 template with the verdict pending; the gate closes only
when a run fills it in and the decision owner and the maintainer sign it off.

- **Date / operator role / commit of tools/cloud-gates used:** pending
- **Versions:** cloudflared pending; wrangler 4.162.0 (pinned in the scripts); Capacitor 8.6.2 (spike);
  Android API / WebView M-version / browser pending; iOS + Xcode pending; account A org creation date
  (strict mode yes/no) pending
- **Procedure:** `tools/cloud-gates/run.sh G02` plus the device checklist it prints (kept as
  `run-YYYY-MM-DD/checklist.md`)

## Observations

Paste the run's `run-YYYY-MM-DD/observations.md` here. Pass criteria (Phase 03):

| Criterion | Observed | Met? |
|---|---|---|
| Host preserved | pending | pending |
| Origin sees HTTP/1.1 in every configuration (incl. http2Origin) | pending | pending |
| WebSockets work with no extra option | pending | pending |
| Per-rule access: missing JWT 403, wrong aud 403, bad or expired JWT refused (status recorded, expected 502) | pending | pending |
| Tunnel-level-only access does not enforce (recorded either way) | pending | pending |

## Verdict and sign-off

- **Verdict:** OPEN (PASS or FALLBACK ADOPTED with its level, once run)
- **Decision owner:** Phase 05 lead, pending
- **Maintainer sign-off:** pending
- **Affected phases to update in the closing PR:** 05, 10, 11 (none updated yet)

## Re-run triggers

Every cloudflared release (Phase 10 pins it); any change to the ingress originRequest schema.

## What is ready, and what closing it needs

- **Ready to run:** `g02-cloudflared-origin.sh` runs steps 1-9 unattended except the wrong-aud and expired JWT inputs (prompted, or GATE_IDENTITY_JWT_CMD) and step 9. It is part of `run.sh --recheck`.
- **The maintainer must provide:** Staging account A and the gate runner token; cloudflared >= 2026.11.0 on the operator machine; a JWT from another Access app of the team and an expired JWT.
- **Later-phase dependency:** Step 9 needs Phase 11's live host rule (until then preview-env with the hostname in allowed_hosts).
