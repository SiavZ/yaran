# G05 The Play build's embedded FCM distributor accepts standard VAPID Web Push with no publisher FCM credentials: OPEN

Not run yet. This record is the Phase 03 template with the verdict pending; the gate closes only
when a run fills it in and the decision owner and the maintainer sign it off.

- **Date / operator role / commit of tools/cloud-gates used:** pending
- **Versions:** cloudflared pending; wrangler 4.162.0 (pinned in the scripts); Capacitor 8.6.2 (spike);
  Android API / WebView M-version / browser pending; iOS + Xcode pending; account A org creation date
  (strict mode yes/no) pending
- **Procedure:** `tools/cloud-gates/run.sh G05` plus the device checklist it prints (kept as
  `run-YYYY-MM-DD/checklist.md`)

## Observations

Paste the run's `run-YYYY-MM-DD/observations.md` here. Pass criteria (Phase 03):

| Criterion | Observed | Met? |
|---|---|---|
| Send returns 201 and the payload decrypts in onMessage on the Play emulator and on sandboxed Play | pending | pending |
| A different VAPID key gets a 4xx (code recorded) | pending | pending |
| No Play Services: registration reports a clear error | pending | pending |

## Verdict and sign-off

- **Verdict:** OPEN (PASS or FALLBACK ADOPTED with its level, once run)
- **Decision owner:** Phase 16 lead, pending
- **Maintainer sign-off:** pending
- **Affected phases to update in the closing PR:** 16, 08, 18 (none updated yet)

## Re-run triggers

Any Play Services update; new connector or embedded-fcm-distributor releases (the path is undocumented by Google).

## What is ready, and what closing it needs

- **Ready to run:** `g05-embedded-fcm.sh` mints VAPID keys, takes the spike's endpoint/p256dh/auth at hidden prompts, sends through web-push (env only), runs the wrong-key, Doze and force-stop cases (adb when GATE_ADB_SERIAL is set). The spike's play flavor builds with connector 3.3.5 + embedded-fcm-distributor 3.1.0 and no google-services.json.
- **The maintainer must provide:** A google_apis_playstore emulator, the GrapheneOS Pixel with sandboxed Google Play, and a device without Play Services. No Cloudflare account is needed.
- **Later-phase dependency:** None.
