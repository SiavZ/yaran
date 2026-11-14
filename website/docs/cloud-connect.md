---
title: Cloud Connect overview
description: What Cloud Connect is, how it compares to Tailscale and to your own proxy, what Cloudflare and everyone else can see, and what you need before you start.
group: Cloud Connect
order: 70
---

Cloud Connect puts each of your machines on its own HTTPS address, behind your
organization's single sign-on, so you can open yaran from anywhere and from the yaran
phone app. It runs on your organization's own Cloudflare account. There is no yaran-run
service in the middle and no yaran account to make.

> [!WARNING]
> **Cloudflare terminates TLS and can read everything that crosses it.** Terminal
> input and output, file contents in the editor, diffs, your config file: all of it is
> decrypted at Cloudflare's edge before it reaches your machine. If that is not
> acceptable for your work, use [Tailscale](/docs/tailscale) or
> [your own proxy](/docs/public-hosting) instead.

## How it works

Three parts, each owned by someone different:

- **Your org's control plane.** One Cloudflare Worker your admin deploys into the
  org's Cloudflare account, at an address like `<org-control-plane>`. It pairs
  machines, signs phones in, keeps an audit log, and sends push notifications. It never
  carries terminal traffic. See [Setting up your org's control plane](/docs/cloud-admin-setup).
- **Each machine.** You run `yaran cloud login <org-url>` once. yaran then supervises a
  `cloudflared` process that dials *out* to Cloudflare, so your machine opens no port.
  Its address is `<machine>-<user>.<zone>`. See
  [Connecting a machine](/docs/cloud-connect-machine).
- **Your phone.** The yaran app signs in through your system browser and opens the
  machine's own yaran web UI. See [The phone app](/docs/mobile-apps).

yaran still has no login of its own. With Cloud Connect, Cloudflare Access is the login
for each machine's address, and yaran double-checks it: every request for that address
must carry an Access sign-in for the person who paired the machine, or yaran refuses it.
Loopback, LAN and Tailscale addresses behave exactly as they did before.

## Cloud Connect, Tailscale, or your own proxy

| | Tailscale | Your own proxy | Cloud Connect |
|---|---|---|---|
| Who can reach yaran | Devices on your tailnet | Whoever passes your proxy's login | The person who paired the machine, after Access sign-in |
| Login | None in yaran; the tailnet is the boundary | Yours, for example `oauth2-proxy` | Your org's identity provider, through Cloudflare Access |
| Who decrypts traffic | Nobody in between | Your proxy | Cloudflare |
| Phone app | No (use the browser) | No (use the browser) | Yes |
| Push notifications | No | No | Yes |
| What you run | Tailscale on each device | A proxy, TLS, a login service | A Worker per org; yaran runs `cloudflared` for you |

They are not exclusive. A machine on Cloud Connect keeps its loopback and Tailscale
listeners.

## Who can see what

| Party | What it sees |
|---|---|
| Cloudflare | Everything that crosses a machine's address, in plaintext at its edge |
| Your org's control plane (the Worker) | Machine names, owners, phones, and each agent's name, project and state when it needs you. Never terminal output or file contents |
| The publisher relay (iPhone push only) | The phone's Apple push token, your org's push public key, and encrypted notifications it cannot read |
| Apple, Google, or your UnifiedPush distributor | Encrypted notifications and their timing |

The full trust model is on [Security and privacy](/docs/cloud-security-privacy).

## What you need

- A Cloudflare account with a zone (a domain whose DNS Cloudflare serves).
- A Cloudflare Zero Trust organization. The Free plan works, but Cloudflare asks for a
  payment method when you create it.
- An admin who deploys the control plane once. Developers then pair their own machines.
- On each machine, yaran on macOS or Linux, x86_64 or aarch64.

> [!IMPORTANT]
> Every machine uses one Cloudflare Access application and one Access policy, and a
> Cloudflare account holds at most 500 of each, counting the ones you made for other
> things. That puts the ceiling a little under 500 machines per account. The admin
> console shows how close you are and warns at 90%.

## Where to go next

- [Setting up your org's control plane](/docs/cloud-admin-setup), for the admin.
- [Connecting a machine](/docs/cloud-connect-machine), for each developer.
- [The phone app](/docs/mobile-apps) and [Push notifications](/docs/push-notifications).
- [Security and privacy](/docs/cloud-security-privacy) and
  [Troubleshooting Cloud Connect](/docs/cloud-troubleshooting).
