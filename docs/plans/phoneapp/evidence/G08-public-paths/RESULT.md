# G08 Public path overrides for /v1/meta and /v1/machine/* on the Worker's Access-protected hostname, and precedence: OPEN

Not run yet. This record is the Phase 03 template with the verdict pending; the gate closes only
when a run fills it in and the decision owner and the maintainer sign it off.

- **Date / operator role / commit of tools/cloud-gates used:** pending
- **Versions:** cloudflared pending; wrangler 4.162.0 (pinned in the scripts); Capacitor 8.6.2 (spike);
  Android API / WebView M-version / browser pending; iOS + Xcode pending; account A org creation date
  (strict mode yes/no) pending
- **Procedure:** `tools/cloud-gates/run.sh G08` plus the device checklist it prints (kept as
  `run-YYYY-MM-DD/checklist.md`)

## Observations

Paste the run's `run-YYYY-MM-DD/observations.md` here. Pass criteria (Phase 03):

| Criterion | Observed | Met? |
|---|---|---|
| Override variant matches the expected statuses exactly | pending | pending |
| No normalisation probe reaches a protected path unauthenticated | pending | pending |
| API round-trips the override config | pending | pending |

## Verdict and sign-off

- **Verdict:** OPEN (PASS or FALLBACK ADOPTED with its level, once run)
- **Decision owner:** Phase 07 lead, pending
- **Maintainer sign-off:** pending
- **Affected phases to update in the closing PR:** 04, 07, 06, 05 (none updated yet)

## Re-run triggers

Any change to the Access application schema (overrides are schema-only); nightly via the recheck.

## What is ready, and what closing it needs

- **Ready to run:** `g08-public-paths.sh` deploys workers/public-path-probe on <cp-host>, creates the app with the two overrides, runs the probe set, tries a pattern without the slash, reads the Access log, then repeats with Option B path apps + Bypass. Fully unattended; part of `run.sh --recheck`.
- **The maintainer must provide:** Staging account A with the gate runner token, and <cp-host> in the staging zone.
- **Later-phase dependency:** Uses G14's API attach for the custom domain; run G14 first.
