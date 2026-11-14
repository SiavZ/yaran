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
- **A tab ended badly**: its provider exited with an error, unless you were looking at
  that tab when it happened.

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
for the first time after a restart), it shows generic text instead.

Your org's control plane does see the agent name, project and state it forwards. It
runs in your org's own Cloudflare account.

## Which push channel your install uses

| Install | Channel |
|---|---|
| Google Play, or the GitHub `play` APK | Google's push service, built into the app with no Google Play services library. If you install a UnifiedPush distributor such as ntfy, the app uses that instead |
| F-Droid, or the GitHub `foss` APK | UnifiedPush, through a distributor app you choose |
| App Store | Apple's push service, through the open-source publisher relay |

**UnifiedPush.** Install a distributor, for example [ntfy](https://ntfy.sh), then pick it
in the app's notification settings. Changing distributors registers every org again.
With no distributor installed, the app says so and links to
[the list of distributors](https://unifiedpush.org/users/distributors/).

The app asks for notification permission only when you tap **Turn on notifications**,
never at launch. If you deny it, the app offers to open the system settings.

## Muting

In the app's notification settings, per org:

- **Mute** the whole org, indefinitely or for a while.
- **Mute** individual machines.
- **Turn off notifications for this org**, which keeps the phone signed in.

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
- **push stopped: the phone must register again** (after your admin rotated the org's
  push key)

On Android, if this happens while the app is closed, you get one notification saying
the org's notifications need a refresh. Open the app.

## Where to go next

- [The phone app](/docs/mobile-apps).
- [Troubleshooting Cloud Connect](/docs/cloud-troubleshooting#push-notifications-do-not-arrive).
