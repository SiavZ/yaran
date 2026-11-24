---
title: Supported agents
description: The five agents yaran ships wired in, what each one can and cannot do inside yaran, and how to add any other CLI.
group: Getting started
order: 1.5
---

yaran runs an agent the way you would in a terminal: it starts the CLI in your agent's
working copy and shows you its screen. Five agents come wired in, with a provider entry
each in `config.toml`, and `claude` is the default for new agents until you pick another.

> [!TIP]
> yaran works with any agent. If a CLI runs in a terminal, yaran can run it: add a
> `[providers.<name>]` block with its `command` to `config.toml` and it shows up in the
> place yaran lets you pick a provider, like the five below. No adapters, no plugins. See
> [Custom CLI agents](/docs/custom-agents).

## What every agent gets

The same treatment, whichever CLI is behind the agent:

- Its own git worktree and branch, or a folder you already have for a standalone agent.
- The mouse wheel forwarded to it whenever it asks for the mouse, and page keys when it
  takes over the whole screen.
- Files dropped or pasted onto its pane land in the worktree and the path is typed for it.
- Several tabs in one worktree, each its own provider session with its own conversation.

Where the agents differ is in resuming, in how they announce that they need you, and in
how they read a pasted path. That is what the table and notes below cover.

| Agent | Command | Resumes its conversation | Attention signal |
|---|---|---|---|
| Claude Code | `claude` | Yes, per worktree | Yes, out of the box |
| Codex | `codex` | Yes, per worktree | After a one-line setting |
| OpenCode | `opencode` | Yes, per worktree | No signal today |
| Copilot | `copilot` | Never | Progress yes, finished turn after a setting |
| Grok | `grok` | Yes, per worktree | Not verified yet |

When an agent's CLI is missing, yaran says so and prints its install line for you:

- **Claude Code:** `curl -fsSL https://claude.ai/install.sh | bash`
- **Codex:** `brew install --cask codex`
- **OpenCode:** `curl -fsSL https://opencode.ai/install | bash`
- **Copilot:** `curl -fsSL https://gh.io/copilot-install | bash`
- **Grok:** `curl -fsSL https://x.ai/cli/install.sh | bash`

## Claude Code

The default provider.

- **Resume:** reopen a stopped agent and Claude continues the conversation it had in
  that worktree.
- **Needs-you indicator:** works with no setup. If yours stays dark, set
  `preferredNotifChannel: "terminal_bell"` in Claude's own settings.
- **Pasted paths:** handed over exactly as written. Claude strips one pair of quotes and
  then unescapes, so quoting would only corrupt an apostrophe in the path.

## Codex

- **Resume:** per worktree, on a recent enough Codex build.
- **Needs-you indicator:** set `tui.notification_method` in Codex's config to any value
  to light up yaran's attention indicators.
- **Pasted paths:** single-quoted, because Codex reads its input like a shell and takes
  only one token: a bare path with a space in it would fail silently.
- **Attachment length:** Codex accepts at most 1000 characters in one attachment. Past
  that, yaran still saves the file and shows you its full path to reference yourself,
  rather than sending something Codex would silently ignore.

## OpenCode

- **Resume:** per worktree. If resuming hangs before OpenCode shows anything, yaran waits
  three seconds, then starts it fresh instead of leaving you with a blank screen.
- **Needs-you indicator:** none that yaran can see today, because its notifications go
  through plugins. Its rows never light up on their own; when a future version rings a
  bell, yaran picks it up with no change on your side.
- **Pasted paths:** go in as written.

## Copilot

> [!IMPORTANT]
> Copilot never resumes. Its own `--continue` picks up the most recent conversation from
> anywhere on your machine, not the one that belongs to this worktree, so resuming could
> reattach to a different project's conversation. Every Copilot tab starts fresh.

- **Progress:** Copilot reports it on its own, so the working spinner is accurate with
  no setup.
- **Needs-you indicator:** its finished-turn bell ships switched off (since v1.0.55), so
  turn the terminal bell back on in Copilot's config if you want a completed turn
  flagged.
- **Pasted paths:** go in as written. Copilot is closed source, so that form is the safe
  default rather than a measured one, and `web_dragdrop_paste` in its provider block
  changes it if your version wants quoting.

## Grok

xAI's Grok CLI, started as `grok`. yaran treats it like Claude Code, because Grok has been
seen behaving like it inside yaran. The pasted-path form and how a running tab handles a
recreated working copy have not been measured separately for Grok.

- **Sign-in:** Grok asks you to sign in the first time it runs. Run `grok login` in a
  terminal if you would rather do it ahead of time. When you drive a remote yaran, the first-run
  sign-in opens a browser on the server, so run `grok login --device-auth` instead.
- **Resume:** reopen a stopped agent and Grok continues the most recent conversation for
  that worktree's directory, using its own `--continue`. If resuming hangs before Grok
  shows anything, yaran waits three seconds, then starts it fresh.
- **Needs-you indicator:** not verified yet, so its rows may not light up on their own.
- **Pasted paths:** go in as written, the form yaran uses for Claude Code. That is assumed
  rather than measured for Grok, and `web_dragdrop_paste` in its provider block
  changes it if your version wants quoting.
- **Your own block:** a `[providers.grok]` you wrote yourself keeps every key you set. If
  you run a different CLI named `grok`, set `resume_args = []` (or its own resume flags),
  because yaran fills in `--continue` otherwise.

## Bulk model changes in jcode

In the terminal UI, run `change-jcode-models` from the command palette. In the web UI,
choose **Change jcode models…** from the app menu. Enter a model ID, tick the jcodes
you want, or select all running jcodes, then apply. Use `jcode model list` to find
model IDs. Conversations and drafts stay in place, and each failed change is reported.
Stopped tabs are not changed.

jcode's model indicator may need a tab reconnect to refresh after a bulk change.

> [!IMPORTANT]
> Enable `debug_socket = true` under `[display]` in jcode's configuration, then reload
> its server. This enables jcode's local control commands for other programs running
> as your Unix user. Yaran does not enable it for you. If a tab cannot be identified,
> focus that jcode tab once and retry; older jcode versions may need an update.

Jcodes sharing a folder are identified by their client processes, including extra
provider tabs. SSH clients are not supported by the bulk switcher. If a change times
out, check the model inside jcode before retrying: the request may still complete.

## Changing any of this

Every value above is a setting in the provider's `[providers.<name>]` block: the command
and its arguments, the resume arguments, how a pasted path is quoted, and whether scrolling
is forwarded. The config file explains each key inline, and
[Custom CLI agents](/docs/custom-agents) walks through adding a new one.
