---
title: Cloud Connect security and privacy
description: The Cloud Connect trust model, who can see what, how fast revocation works, why sign-in asks for confirmation when it does, and what stays on the phone.
group: Cloud Connect
order: 75
---

This page is for admins and security reviewers. It describes what Cloud Connect
protects, what it does not, and the risks it accepts. The full threat list is in the
repository's [SECURITY.md](https://github.com/SiavZ/yaran/blob/main/SECURITY.md).

> [!WARNING]
> **Cloudflare terminates TLS and can read all traffic to every paired machine**:
> terminal input and output, file contents, diffs and config. This is how Cloudflare's
> HTTPS edge works, and Cloud Connect accepts it. If your work cannot accept it, use
> [Tailscale](/docs/tailscale) or [your own proxy](/docs/public-hosting).

## The trust model

- **One machine, one person.** yaran still has no login of its own, and every machine is
  still single-tenant. With Cloud Connect, the only person who can reach a machine
  remotely is the person who paired it. Cloudflare Access checks their sign-in, and yaran
  checks it again on every request and every terminal connection, so remote access is
  exactly owner access.
- **The org admin is trusted with the org's Cloudflare account**, and with everything
  the control plane's API token can do there: create and delete tunnels, Access
  applications and DNS records in the chosen zone.
- **The publisher relay is trusted for availability only.** It forwards iPhone
  notifications it cannot read. If it misbehaves, iPhone push stops; it cannot read or
  forge readable notifications.
- **Loopback, LAN and Tailscale access are unchanged.** Pairing adds a remote path; it
  does not add a login to the local ones.

> [!CAUTION]
> Because remote access is owner access, a remote session can do everything you can,
> including reading your config file and the values in `[env]`. Those values also cross
> Cloudflare's edge in plaintext whenever the page loads them. Keep real secrets out of
> `[env]`.

## Who can see what

| Party | Sees | Never sees |
|---|---|---|
| Cloudflare | Everything that crosses a machine's address, decrypted at its edge | Nothing on your machine that is not sent through it |
| Your org's control plane | Users' emails, machine names and owners, phones, the audit log, and each agent's name, project and state when it needs someone | Terminal output, file contents, the tunnel tokens |
| The publisher relay | A phone's Apple push token, the org's push public key, encrypted notifications, their timing and volume | Notification contents, who you are, machine or agent names |
| Apple, Google, your UnifiedPush distributor | Encrypted notifications and their timing | Their contents |

The control plane stores its own secrets encrypted with the data key the admin chose at
deploy time. Tunnel tokens are never stored there at all; each machine keeps its own.

## Revocation, and how fast it works

- **Revoking a machine** in the console takes effect at once on the control plane: the
  machine's next call is refused, its DNS record is removed first, and then its tunnel
  and Access application are deleted. yaran on that machine stops its connection and
  tells its owner.
- **Rotating a machine's tunnel token** replaces the secret at once. When the owner
  rotates it, the running connection stays up until yaran reconnects with the new token
  by itself. When an admin rotates it in the console, ticking the option to drop
  connections cuts the live connections immediately; use that when you suspect the token
  leaked.
- **Removing a phone** stops its notifications and refuses it at the control plane at
  once.
- **Access sign-ins already issued keep working until they expire.** Cloudflare Access
  has no way to revoke one phone's session, so a stolen phone keeps its sign-in for up to
  the session length (24 hours by default). The console's sign-out-everywhere revokes
  every Access session the person has. yaran closes open terminal connections when the
  sign-in behind them expires.

## Why a machine is never reachable unprotected

The control plane creates a machine's protection before its address: the Access policy,
then the Access application, then the tunnel and its routing, and only then the DNS
record. Teardown runs the other way, removing the DNS record first. At no point does a
machine's address resolve to a tunnel that Access does not guard.

On the machine, `cloudflared` also refuses any request without a valid Access sign-in
for that machine, and yaran checks the sign-in again itself. Three independent checks
stand in front of the workspace.

## Why sign-in asks for confirmation, and why only sometimes

The first time a phone signs in to a host, the browser shows a confirmation page naming
the phone and the host. Single sign-on often approves silently when you are already
signed in, so without that page, a malicious app or link could start a sign-in that
completes without you ever seeing it. The page puts a person in the loop.

The page is remembered for that phone and that host after you tap Continue. A later
sign-in skips it only when the request is signed by a key that this app install holds in
the phone's secure hardware and cannot export. No other app can produce that signature,
so a sign-in started by anything else always meets the page.

It comes back when the phone is removed or revoked, the app is reinstalled, the org is
added again, the machine is paired again, the machine's owner runs
`yaran cloud rotate --consent-key`, the admin rotates the data key (for the control plane), the browser's
cookies are cleared, or after about 400 days.

> [!IMPORTANT]
> **Accepted risk.** Removing a phone clears its remembered confirmation on the control
> plane at once. Machines are never told about the removal, so on a machine the phone
> can still skip the page until that machine is paired again or logged out, its owner
> runs `yaran cloud rotate --consent-key`, or 400 days pass. Skipping the page still
> requires a valid Access sign-in for the machine's owner, which sign-out-everywhere
> revokes.

## What stays on the phone

- The orgs you added, and your sign-ins for the control plane and each machine, in the
  phone's secure storage (the iOS Keychain, or keys in the Android Keystore), never in
  backups.
- The keys that decrypt notifications.
- The device key that signs sign-in requests, in secure hardware.
- A local diagnostics log that leaves the phone only if you export it. It never holds
  sign-in tokens, cookies or link parameters, but it does name your orgs' and machines'
  host names and machine names.

Signing out of an org deletes that org's data. Erasing everything deletes all of it and
the app's keys. The app has no analytics and no crash reporting service.

## Where to go next

- [SECURITY.md](https://github.com/SiavZ/yaran/blob/main/SECURITY.md): the threat
  table, including every Cloud Connect threat and the accepted risks.
- [Setting up your org's control plane](/docs/cloud-admin-setup): the API token's
  permissions, one by one.
