---
title: Push notifications
description: When the yaran app buzzes, what a notification contains, how it is encrypted, the push channel for each install, muting, and what "push stopped" means.
group: Cloud Connect
order: 74
---

The phone app can tell you when an agent on one of your machines needs you, even when
the app is closed.

> [!WARNING]
> **Cloudflare terminates TLS for Cloud Connect** and can read terminal traffic and
> file contents. Notifications themselves are end-to-end encrypted, as described below.
> See [Security and privacy](/docs/cloud-security-privacy).

## When a notification fires

- **An agent needs you.** The same moment the agent's row starts asking for your
  attention in yaran. This works whether or not you turned the attention indicator on in
  yaran's own settings.
- **A tab ended badly**: its provider failed to start, stopped with an error, stopped
  unexpectedly, or exited right after starting, unless you were looking at that tab when
  it happened.

When the agent stops needing you, yaran clears the notification on your phone. An agent
that asks and then stops asking within two seconds sends nothing at all
(`push_coalesce_seconds`). On iPhone, clearing is best effort, because iOS limits
background work.

If the machine cannot reach the control plane, notifications wait for up to ten minutes
(`push_offline_ttl_seconds`) and are then dropped, and yaran tells you how many it
dropped.

## What a notification contains

The agent's name, its project, the machine's name, and what happened, for example
"refactor-pty needs you" over "billing-api · laptop". Never any agent output and never
anything from the terminal.

Your admin can set push detail to **Minimal**, which leaves the agent and project names
out, so a notification says only "An agent needs you" and the machine's name.

## How it is protected

Notifications are encrypted on the way from your org's control plane to your phone, to
keys that only your phone holds, and decrypted on the phone. Google, Apple, your
UnifiedPush distributor and the publisher relay carry them but cannot read them. They
can see that a notification was sent, and when.

If the phone cannot decrypt a notification in time (for example before you unlock it
for the first time after a restart), it shows generic text instead: "An agent needs
attention" and "Open yaran to see which agent."

Your org's control plane does see the agent name, project and state it forwards. It
runs in your org's own Cloudflare account.

## Which push channel your install uses

| Install | Channel |
|---|---|
| Google Play, or the GitHub `play` APK | Google's push service through Google Play services, built into the app with no Firebase library. If you install a UnifiedPush distributor such as ntfy, the app uses that instead. (A Play build made with the publisher's fallback push setup sends through the publisher relay.) |
| F-Droid, or the GitHub `foss` APK | UnifiedPush, through a distributor app you choose |
| App Store | Apple's push service, through the open-source publisher relay |

**UnifiedPush.** Install a distributor, for example [ntfy](https://ntfy.sh). The app
uses it by itself; with more than one installed, choose one under **Push distributor**
in the app's notification settings. Changing distributors registers every org again.
With no distributor installed, the app says "No UnifiedPush distributor installed" and
offers **Find a distributor**, which opens
[the list of distributors](https://unifiedpush.org/users/distributors/).

The app asks for notification permission only when you tap **Turn on notifications**,
never at launch. If you deny it, the app offers to open the system settings.

## Muting

In the app's notification settings, per org:

- **Mute for an hour** or **Mute until I unmute** silences the whole org.
- Switch off individual machines in the list under the org.
- **Turn off notifications for this org…** asks first, then stops them while the phone
  stays signed in.

A notification also carries a **Mute this machine** action.

On the machine, `push_notifications = false` under `[cloud]` stops that machine sending
anything. It withdraws nothing already delivered. Your admin can also turn push off for
the whole org.

## "Push stopped"

Push services sometimes drop a phone's subscription, for example after the app was
reinstalled or the distributor changed. The phone stays listed in the org, but receives
nothing until the app registers again, which it does by itself the next time you open
it. Until then the consoles show one of:

- **push stopped: the subscription expired**
- **push stopped: the phone must register again** (the push service stopped accepting
  the org's authorization for this phone)

On Android, if the distributor changes the phone's subscription while the app is closed,
you get one notification, "Notifications for `<org>` need a refresh". Open the app.

## Where to go next

- [The phone app](/docs/mobile-apps).
- [Troubleshooting Cloud Connect](/docs/cloud-troubleshooting#push-notifications-do-not-arrive).
