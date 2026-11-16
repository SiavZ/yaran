# G14 Attaching a Worker custom domain through the API from the setup wizard, and the permission it needs: OPEN

Not run yet. This record is the Phase 03 template with the verdict pending; the gate closes only
when a run fills it in and the decision owner and the maintainer sign it off.

- **Date / operator role / commit of tools/cloud-gates used:** pending
- **Versions:** cloudflared pending; wrangler 4.162.0 (pinned in the scripts); Capacitor 8.6.2 (spike);
  Android API / WebView M-version / browser pending; iOS + Xcode pending; account A org creation date
  (strict mode yes/no) pending
- **Procedure:** `tools/cloud-gates/run.sh G14` plus the device checklist it prints (kept as
  `run-YYYY-MM-DD/checklist.md`)

## Observations

Paste the run's `run-YYYY-MM-DD/observations.md` here. Pass criteria (Phase 03):

| Criterion | Observed | Met? |
|---|---|---|
| Some token from the G9 set attaches the domain from inside the Worker | pending | pending |
| Certificate valid within a recorded time | pending | pending |
| Conflicts refused, not overwritten | pending | pending |
| The Worker can disable its own workers.dev route | pending | pending |
| Step-8 host lock holds on every probe | pending | pending |

## Verdict and sign-off

- **Verdict:** OPEN (PASS or FALLBACK ADOPTED with its level, once run)
- **Decision owner:** Phase 07 lead, pending
- **Maintainer sign-off:** pending
- **Affected phases to update in the closing PR:** 07, 04, 18, 17 (none updated yet)

## Re-run triggers

Any Workers custom-domain or workers.dev changelog entry; wrangler majors (non-TTY custom_domain behaviour).

## What is ready, and what closing it needs

- **Ready to run:** `g14-custom-domain.sh` deploys workers/domain-probe with the shipped settings, attaches from inside the Worker with tokens A and B, times the certificate, tests CNAME/A conflicts, disables workers.dev, measures redeploys, and probes the host lock. Step 6 is part of `run.sh --recheck`.
- **The maintainer must provide:** Staging account A; tokens A and B minted from the printed template links.
- **Later-phase dependency:** The Workers Builds redeploy variant of step 7 needs G11's connected clone.
