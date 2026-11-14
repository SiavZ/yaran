---
title: Connecting a machine
description: Pairing a machine with your org's control plane, the yaran cloud commands, checking the key fingerprint, what logout removes, the cloudflared yaran runs, and every [cloud] config key.
group: Cloud Connect
order: 72
---

Pairing gives this machine its own address, `<machine>-<user>.<zone>`, behind your org's
sign-in. You need the address of your org's control plane, `<org-control-plane>`, from
whoever set it up.

> [!WARNING]
> **Cloudflare terminates TLS and can read everything that crosses this machine's
> address**: terminal sessions, file contents, diffs and your config file. See
> [Security and privacy](/docs/cloud-security-privacy).

## Pairing

```bash
yaran cloud login https://<org-control-plane>
```

yaran prints the org's name, the machine name it will use, the sign-in address, and a
**key fingerprint** like `K7QF-3MZD-W2PA-HX5R-LC4N-TB6E`. Then it opens your browser and
waits.

In the browser, sign in with your org's identity provider. The confirm page shows the
machine name, your email and a fingerprint, with **Approve** and **Deny**.

> [!IMPORTANT]
> **Check that the fingerprint in the browser is exactly the one the terminal
> printed** before you approve. A different fingerprint means the request did not come
> from this machine, or you did not just run the command. Choose **Deny**.

After you approve, the tab says the machine is paired and the terminal prints the
machine's address. If a yaran is already serving, it picks the pairing up and comes
online within seconds; if not, the terminal tells you to start one.

> [!NOTE]
> Cloud Connect only runs while yaran is serving the web UI: `yaran server`, the
> `start-web-server` palette flip, or `serve_while_tui = true`. It adds no listener of
> its own. yaran runs `cloudflared`, which dials out to Cloudflare and forwards requests
> to yaran's own loopback address, so nothing on this machine opens a port to the
> internet. If you later serve on a different port, yaran tells the control plane the new
> port by itself.

Some details:

- The machine name defaults to this computer's short hostname, lowercased, with anything
  that is not a letter, digit or hyphen turned into a hyphen; at most 32 characters.
  Choose another with `--name`.
- The org address must be `https`.
- yaran always prints the sign-in address; `--no-browser` only skips opening a browser.
  Open the address on any device (handy over SSH), and if the browser ends on a page that
  fails to load, paste that page's address into the terminal.
- yaran waits up to 15 minutes for the browser (`login_timeout_seconds`).
- If you already have a machine with that name, the confirm page offers **Replace
  `<name>`** (the same computer paired again; the old one is removed only after this one
  connects) or **Pair as `<name>-2`**.
- A machine paired with a different org is refused until you log out of the first one.

## The commands

| Command | What it does |
|---|---|
| `yaran cloud login [<url>] [--name <n>] [--no-browser]` | Pairs this machine with an org |
| `yaran cloud status [--json] [--offline]` | Shows the pairing, the connection state, and what the control plane says; `--offline` skips asking it |
| `yaran cloud rotate [--yes]` | Replaces this machine's tunnel token; a running yaran reconnects with the new one by itself |
| `yaran cloud rotate --consent-key [--yes]` | Makes every phone confirm sign-in again on this machine |
| `yaran cloud pair-phone [--org <url>]` | Prints a QR code your phone app can scan to add the org |
| `yaran cloud logout [--yes] [--local-only]` | Unpairs this machine and deletes its credentials |

`yaran cloud status` exits 0 when the machine is paired and online, 3 when it is paired
but the connection is not running, 4 when it is not paired, 5 when it was revoked, and 1
on any other error, so scripts can tell them apart. Every `yaran cloud` command exits 2
on a usage mistake. `logout` and `rotate` ask first on a terminal; off a terminal they
need `--yes`.

The same actions are reachable from both front ends, named differently on each:

- **In the terminal UI**, the command palette has `cloud-login`, `cloud-logout`,
  `cloud-rotate-token`, `cloud-status`, `cloud-pair-phone` and `set-cloud-mode`. The
  header shows `☁ <hostname>` while the machine is online, `☁ connecting…` while it
  comes up, `☁ downloading…` while it fetches `cloudflared`, and `☁ revoked` or
  `☁ failed` when something needs you (and `☁ not paired` with `mode = "yes"`).
- **In the browser**, the cog menu's **Yaran Cloud…** opens a dialog with **Connect**,
  **Rotate token…** and **Disconnect…**, and **Connect a phone…** shows the QR code. The
  cloud mode is a row in **Preferences…**.

Rotating the consent key is in the command line only.

## What logout does

`yaran cloud logout` asks first, naming the machine's address. Then:

1. It asks the control plane to unpair the machine. The control plane removes the
   machine's DNS record first, then its tunnel, then its Access application and policy,
   so the address stops resolving before anything that protects it goes away.
2. It deletes the credentials on this machine, and the running connection stops.

If the control plane cannot be reached, logout refuses. `--local-only` deletes the local
credentials anyway, and warns you that the tunnel token stays valid until an admin
removes the machine in the console.

