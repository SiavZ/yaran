# G04 A deployed Worker sends to APNs over HTTP/2: OPEN

Not run yet. This record is the Phase 03 template with the verdict pending; the gate closes only
when a run fills it in and the decision owner and the maintainer sign it off.

- **Date / operator role / commit of tools/cloud-gates used:** pending
- **Versions:** cloudflared pending; wrangler 4.162.0 (pinned in the scripts); Capacitor 8.6.2 (spike);
  Android API / WebView M-version / browser pending; iOS + Xcode pending; account A org creation date
  (strict mode yes/no) pending
- **Procedure:** `tools/cloud-gates/run.sh G04` plus the device checklist it prints (kept as
  `run-YYYY-MM-DD/checklist.md`)

## Observations

Paste the run's `run-YYYY-MM-DD/observations.md` here. Pass criteria (Phase 03):

| Criterion | Observed | Met? |
|---|---|---|
| Deployed Worker gets 200 with an apns-id; notification shows on simulator and device | pending | pending |
| Garbage token gets 400 BadDeviceToken | pending | pending |
| 50 sequential sends with no connection errors | pending | pending |
| wrangler dev (local and --remote) behaviour recorded | pending | pending |

## Verdict and sign-off

- **Verdict:** OPEN (PASS or FALLBACK ADOPTED with its level, once run)
- **Decision owner:** Phase 08 lead, pending
- **Maintainer sign-off:** pending
- **Affected phases to update in the closing PR:** 08, 16, 21 (none updated yet)

## Re-run triggers

workerd issue #4841 moving; any Workers outbound change; APNs protocol notices.

## What is ready, and what closing it needs

- **Ready to run:** `g04-apns.sh` deploys workers/apns-probe (secrets via --secrets-file, probe key header), sends to the simulator and iPhone tokens, the garbage token and a 50-send burst, and records wrangler dev local/remote. The probe's ES256 signer is unit-tested.
- **The maintainer must provide:** Apple developer account: APNs auth key (.p8), key id, team id, a test bundle id with Push; staging account A (Workers Paid); an Apple-silicon Mac with Xcode 26 to build and run the iOS spike (PushSpike shows the token); a physical iPhone.
- **Later-phase dependency:** None beyond the spike iOS build, which needs Xcode and was not compiled here.
