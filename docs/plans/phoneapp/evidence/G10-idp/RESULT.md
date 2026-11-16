# G10 IdP detection and One-time PIN creation through the API in a fresh org: OPEN

Not run yet. This record is the Phase 03 template with the verdict pending; the gate closes only
when a run fills it in and the decision owner and the maintainer sign it off.

- **Date / operator role / commit of tools/cloud-gates used:** pending
- **Versions:** cloudflared pending; wrangler 4.162.0 (pinned in the scripts); Capacitor 8.6.2 (spike);
  Android API / WebView M-version / browser pending; iOS + Xcode pending; account A org creation date
  (strict mode yes/no) pending
- **Procedure:** `tools/cloud-gates/run.sh G10` plus the device checklist it prints (kept as
  `run-YYYY-MM-DD/checklist.md`)

## Observations

Paste the run's `run-YYYY-MM-DD/observations.md` here. Pass criteria (Phase 03):

| Criterion | Observed | Met? |
|---|---|---|
| Step 1 detects the Cloudflare-only IdP state | pending | pending |
| Step 2 creates OTP and a non-member signs in through it | pending | pending |
| Step 3 outcome recorded (decides the no-org branch) | pending | pending |

## Verdict and sign-off

- **Verdict:** OPEN (PASS or FALLBACK ADOPTED with its level, once run)
- **Decision owner:** Phase 07 lead, pending
- **Maintainer sign-off:** pending
- **Affected phases to update in the closing PR:** 07 (none updated yet)

## Re-run triggers

Any Access identity-provider or onboarding changelog entry.

## What is ready, and what closing it needs

- **Ready to run:** `g10-idp.sh` reads the org and IdPs, creates OTP by API, wires it into a test app for a non-member, records account C's organization answers and the missing-permission errors.
- **The maintainer must provide:** Staging account A (org after 2026-06-18 so the Cloudflare IdP is the default); scratch account C with no Zero Trust org and its token; a non-member mailbox.
- **Later-phase dependency:** None.