## When the machine is revoked

If an admin revokes the machine, yaran stops the connection and shows a warning that
stays until you act:

> Yaran Cloud revoked `<hostname>`; remote access is off. Run `yaran cloud login <org>`
> to pair again.

Phone notifications from this machine stop too. The local loopback and Tailscale
listeners are unaffected. Run `yaran cloud login` again to pair it, if your admin allows.

## Where your credentials live

The pairing, the tunnel token, the machine's private signing key and its consent key
live in `cloud/credentials.json` inside your yaran directory, with a copy of the tunnel
token that `cloudflared` reads beside it (`~/.yaran/` on macOS,
`~/.config/yaran/` on Linux). The `cloud` folder is readable by you only, and the file
is too. None of it is ever written to `config.toml` or `[env]`, so the raw-config editor
and `yaran config diff --raw` never show it.

> [!CAUTION]
> Anything running as your user account can read that file, as it can read the rest of
> your yaran directory. Treat the machine's account as the boundary, as yaran always
> has.

## The cloudflared yaran runs

By default yaran downloads one pinned version of Cloudflare's `cloudflared` from
Cloudflare's GitHub releases, checks it against checksums built into yaran, and keeps it
in `cloud/bin/` inside your yaran directory. It checks the binary again every time it
starts it, and refuses to run one that does not match. It downloads nothing until this
machine is paired and the connection should run. Supported: Linux and macOS, on x86_64
and aarch64.

To use your own `cloudflared` instead, set `cloudflared_path`. It must be version
2026.11.0 or newer, which yaran checks, because older versions cannot enforce Access on
the machine's route. yaran does not checksum a binary you supply; keeping it trustworthy
is up to you. A `cloudflared` on your `PATH` is ignored unless you configure it.

yaran never lets `cloudflared` update itself, and its metrics address listens on
loopback only.

## The `[cloud]` config keys

Every key carries a full inline comment in your `config.toml`, and every key applies
without restarting yaran. The `cloudflared` settings take effect the next time the
connection starts.

| Key | Default | What it does |
|---|---|---|
| `mode` | `"auto"` | `"auto"` runs the connection whenever this machine is paired and yaran is serving, and follows login and logout live. `"yes"` is the same, but warns when yaran serves while unpaired and keeps failures on screen. `"no"` never runs it and keeps the credentials |
| `org_url` | `""` | The org address `yaran cloud login` and `pair-phone` use when you give none |
| `push_notifications` | `true` | Send phone notifications when an agent needs you. Independent of `[ui] attention_indicator`. Turning it off withdraws nothing already delivered |
| `push_coalesce_seconds` | `2` | An agent that stops needing you within this many seconds sends nothing. `0` sends every change at once; at most 300 |
| `push_offline_ttl_seconds` | `600` | How long notifications wait while the control plane is unreachable before they are dropped (30 to 86400) |
| `cloudflared_path` | `""` | Empty: yaran downloads its pinned, checksum-verified `cloudflared`. A path: use that binary (2026.11.0 or newer) |
| `metrics_port` | `0` | The loopback port for `cloudflared`'s metrics. `0` picks a free port at each start |
| `grace_period_seconds` | `5` | How long `cloudflared` gets to finish requests when it stops (at most 180) |
| `restart_backoff_initial_ms` | `1000` | First wait before restarting a `cloudflared` that exited |
| `restart_backoff_max_ms` | `60000` | Longest wait between restarts |
| `restart_backoff_jitter_ms` | `1000` | Random spread added to each wait |
| `cloudflared_loglevel` | `"info"` | `cloudflared`'s log level. `"debug"` logs request headers, including your Access cookie |
| `management_diagnostics` | `false` | Allow Cloudflare's remote diagnostics for this tunnel |
| `unauthorized_confirm_seconds` | `60` | How long Cloudflare must keep refusing the tunnel before yaran checks whether the machine was revoked |
| `login_timeout_seconds` | `900` | How long `yaran cloud login` waits for the browser |
| `request_timeout_seconds` | `15` | Timeout for each call to the control plane |
| `app_callback_urls` | the official app's sign-in link | Where phone sign-ins may hand back to. Empty in a build of yaran made without a publisher domain |
| `access_clock_skew_seconds` | `30` | Clock difference tolerated when checking an Access sign-in. Raise it on a machine with poor time sync |
| `access_jwks_refresh_seconds` | `14400` | How often yaran refreshes Cloudflare Access's signing keys |
| `access_jwks_retry_cooldown_seconds` | `30` | How long yaran waits before retrying a failed key fetch |
| `handoff_requests_per_minute` | `12` | How many phone sign-ins this machine accepts per minute |
| `close_sockets_at_access_expiry` | `true` | Close open terminal connections when the Access sign-in behind them expires |

## Where to go next

- [The phone app](/docs/mobile-apps): scan the QR code from `yaran cloud pair-phone`.
- [Push notifications](/docs/push-notifications): what reaches your phone and when.
- [Troubleshooting Cloud Connect](/docs/cloud-troubleshooting).
