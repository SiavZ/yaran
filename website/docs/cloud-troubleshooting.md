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
- **Is it serving on the port it was paired on?** yaran normally tells the control plane
  about a new port by itself. When it cannot, it says "Remote access is off: this machine
  was paired for port *A*, yaran is serving on *B*, and Yaran Cloud could not be told":
  set `[server] port` to the paired port, or check your network.
- **Is it serving on loopback?** "Remote access is off: nothing answers on
  127.0.0.1:*port*" means yaran is not listening on the loopback address the connection
  forwards to. Serve on loopback (the default `[server] host`).
- **Is `cloudflared` still downloading?** The status line shows "Downloading cloudflared"
  with its progress the first time.
- **Is `mode` set to `"no"`** under `[cloud]`? Then the connection never runs.

### yaran refuses to start `cloudflared`

Each of these starts with "Remote access is off:" on the status line.

- A **checksum mismatch** on the managed download: "the downloaded cloudflared … did not
  match its pinned checksum (expected …, got …) and was deleted". yaran never runs a
  binary that does not match. Try again later, or point `cloudflared_path` at a binary
  you trust.
- **Your own `cloudflared` is too old**: "the configured cloudflared is version *X*,
  below the minimum 2026.11.0 …". Update it, or empty `cloudflared_path` to let yaran
  manage it.
- **An unsupported platform**: "yaran has no pinned cloudflared for this platform".
  yaran manages `cloudflared` on Linux and macOS, x86_64 and aarch64. Elsewhere, set
  `cloudflared_path`.

### "The control plane rejected the request because this machine's clock is wrong"

The message goes on to give the control plane's time and how far off this clock is.
Signed calls to the control plane are accepted only within five minutes of the control
plane's own time. Turn on automatic time sync.

### "Yaran Cloud revoked `<hostname>`; remote access is off."

An admin revoked this machine, or removed it from the console. The connection has
stopped and phone notifications from it have stopped too; local access is unaffected.
Run `yaran cloud login` to pair again, if your admin allows it.

### Pairing is refused

When the browser refuses, the terminal says "The control plane refused to pair this
machine:", then what happened and what to do next, with a code in brackets. The most
common codes:

- `machine_cap_reached`: **you have reached your machine limit** (10 by default).
  Remove a machine you no longer use, or ask an admin to raise **Machines per user**.
- `pairing_not_allowed`: the org's **Who may sign in and pair** setting does not include
  you. Ask an admin.
- `pair_denied`: you pressed **Deny**. If the fingerprint did not match, good: start
  again from the terminal and compare once more.

Some refusals show on the browser page instead, under "Pairing did not finish":

- **The org has run out of Access applications** (or policies, or tunnels): "This org
  has used 500 of 500 Access applications. Ask an admin to remove unused machines or
  raise the quota, then try again." An admin removes unused machines or other Access
  applications in the account.
- **Setup is taking longer than usual**: press **Retry** after a few seconds; nothing is
  created twice.

### yaran or the app is too old, or too new, for the control plane

The control plane, yaran and the app agree on a protocol version when they connect. On
the machine, a mismatch reads "The control plane speaks protocol versions *A* to *B* and
this yaran speaks *C*", followed by "update yaran" or "ask your administrator to update
the control plane". On the phone it reads "This app and `<host>` don't speak the same
protocol version. Update whichever side is older, then try again." Update yaran on the
machine, the app from its store, or the control plane through its update pull
request.

## In the browser

### "Sign in again"

"Your Cloudflare Access sign-in for `<hostname>` has expired, so yaran can't reach this
machine." Press **Sign in**, sign in in the new tab, and come back: yaran reconnects on
its own. In the app the machine window says "Sign-in needed for `<machine>`" and offers
to sign in again; yaran picks up where you left off.

If the cover says "Can't reach yaran" instead, yaran could not tell whether the machine
is down or your sign-in expired: try **Reconnect** first, then sign in again.

### "The server answered HTTP *N* with a web page instead of a yaran reply."

Something between you and yaran answered instead of yaran. Through Cloud Connect, that
is usually an expired Access sign-in, as the message itself says: reload the page to
sign in again.

### The `workers.dev` address refuses everything

That is intended. Once setup finishes, the control plane answers only on
`<org-control-plane>`, and any other address gets "This hostname does not serve the
control plane." Use `<org-control-plane>`.

### "Setup is locked for your address"

The setup page locks the network address you are on, and only that one, after 20 wrong
setup codes from it. It also locks an address on its first wrong code while wrong codes
are pouring in from many addresses, which looks like someone guessing. Another address
can still start setup with the right code. To unlock this one, change the `SETUP_CODE`
secret in the dashboard and reload the page.

"Too many tries from your address" and "Your address has used its 30 setup-code tries
for today" are pauses, not locks: each address gets five codes every 15 minutes and 30 a
day, right or wrong. The page says how long to wait.

### "Setup is closed."

Opening the setup page on `<org-control-plane>` says "Setup is complete; the setup
wizard is closed." instead. Setup has already been completed for this control plane, and it cannot run twice. Open
`<org-control-plane>` and sign in. If the only admin has left, see the operations guide
for your control plane.

## On the phone

### "This control plane hasn't finished setup yet."

Your admin has not finished the setup page. Ask them to, then try again. The control
plane refuses everything except the setup page until then.

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
  to the app. Install the app from an official channel, or try again later.
- **"The app was closed while you were signing in, so that sign-in can't finish."**
  Start the sign-in again and keep the app open until it returns.
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
the machine. "`<machine>` is no longer connected to the cloud. Check yaran cloud status
on the machine." means yaran on the machine no longer answers for that address, usually
because the machine was logged out or revoked.

### "yaran on `<machine>` can't reach Cloudflare's key service, so signing in again won't help."

The machine cannot fetch the keys it needs to check your Access sign-in, and refuses
every request until it can. Signing in again will not help. Try again in a minute; if it
persists, check the machine's network.

### Push notifications do not arrive

- **Check the app's notification row** for the org. "Notifications are not allowed for
  yaran on this phone", "Muted on this phone" and "Notifications are off for this
  organization" are each fixed right there. "This organization has turned notifications
  off" means your admin switched **Push notifications** off for everyone.
- **Check the machine**: `push_notifications` under `[cloud]` is `true`.
- **"push stopped" in the console**: open the app once and it registers again. Every
  phone shows this after an admin rotates the org's push keys.
- **UnifiedPush builds** (F-Droid, GitHub `foss`): a distributor must be installed and
  picked in the app, and the distributor itself must be allowed to run in the
  background. With none installed the app says "No UnifiedPush distributor installed" and offers
  **Find a distributor**.
- **Play builds**: the phone needs to reach Google's push service.
- **iPhone**: your admin's **Allow push relays** setting must be on; turning it off
  turns push off on iPhones. Focus modes
  and notification summaries can hold notifications back.

## Where to go next

- [Connecting a machine](/docs/cloud-connect-machine).
- [The phone app](/docs/mobile-apps).
