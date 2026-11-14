---
title: The phone app
description: Installing the yaran app on Android or iPhone, adding your org, how sign-in and its confirmation page work, the machines list, app lock, and signing out.
group: Cloud Connect
order: 73
---

The yaran app puts your org's machines in your pocket. Each machine opens its own yaran
web UI, served by the machine itself, so the app is always exactly as new as the yaran
on the other end. The app speaks Cloud Connect only: your org needs a
[control plane](/docs/cloud-admin-setup), and the machine must be
[paired](/docs/cloud-connect-machine).

> [!WARNING]
> **Cloudflare terminates TLS and can read everything the app shows you from a
> machine**, terminal sessions and file contents included. The app says so before your
> first sign-in. See [Security and privacy](/docs/cloud-security-privacy).

## Installing

| Channel | Platform | Notes |
|---|---|---|
| Google Play | Android 7.0 or newer | Push through Google's service, built in |
| GitHub releases | Android 7.0 or newer | Two APKs per release: `foss` (no Google code, push through UnifiedPush) and `play` (the Play build) |
| F-Droid | Android 7.0 or newer | The `foss` build |
| App Store | iOS 17.4 or newer | Push through Apple's service, via the publisher relay |

Every Android channel is signed with the same key, so a Play install, a GitHub install
and an F-Droid install can upgrade one another: you can switch channels without losing
your orgs. The app never updates itself and never installs anything; the stores update
it, and the `foss` build's About screen links to
[the GitHub releases](https://github.com/SiavZ/yaran/releases).

iOS 17.4 is the minimum because older versions cannot hand a sign-in back to the app
through a link only this app can receive.

## Adding your org

Open the app and either scan a QR code or type your org's address.

- **QR code.** Run `yaran cloud pair-phone` on a paired machine, or open **Connect a
  phone…** in its web UI's cog menu.
- **Typing it.** Enter `<org-control-plane>`; the app adds `https://` if you leave it
  out. This always works, so a camera that will not cooperate never blocks you.

Before anything else happens, the app shows the org's name and its Cloudflare Access
team domain, and the reminder that Cloudflare decrypts traffic at its edge. Check that
it is the org you expect, then continue. A link or QR code never adds an org on its own.

## Signing in

Sign-in runs in your phone's own browser, never inside the app, so your org's single
sign-on works exactly as it does on your computer, password manager and passkeys
included.

1. The browser opens your org's sign-in page. Sign in as usual.
2. The first time this phone signs in to a host (the control plane, and each machine
   the first time you open it), a confirmation page asks **Sign this device in to
   `<host>`?**, naming this phone. Tap **Continue**, or **Cancel** if you did not start
   this.
3. The browser hands the result back to the app through a link on the publisher's
   domain, `<publisher-domain>`. Your phone's operating system delivers that link only to
   the genuine yaran app, so no other app on the phone can receive it. The result is also
   encrypted to a key only this app holds.

Later sign-ins and renewals on the same phone skip the confirmation page. It comes back
when:

- this phone is removed from the org, or revoked;
- the app is reinstalled, or the org is removed and added again;
- the machine is paired again, or its owner runs `yaran cloud rotate --consent-key` on it;
- your admin rotates the control plane's data key;
- the browser's cookies are cleared;
- about 400 days have passed since you last confirmed.

> [!NOTE]
> **On iPhone, iOS asks every time** whether yaran may use the host to sign in, renewals
> included. That prompt belongs to iOS and no app can turn it off. Android shows no such
> prompt.

> [!WARNING]
> **A build of the app made without a publisher domain**, such as a fork or a
> development build, hands sign-ins back through a custom link that any app on the
> phone can claim. Such builds show a banner on every screen: "Development build:
> sign-in replies use a link any app on this phone can claim. Use it only with test
> orgs." The confirmation page warns that the request comes from a development build of
> the yaran app. Builds from the channels above never show the banner.

## Machines

The machines list shows every machine you paired in each org you added: its name, its
status (Online, Degraded, Offline, Never connected, Setting up, Being removed, or
Status unknown), and when it was last seen. It refreshes when you return to the app, when
you tap Refresh, and every 30 seconds while you look at it.

Tap a machine to open its yaran web UI. Links that lead off the machine open in your
browser. Downloads are not supported in the app: open the file in the yaran web UI on
your computer. Inside a machine, the cog menu adds
**Switch machine** and **Phone app settings**.

The `⋯` on a row has **Remove…**, which asks first and then unpairs that machine, so
yaran on it stops its cloud connection.

## Settings

- **Notifications**: see [Push notifications](/docs/push-notifications).
- **Security**:
  - **App lock** asks for your fingerprint or face before showing yaran, after
    **Immediately**, **1 minute**, **5 minutes** or **15 minutes** in the background
    (1 minute is the default). **Allow device passcode** lets the phone's passcode unlock
    it when biometrics fail; change it while the lock is off. If the fingerprints or
    faces enrolled on the phone change, yaran deletes its sign-ins and says so; your orgs
    stay listed and you sign in to each one again.
  - **Hide screen content**: on Android this blocks screenshots and screen recording and
    blanks yaran in the app switcher; on iPhone it covers the app in the app switcher and
    while the screen is recorded or mirrored.
- **Reopen last machine on launch**.
- **Language**.
- **Diagnostics**: a local log you can view and export. It never includes sign-in
  tokens, cookies or link parameters, but it does include org and machine host names
  and machine names, and the screen says so. Nothing is sent anywhere unless you share
  it.
- **About and licenses**.
- **Erase everything on this phone…**

## Signing out and removing the phone

Signing out of an org removes this phone from it and deletes that org's sign-ins and
data from the phone. **Erase everything on this phone…** does the same for every org and
then deletes the app's keys.

An admin, or you from another device, can also remove the phone in the admin console.
The app then says:

> This phone was removed from `<org>` (by you or an admin), so its sign-ins were
> deleted. Add the org again to keep using it.

## Where to go next

- [Push notifications](/docs/push-notifications).
- [Security and privacy](/docs/cloud-security-privacy): what the phone keeps and who can
  see what.
- [Troubleshooting Cloud Connect](/docs/cloud-troubleshooting): sign-in that does not
  come back, a confirmation page on every renewal, and the rest.
