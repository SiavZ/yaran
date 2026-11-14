---
title: Troubleshooting Cloud Connect
description: What each Cloud Connect message means and what to do about it, on the machine, in the browser, in the admin console and on the phone.
group: Cloud Connect
order: 76
---

Each section starts from what you see. Run `yaran cloud status` on the machine first:
it shows the pairing, the connection state and what the control plane says, and its exit
code alone tells you a lot (0 online, 3 paired but not running, 4 not paired, 5
revoked).

> [!WARNING]
> **Cloudflare terminates TLS for Cloud Connect** and can read terminal traffic and
> file contents. See [Security and privacy](/docs/cloud-security-privacy).

## On the machine

### The header says `☁ connecting…` and stays there

The machine is paired but its connection is not up yet.

- **Is yaran serving?** Cloud Connect runs only while yaran serves the web UI
  (`yaran server`, the `start-web-server` palette flip, or `serve_while_tui = true`).
- **Is it serving on the port it was paired on?** yaran says so if not, naming both
  ports: set `[server] port` to the one the pairing expects.
- **Is `cloudflared` still downloading?** The status line shows its progress the first
  time.
- **Is `mode` set to `"no"`** under `[cloud]`? Then the connection never runs.

### yaran refuses to start `cloudflared`

- A **checksum mismatch** on the managed download: yaran names the expected and actual
  checksums and refuses to run it. Delete the `cloud/bin/` folder in your yaran
  directory so yaran downloads it again, or point `cloudflared_path` at a binary you
  trust.
- **Your own `cloudflared` is too old**: yaran names the version it found and the
  minimum, 2026.11.0. Update it, or empty `cloudflared_path` to let yaran manage it.
- **An unsupported platform**: yaran manages `cloudflared` on Linux and macOS, x86_64 and
  aarch64. Elsewhere, set `cloudflared_path`.

### "this machine's clock is off by N s; fix the system clock"

Signed calls to the control plane are accepted only within five minutes of the control
plane's own time. Turn on automatic time sync.

### "Yaran Cloud revoked `<hostname>`; remote access is off."

An admin revoked this machine, or removed it from the console. The connection has
stopped and phone notifications from it have stopped too; local access is unaffected.
Run `yaran cloud login <org>` to pair again, if your admin allows it.

### Pairing is refused

- **The org has run out of Access applications**: the refusal names the quota and both
  numbers, for example "This org has used 500 of 500 Access applications. Ask an admin to
  remove unused machines". An admin removes unused machines or other Access applications
  in the account.
- **You have reached your machine limit** (10 by default): remove a machine you no longer
  use, or ask an admin to raise **Machines per user**.
- **You are not allowed to pair**: the org's **Who may pair** setting does not include
  you. Ask an admin.
- **The fingerprint did not match**, so you pressed Cancel. Good. Start again from the
  terminal and compare once more.

### yaran or the app is too old, or too new, for the control plane

The control plane, yaran and the app agree on a protocol version when they connect, and
refuse with the range each side supports when they cannot. Update whichever side is
older: yaran on the machine, the app from its store, or the control plane through its
update pull request.

## In the browser

### "Sign in again"

Your Cloudflare Access sign-in for this machine expired, so yaran cannot reach it. Press
**Sign in**, sign in in the new tab, and come back: yaran reconnects on its own. In the
app the same cover says your sign-in for the host has expired and offers to sign in
again where you left off.

### "The server answered HTTP *N* with a web page instead of a yaran reply."

Something between you and yaran answered instead of yaran. Through Cloud Connect, that
is usually an expired Access sign-in: reload the page to sign in again.

### The `workers.dev` address refuses everything

That is intended. Once setup finishes, the control plane answers only on
`<org-control-plane>`. Use that address.

### The setup page says setup is closed

Setup has already been completed for this control plane, and it cannot run twice. Open
`<org-control-plane>` and sign in. If the only admin has left, see the operations guide
for your control plane.

## On the phone

### "This control plane hasn't finished setup yet."

Your admin has not finished the setup page. Ask them to, then try again.

### "You chose Cancel on the sign-in page, so this phone wasn't signed in."

You tapped Cancel on the confirmation page. Tap **Try again** and choose **Continue**
this time, if you started the sign-in.

### "Sign-in was cancelled."

The browser was closed before sign-in finished. Tap **Try again**.

### The confirmation page shows on every sign-in

The page is remembered by a cookie in your phone's browser. If it shows every time, the
browser is not keeping that cookie: a private or incognito mode, a setting that clears
cookies on exit, or a privacy extension that blocks them. Allow cookies for your org's
addresses in the browser the app opens. On iPhone, iOS's own "wants to use … to sign in"
prompt appears every time regardless; that is not the confirmation page.

### Sign-in never comes back to the app

- **"This copy of the app couldn't prove it owns the sign-in link for
  `<publisher-domain>`."** Your phone could not confirm the link that hands sign-in back
  to the app. Install the app from one of the official channels, or try again later.
- **"Install or enable a browser (Chrome, Firefox, Brave, Vanadium…) to sign in."** The
  app needs a browser that supports secure sign-in. Install or enable one.
- **The browser stays on a blank or error page after you sign in.** Make sure your
  default browser is up to date, and try setting a different default browser.

### "`<email>` isn't the owner of `<machine>`."

Only the person who paired a machine can open it. Sign in as that person, or pair the
machine with your own account.

### "This phone's clock is more than five minutes off from `<host>`, so the sign-in was refused."

Set the phone's clock to update automatically, then try again.

### "Too many sign-ins in a short time. Wait a minute and try again."

The machine accepts 12 phone sign-ins a minute by default
(`handoff_requests_per_minute`). Wait and retry.

### The machine shows as offline

"`<machine>` is offline or its tunnel isn't connected": yaran on that machine is not
serving, the machine is asleep, or its connection is down. Check `yaran cloud status` on
the machine. "`<machine>` is no longer connected to the cloud" means the machine was
logged out or revoked.

### "yaran on `<machine>` can't reach Cloudflare's key service, so signing in again won't help."

The machine cannot fetch the keys it needs to check your Access sign-in, and refuses
every request until it can. Signing in again will not help. Try again in a minute; if it
persists, check the machine's network.

### Push notifications do not arrive

- **Check the app's notification settings** for the org: permission granted, not muted,
  not turned off.
- **Check the machine**: `push_notifications` under `[cloud]` is `true`, and
  `yaran cloud status` shows the org has not paused push.
- **"push stopped" in the console**: open the app once and it registers again.
- **UnifiedPush builds** (F-Droid, GitHub `foss`): a distributor must be installed and
  picked in the app, and the distributor itself must be allowed to run in the
  background. With none installed the app says "No UnifiedPush distributor installed".
- **Play builds**: the phone needs to reach Google's push service.
- **iPhone**: your admin's **Allow the iPhone relay** setting must be on. Focus modes
  and notification summaries can hold notifications back.

## Where to go next

- [Connecting a machine](/docs/cloud-connect-machine).
- [The phone app](/docs/mobile-apps).
