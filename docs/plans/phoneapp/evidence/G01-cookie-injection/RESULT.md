# G01 Injected CF_Authorization cookie accepted by Access for HTTP and WebSocket in Android WebView and WKWebView: OPEN

Not run yet. This record is the Phase 03 template with the verdict pending; the gate closes only
when a run fills it in and the decision owner and the maintainer sign it off.

- **Date / operator role / commit of tools/cloud-gates used:** pending
- **Versions:** cloudflared pending; wrangler 4.162.0 (pinned in the scripts); Capacitor 8.6.2 (spike);
  Android API / WebView M-version / browser pending; iOS + Xcode pending; account A org creation date
  (strict mode yes/no) pending
- **Procedure:** `tools/cloud-gates/run.sh G01` plus the device checklist it prints (kept as
  `run-YYYY-MM-DD/checklist.md`)

## Observations

Paste the run's `run-YYYY-MM-DD/observations.md` here. Pass criteria (Phase 03):

| Criterion | Observed | Met? |
|---|---|---|
| Header and cookie hashes equal, or both values accepted (step 5) | pending | pending |
| Every device: injected cookie gives navigation 200, XHR 200, events socket 101, PTY socket 101 streaming | pending | pending |
| No cookie: 302 to <team>.cloudflareaccess.com | pending | pending |
| Binding cookie on: injected cookie rejected | pending | pending |

## Verdict and sign-off

- **Verdict:** OPEN (PASS or FALLBACK ADOPTED with its level, once run)
- **Decision owner:** Phase 15 lead, pending
- **Maintainer sign-off:** pending
- **Affected phases to update in the closing PR:** 15, 11, 06, 05, 13 (none updated yet)

## Re-run triggers

A new Android WebView or iOS major; a cloudflared release touching Access; any Access change to CF_Authorization or the binding cookie.

## What is ready, and what closing it needs

- **Ready to run:** `g01-cookie-injection.sh` provisions the tunnel, owner-only Access app (binding cookie off) and per-rule access, runs the echo origin and cloudflared, takes the operator's header/cookie JWTs at hidden prompts, compares hashes, records Set-Cookie attributes and the GET/WebSocket matrix for every credential and with the binding cookie on, and prints the device checklist. The spike's MachineViewSpike (Android builds and its unit tests pass) does the cookie injection.
- **The maintainer must provide:** Staging account A, the gate runner token, the test identity and a desktop browser; the devices (Android 15/16 emulator with WebView >= M144, the GrapheneOS Pixel, iOS 17.4 and latest simulators, a physical iPhone); Xcode 26 on an Apple-silicon Mac to build the iOS spike (not built here).
- **Later-phase dependency:** Step 6 (the real yaran UI) needs yaran reachable on the machine hostname: until Phase 11's live host rule lands, preview-env with the hostname added through --bind/allowed_hosts for the gate only.
