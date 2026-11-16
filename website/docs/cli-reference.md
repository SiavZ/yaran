---
title: Command line reference
description: Every yaran command, subcommand, argument and flag, with the same help text --help prints.
group: Reference
order: 90
editSource: crates/yaran/src/commands.rs
---

<!-- Generated from the yaran command line's own definitions; do not edit by hand. The help of the `yaran config` subcommands is defined in crates/yaran-tui/src/config_spec.rs. -->

Every command yaran has, with the same text `yaran <command> --help` prints. For how the
commands fit together, and examples, see [The command line](/docs/command-line).

## Flags every command takes

| Flag | Value | Description |
|---|---|---|
| `--remote` | `<NAME>` | Talk to this saved remote instead of the local yaran. |
| `--local` |  | Talk to the yaran on this machine, whatever a saved default says. |
| `-h`, `--help` | | Print the help for the command. |
| `-V`, `--version` | | Print the version; `yaran` alone takes it. |

`yaran config` is the exception: it reads `--local` only before the word `config`, and it refuses `--remote` (and any selected remote) unless `--local` is given, because it always edits this machine's file.

## Environment variables

| Variable | Description |
|---|---|
| `YARAN_HOME` | Override the config directory (must be an absolute path). When unset, defaults to:<br>macOS: \~/.yaran/<br>Linux: $XDG_CONFIG_HOME/yaran/ or \~/.config/yaran/ |
| `YARAN_REMOTE` | The saved remote to talk to when neither `--remote` nor `--local` is given. It wins over the default set with `yaran remote default`. |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | the change failed, or what was named does not exist |
| `2` | the command line is wrong |
| `3` | refused: someone is attached, another change is in the way, or the change was not confirmed |
| `4` | yaran isn't running, or does not answer |
| `5` | the remote asks for its password; sign in with `yaran remote login` |
| `6` | the outcome is unknown: the wait ran out, and the change keeps running |

## `yaran`

Terminal and web UI for AI worktree sessions, and a command line for their state. Run with no command to launch the terminal UI.

```text
yaran [OPTIONS] [COMMAND]
```

- [`yaran server`](#yaran-server): Serve the web UI without the terminal UI, or inspect a running server.
- [`yaran config`](#yaran-config): Manage the configuration file on this machine.
- [`yaran projects`](#yaran-projects): Projects yaran knows about.
- [`yaran agents`](#yaran-agents): Agents, their tabs and their worktrees.
- [`yaran terminals`](#yaran-terminals): Terminals, project-owned, agent-owned and standalone.
- [`yaran macros`](#yaran-macros): Macros from config.toml.
- [`yaran providers`](#yaran-providers): Providers from config.toml.
- [`yaran keys`](#yaran-keys): Keybindings from config.toml.
- [`yaran themes`](#yaran-themes): Themes yaran can load.
- [`yaran env`](#yaran-env): The global environment from config.toml.
- [`yaran remote`](#yaran-remote): Saved remote yaranes and the sign-ins for them.
- [`yaran operations`](#yaran-operations): Look up a change that was started earlier.
- [`yaran doctor`](#yaran-doctor): Print a diagnostic dump of this machine's yaran (`--json`, `--anonymize`).
- [`yaran session`](#yaran-session): Permanently purge an agent's stored data (`yaran session --help`).
- [`yaran peer`](#yaran-peer): Route messages between agent sessions (`yaran peer --help` for send, list, sync-amq).
- [`yaran board`](#yaran-board): Post cards for the person running yaran, or resolve them (`yaran board --help`).
- [`yaran cloud`](#yaran-cloud): Connect this machine to Yaran Cloud for your phone (`yaran cloud --help`).

## `yaran server`

Serve the web UI without the terminal UI, or inspect a running server.

Run the yaran web UI without the terminal UI. The web UI has one optional
password for one owner, and everyone who gets in shares the one workspace. Set
it with `yaran config set server.auth.password`; [server.auth] require decides
who is asked for it (by default everyone but this machine and your tailnet).
With no password, anyone who can reach a non-loopback address controls your
agents and terminals, and yaran says so loudly as it starts.

```text
yaran server [OPTIONS] [COMMAND]
```

| Flag | Value | Description |
|---|---|---|
| `--bind` | `<ADDR:PORT>` | Bind this exact address, overriding [server] host and port. An IP:port address (hostnames are NOT resolved), e.g. 0.0.0.0:3890. |
| `--port` | `<PORT>` | Override [server] port only (ignored when `--bind` is set). yaran binds host:port, and the machine's Tailscale address unless disabled. |
| `--no-tailscale` |  | Skip Tailscale detection this run (serve the configured host only). |

- [`yaran server logs`](#yaran-server-logs): Show the server's log: the last lines of server.log, read from the file when yaran is not running.
- [`yaran server connections`](#yaran-server-connections): The connections attached to the server.

### `yaran server logs`

Show the server's log: the last lines of server.log, read from the file when yaran is not running.

```text
yaran server logs [OPTIONS]
```

| Flag | Value | Description |
|---|---|---|
| `-f`, `--follow` |  | Keep printing new lines as they are written, until interrupted. |
| `--lines` | `<N>` | How many of the last lines to start from. Default: `100`. |

### `yaran server connections`

The connections attached to the server.

```text
yaran server connections [OPTIONS] <COMMAND>
```

- [`yaran server connections ls`](#yaran-server-connections-ls): List the connections.

### `yaran server connections ls`

Also: `list`

List the connections.

```text
yaran server connections ls [OPTIONS]
```

| Flag | Value | Description |
|---|---|---|
| `--format` | `<FORMAT>` | How to print the list: `table` to read, `json` for a script. One of `table`, `json`. Default: `table`. |
| `-q`, `--quiet` |  | Print only the ids, one per line. |

## `yaran config`

Manage the yaran configuration file.

```text
yaran config <COMMAND>
```

- [`yaran config path`](#yaran-config-path): Print the config file path.
- [`yaran config get`](#yaran-config-get): Print one setting's value, for example `yaran config get server.port`.
- [`yaran config set`](#yaran-config-set): Change one setting, keeping the file's comments, and have a running yaran reload, saying whether it worked (exit 1 if it refused or half applied, 6 if it gave no answer in time).
- [`yaran config diff`](#yaran-config-diff): Show settings that differ from defaults (summary; [env] and project details are summarized, never printed, so it is safe to paste into a bug report).
- [`yaran config reset`](#yaran-config-reset): Remove config, logs and saved remotes (keeps agents and worktrees).
- [`yaran config regenerate`](#yaran-config-regenerate): Preview a fresh default config (shows diff; [env] and other sensitive values are hidden unless you add `--show`).
- [`yaran config restore-docs`](#yaran-config-restore-docs): Preview re-adding the explanatory comments to your config, keeping every value you have set (hides values like regenerate; `--show` reveals them).

### `yaran config path`

Print the config file path.

```text
yaran config path
```

### `yaran config get`

Print one setting's value, for example `yaran config get server.port`.

```text
yaran config get [OPTIONS] <SETTING>
```

| Argument | Description |
|---|---|
| `<SETTING>` | Required. The setting's dotted name, for example `server.port`. |

| Flag | Value | Description |
|---|---|---|
| `--show` |  | Values that can hold secrets (env, projects) need `--show`. |

### `yaran config set`

Change one setting, keeping the file's comments, and have a running yaran reload, saying whether it worked (exit 1 if it refused or half applied, 6 if it gave no answer in time).

`yaran config set server.auth.password` sets the web UI password: asked for twice without echo, with a strength meter. Never a command-line argument; add `--stdin` to pipe it in instead. env.\<NAME\> values are asked for the same way.

```text
yaran config set [OPTIONS] <SETTING> [VALUE]
```

| Argument | Description |
|---|---|
| `<SETTING>` | Required. The setting's dotted name, for example `server.port`. |
| `<VALUE>` | Optional. The new value. Lists are one TOML array: `'["a", "b"]'`. A value that starts with two dashes goes after `--`. Left out for the password and env.\<NAME\> values, which are asked for. |

| Flag | Value | Description |
|---|---|---|
| `--stdin` |  | Pipe the password or an env.\<NAME\> value in instead of being asked for it. |

### `yaran config diff`

Show settings that differ from defaults (summary; [env] and project details are summarized, never printed, so it is safe to paste into a bug report).

```text
yaran config diff [OPTIONS]
```

| Flag | Value | Description |
|---|---|---|
| `--raw` |  | Show a unified diff against the default config. This prints the WHOLE config, [env] values included: redact it before sharing. |

### `yaran config reset`

Remove config, logs and saved remotes (keeps agents and worktrees).

```text
yaran config reset [OPTIONS]
```

| Flag | Value | Description |
|---|---|---|
| `--all` |  | Full factory reset: remove config, logs, saved remotes, sessions, and worktrees (deletes nothing if a program yaran started still runs). Fails closed: a config, agent row or project inventory that cannot be read stops it before any change; repair the named file or row, then retry. |

### `yaran config regenerate`

Preview a fresh default config (shows diff; [env] and other sensitive values are hidden unless you add `--show`).

```text
yaran config regenerate [OPTIONS]
```

| Flag | Value | Description |
|---|---|---|
| `--yes` |  | Overwrite the config file with fresh defaults. |
| `--show` |  | Show [env] and other sensitive values in the preview. |

### `yaran config restore-docs`

Preview re-adding the explanatory comments to your config, keeping every value you have set (hides values like regenerate; `--show` reveals them).

```text
yaran config restore-docs [OPTIONS]
```

| Flag | Value | Description |
|---|---|---|
| `--yes` |  | Apply it (writes a timestamped backup first). |
| `--show` |  | Show the hidden values in the preview. |

## `yaran projects`

Projects yaran knows about.

```text
yaran projects [OPTIONS] <COMMAND>
```

- [`yaran projects ls`](#yaran-projects-ls): List projects.
- [`yaran projects show`](#yaran-projects-show): Show one project.
- [`yaran projects add`](#yaran-projects-add): Add a project from a path and print its id last.
- [`yaran projects rm`](#yaran-projects-rm): Remove a project. Its agents' worktrees stay on disk unless `--delete-worktrees` is given.
- [`yaran projects worktrees`](#yaran-projects-worktrees): The worktrees of a project.

### `yaran projects ls`

Also: `list`

List projects.

```text
yaran projects ls [OPTIONS]
```

| Flag | Value | Description |
|---|---|---|
| `--format` | `<FORMAT>` | How to print the list: `table` to read, `json` for a script. One of `table`, `json`. Default: `table`. |
| `-q`, `--quiet` |  | Print only the ids, one per line. |

### `yaran projects show`

Show one project.

```text
yaran projects show [OPTIONS] <PROJECT>
```

| Argument | Description |
|---|---|
| `<PROJECT>` | Required. A project's id or name; a name two projects share is refused with both ids. |

### `yaran projects add`

Add a project from a path and print its id last.

```text
yaran projects add [OPTIONS] <PATH>
```

| Argument | Description |
|---|---|
| `<PATH>` | Required. The folder of the repository to add, on the machine yaran runs on. |

| Flag | Value | Description |
|---|---|---|
| `--name` | `<NAME>` | The project's name (the folder's name by default). |
| `--checkout-default` |  | Check the repository's default branch out first. |
| `--init` |  | Make a plain folder a git repository first, with a first commit. |
| `--yes` |  | Do not ask for confirmation (required without a terminal). |
| `--no-wait` |  | Print the operation id and return without waiting for the change. |
| `--wait-timeout` | `<SECONDS>` | Wait at most this many seconds for the change to finish (at most a day). Not with `--no-wait`. |

### `yaran projects rm`

Also: `remove`

Remove a project. Its agents' worktrees stay on disk unless `--delete-worktrees` is given.

```text
yaran projects rm [OPTIONS] <PROJECT>
```

| Argument | Description |
|---|---|
| `<PROJECT>` | Required. A project's id or name; a name two projects share is refused with both ids. |

| Flag | Value | Description |
|---|---|---|
| `--delete-worktrees` |  | Also delete its agents and their worktrees. |
| `--yes` |  | Do not ask for confirmation (required without a terminal). |
| `--no-wait` |  | Print the operation id and return without waiting for the change. |
| `--wait-timeout` | `<SECONDS>` | Wait at most this many seconds for the change to finish (at most a day). Not with `--no-wait`. |
| `--dangerously-ignore-connected` |  | Go ahead even though someone is attached. |

### `yaran projects worktrees`

The worktrees of a project.

```text
yaran projects worktrees [OPTIONS] <COMMAND>
```

- [`yaran projects worktrees ls`](#yaran-projects-worktrees-ls): List a project's worktrees.

### `yaran projects worktrees ls`

Also: `list`

List a project's worktrees.

```text
yaran projects worktrees ls [OPTIONS] <PROJECT>
```

| Argument | Description |
|---|---|
| `<PROJECT>` | Required. A project's id or name; a name two projects share is refused with both ids. |

| Flag | Value | Description |
|---|---|---|
| `--format` | `<FORMAT>` | How to print the list: `table` to read, `json` for a script. One of `table`, `json`. Default: `table`. |
| `-q`, `--quiet` |  | Print only the ids, one per line. |

## `yaran agents`

Agents, their tabs and their worktrees.

```text
yaran agents [OPTIONS] <COMMAND>
```

- [`yaran agents ls`](#yaran-agents-ls): List agents.
- [`yaran agents show`](#yaran-agents-show): Show one agent.
- [`yaran agents add`](#yaran-agents-add): Create an agent and print its id last.
- [`yaran agents rm`](#yaran-agents-rm): Delete an agent. With no branch flag, only the branch yaran made for the agent goes with the worktree, and only while yaran can prove it is still that branch; every other branch is kept.
- [`yaran agents stop`](#yaran-agents-stop): Stop everything an agent runs.
- [`yaran agents start`](#yaran-agents-start): Start an agent.
- [`yaran agents tabs`](#yaran-agents-tabs): An agent's provider tabs.
- [`yaran agents prs`](#yaran-agents-prs): An agent's pull requests: the ones yaran found on the branches its worktree has been on, and the ones you attached from any repository.

### `yaran agents ls`

Also: `list`

List agents.

```text
yaran agents ls [OPTIONS]
```

| Flag | Value | Description |
|---|---|---|
| `--project` | `<PROJECT>` | Only the agents of this project. |
| `--worktrees` |  | Print only each agent's id and the folder it works in. |
| `--format` | `<FORMAT>` | How to print the list: `table` to read, `json` for a script. One of `table`, `json`. Default: `table`. |
| `-q`, `--quiet` |  | Print only the ids, one per line. |

### `yaran agents show`

Show one agent.

```text
yaran agents show [OPTIONS] <AGENT>
```

| Argument | Description |
|---|---|
| `<AGENT>` | Required. An agent's id or name; a name two agents share is refused with both ids. |

### `yaran agents add`

Create an agent and print its id last.

```text
yaran agents add [OPTIONS] <--project <PROJECT>|--fork <AGENT>|--standalone <FOLDER>|--from-pr <PR>>
```

| Flag | Value | Description |
|---|---|---|
| `--project` | `<PROJECT>` | The project to create the agent in, on a new branch unless `--from-pr` or `--from-worktree` says otherwise. Not with `--fork` or `--standalone`. |
| `--name` | `<NAME>` | The agent's name, which is also its branch's name in a project. |
| `--existing-branch` |  | Create the agent on the branch of that name that already exists. Not with `--from-pr`, `--from-worktree`, `--fork` or `--standalone`. |
| `--from-pr` | `<PR>` | Create the agent from this pull request: a number or its address with `--project`, or an address or owner/repo#123 alone, which clones the repository (or adds a checkout of it) when no project has it. Not with `--from-worktree`, `--fork` or `--standalone`. |
| `--path` | `<FOLDER>` | The folder to clone the pull request's repository into, or the existing checkout of it to add as a project, when no project has it. By default the server's project-browser start folder plus the repository's name. Needs `--from-pr`, and not with `--project`. |
| `--review-copy` |  | Agree to a separate review copy of the pull request when its own branch cannot be used as it is (it has diverged, is checked out elsewhere, or could not be compared). Without this such a create is refused and nothing is made, because pushes from a copy land on the copy's branch and not on the pull request. Needs `--from-pr`. |
| `--from-worktree` | `<PATH>` | Create the agent on this worktree the project already has. Needs `--project`. |
| `--standalone` | `<FOLDER>` | Create a standalone agent in this folder of your own, with no project. Not with `--fork`. |
| `--provider` | `<NAME>` | The provider a standalone agent runs (the global default otherwise). Not with `--project`, `--fork` or `--from-pr`. |
| `--fork` | `<AGENT>` | Fork this agent: a new worktree from its branch. |
| `--copy-uncommitted` |  | Copy the uncommitted changes of the project's checkout into the new worktree. Not with `--from-pr`, `--from-worktree`, `--fork` or `--standalone`. |
| `--yes` |  | Do not ask for confirmation (required without a terminal). |
| `--no-wait` |  | Print the operation id and return without waiting for the change. |
| `--wait-timeout` | `<SECONDS>` | Wait at most this many seconds for the change to finish (at most a day). Not with `--no-wait`. |

### `yaran agents rm`

Also: `remove`

Delete an agent. With no branch flag, only the branch yaran made for the agent goes with the worktree, and only while yaran can prove it is still that branch; every other branch is kept.

```text
yaran agents rm [OPTIONS] <AGENT>
```

| Argument | Description |
|---|---|
| `<AGENT>` | Required. An agent's id or name; a name two agents share is refused with both ids. |

| Flag | Value | Description |
|---|---|---|
| `--delete-worktree` |  | Also remove the agent's worktree. |
| `--delete-branch` |  | Delete the branch its worktree is on, at the commit it points at now. Needs `--delete-worktree`: git will not delete a branch a worktree still has checked out. Not with `--keep-branch`. |
| `--keep-branch` |  | Keep the branch its worktree is on. With `--delete-worktree`, the other branches it has been on are still decided as the delete dialog would tick them, unless `--keep-other-branches` or `--delete-other-branches` says otherwise. |
| `--delete-other-branches` |  | Delete every other branch its worktree has been on, each at the commit it points at now. Needs `--delete-worktree`, and not with `--keep-other-branches`. |
| `--keep-other-branches` |  | Keep every other branch its worktree has been on. With `--delete-worktree`, the branch it is on now is still decided as the delete dialog would tick it, unless `--keep-branch` or `--delete-branch` says otherwise. |
| `--yes` |  | Do not ask for confirmation (required without a terminal). |
| `--no-wait` |  | Print the operation id and return without waiting for the change. |
| `--wait-timeout` | `<SECONDS>` | Wait at most this many seconds for the change to finish (at most a day). Not with `--no-wait`. |
| `--dangerously-ignore-connected` |  | Go ahead even though someone is attached. |

### `yaran agents stop`

Stop everything an agent runs.

```text
yaran agents stop [OPTIONS] <AGENT>
```

| Argument | Description |
|---|---|
| `<AGENT>` | Required. An agent's id or name; a name two agents share is refused with both ids. |

| Flag | Value | Description |
|---|---|---|
| `--yes` |  | Do not ask for confirmation (required without a terminal). |
| `--no-wait` |  | Print the operation id and return without waiting for the change. |
| `--wait-timeout` | `<SECONDS>` | Wait at most this many seconds for the change to finish (at most a day). Not with `--no-wait`. |
| `--dangerously-ignore-connected` |  | Go ahead even though someone is attached. |

### `yaran agents start`

Start an agent.

```text
yaran agents start [OPTIONS] <AGENT>
```

| Argument | Description |
|---|---|
| `<AGENT>` | Required. An agent's id or name; a name two agents share is refused with both ids. |

| Flag | Value | Description |
|---|---|---|
| `--yes` |  | Do not ask for confirmation (required without a terminal). |
| `--no-wait` |  | Print the operation id and return without waiting for the change. |
| `--wait-timeout` | `<SECONDS>` | Wait at most this many seconds for the change to finish (at most a day). Not with `--no-wait`. |

### `yaran agents tabs`

An agent's provider tabs.

```text
yaran agents tabs [OPTIONS] <COMMAND>
```

- [`yaran agents tabs ls`](#yaran-agents-tabs-ls): List an agent's tabs.
- [`yaran agents tabs add`](#yaran-agents-tabs-add): Add a tab to an agent.
- [`yaran agents tabs rm`](#yaran-agents-tabs-rm): Close a tab.
- [`yaran agents tabs start`](#yaran-agents-tabs-start): Start a tab.
- [`yaran agents tabs stop`](#yaran-agents-tabs-stop): Stop a tab.

### `yaran agents tabs ls`

Also: `list`

List an agent's tabs.

```text
yaran agents tabs ls [OPTIONS] <AGENT>
```

| Argument | Description |
|---|---|
| `<AGENT>` | Required. An agent's id or name; a name two agents share is refused with both ids. |

| Flag | Value | Description |
|---|---|---|
| `--format` | `<FORMAT>` | How to print the list: `table` to read, `json` for a script. One of `table`, `json`. Default: `table`. |
| `-q`, `--quiet` |  | Print only the ids, one per line. |

### `yaran agents tabs add`

Add a tab to an agent.

```text
yaran agents tabs add [OPTIONS] <AGENT>
```

| Argument | Description |
|---|---|
| `<AGENT>` | Required. An agent's id or name; a name two agents share is refused with both ids. |

| Flag | Value | Description |
|---|---|---|
| `--provider` | `<NAME>` | The provider the tab runs (the project's by default). |
| `--yes` |  | Do not ask for confirmation (required without a terminal). |
| `--no-wait` |  | Print the operation id and return without waiting for the change. |
| `--wait-timeout` | `<SECONDS>` | Wait at most this many seconds for the change to finish (at most a day). Not with `--no-wait`. |

### `yaran agents tabs rm`

Also: `remove`

Close a tab.

```text
yaran agents tabs rm [OPTIONS] <AGENT> <TAB>
```

| Argument | Description |
|---|---|
| `<AGENT>` | Required. An agent's id or name; a name two agents share is refused with both ids. |
| `<TAB>` | Required. A tab's id or the label the tab strip shows it under. |

| Flag | Value | Description |
|---|---|---|
| `--yes` |  | Do not ask for confirmation (required without a terminal). |
| `--no-wait` |  | Print the operation id and return without waiting for the change. |
| `--wait-timeout` | `<SECONDS>` | Wait at most this many seconds for the change to finish (at most a day). Not with `--no-wait`. |
| `--dangerously-ignore-connected` |  | Go ahead even though someone is attached. |

### `yaran agents tabs start`

Start a tab.

```text
yaran agents tabs start [OPTIONS] <AGENT> <TAB>
```

| Argument | Description |
|---|---|
| `<AGENT>` | Required. An agent's id or name; a name two agents share is refused with both ids. |
| `<TAB>` | Required. A tab's id or the label the tab strip shows it under. |

| Flag | Value | Description |
|---|---|---|
| `--yes` |  | Do not ask for confirmation (required without a terminal). |
| `--no-wait` |  | Print the operation id and return without waiting for the change. |
| `--wait-timeout` | `<SECONDS>` | Wait at most this many seconds for the change to finish (at most a day). Not with `--no-wait`. |

### `yaran agents tabs stop`

Stop a tab.

```text
yaran agents tabs stop [OPTIONS] <AGENT> <TAB>
```

| Argument | Description |
|---|---|
| `<AGENT>` | Required. An agent's id or name; a name two agents share is refused with both ids. |
| `<TAB>` | Required. A tab's id or the label the tab strip shows it under. |

| Flag | Value | Description |
|---|---|---|
| `--yes` |  | Do not ask for confirmation (required without a terminal). |
| `--no-wait` |  | Print the operation id and return without waiting for the change. |
| `--wait-timeout` | `<SECONDS>` | Wait at most this many seconds for the change to finish (at most a day). Not with `--no-wait`. |
| `--dangerously-ignore-connected` |  | Go ahead even though someone is attached. |

### `yaran agents prs`

An agent's pull requests: the ones yaran found on the branches its worktree has been on, and the ones you attached from any repository.

```text
yaran agents prs [OPTIONS] <COMMAND>
```

- [`yaran agents prs ls`](#yaran-agents-prs-ls): List an agent's pull requests in its order, the one its banner shows first, then the hidden ones. Each row's id is the pull request's link, which every other `prs` command accepts.
- [`yaran agents prs attach`](#yaran-agents-prs-attach): Attach a pull request to an agent, beside the ones it has. It can come from any repository, and stays until you detach it.
- [`yaran agents prs detach`](#yaran-agents-prs-detach): Detach a pull request you attached. One yaran also found on the agent's branches stays in the list, as found.
- [`yaran agents prs hide`](#yaran-agents-prs-hide): Hide a pull request yaran found, until you unhide it. It keeps its place in your own order.
- [`yaran agents prs unhide`](#yaran-agents-prs-unhide): Show a hidden pull request again, in the place it had.
- [`yaran agents prs sort`](#yaran-agents-prs-sort): Choose how an agent's pull requests are ordered. Your own order is kept while the order is automatic, so choosing `manual` again brings it back.
- [`yaran agents prs move`](#yaran-agents-prs-move): Move one of an agent's shown pull requests in its order. A move made while the order is automatic switches to your own order, starting from the order it was in, and replaces any order you had saved.
- [`yaran agents prs branches`](#yaran-agents-prs-branches): List every branch an agent's worktree has been on, the one checked out now first and the rest newest first, with the names each had before a rename and its pull requests, then the pull requests that are on none of them: the ones you attached, and any yaran found on a branch not listed.

### `yaran agents prs ls`

Also: `list`

List an agent's pull requests in its order, the one its banner shows first, then the hidden ones. Each row's id is the pull request's link, which every other `prs` command accepts.

```text
yaran agents prs ls [OPTIONS] <AGENT>
```

| Argument | Description |
|---|---|
| `<AGENT>` | Required. An agent's id or name; a name two agents share is refused with both ids. |

| Flag | Value | Description |
|---|---|---|
| `--format` | `<FORMAT>` | How to print the list: `table` to read, `json` for a script. One of `table`, `json`. Default: `table`. |
| `-q`, `--quiet` |  | Print only the ids, one per line. |

### `yaran agents prs attach`

Attach a pull request to an agent, beside the ones it has. It can come from any repository, and stays until you detach it.

```text
yaran agents prs attach [OPTIONS] <AGENT> <REF>
```

| Argument | Description |
|---|---|
| `<AGENT>` | Required. An agent's id or name; a name two agents share is refused with both ids. |
| `<REF>` | Required. The pull request: its link, `owner/repo#123`, or just `123` (or `'#123'`, quoted, since a shell reads a word starting with `#` as a comment) in the agent's own repository. |

| Flag | Value | Description |
|---|---|---|
| `--yes` |  | Do not ask for confirmation (required without a terminal). |
| `--no-wait` |  | Print the operation id and return without waiting for the change. |
| `--wait-timeout` | `<SECONDS>` | Wait at most this many seconds for the change to finish (at most a day). Not with `--no-wait`. |

### `yaran agents prs detach`

Detach a pull request you attached. One yaran also found on the agent's branches stays in the list, as found.

```text
yaran agents prs detach [OPTIONS] <AGENT> <REF>
```

| Argument | Description |
|---|---|
| `<AGENT>` | Required. An agent's id or name; a name two agents share is refused with both ids. |
| `<REF>` | Required. One of the agent's pull requests: its link, `owner/repo#123`, or just `123` (or `'#123'`, quoted, since a shell reads a word starting with `#` as a comment); a number two of them share is refused with both links. |

| Flag | Value | Description |
|---|---|---|
| `--yes` |  | Do not ask for confirmation (required without a terminal). |
| `--no-wait` |  | Print the operation id and return without waiting for the change. |
| `--wait-timeout` | `<SECONDS>` | Wait at most this many seconds for the change to finish (at most a day). Not with `--no-wait`. |

### `yaran agents prs hide`

Hide a pull request yaran found, until you unhide it. It keeps its place in your own order.

```text
yaran agents prs hide [OPTIONS] <AGENT> <REF>
```

| Argument | Description |
|---|---|
| `<AGENT>` | Required. An agent's id or name; a name two agents share is refused with both ids. |
| `<REF>` | Required. One of the agent's pull requests: its link, `owner/repo#123`, or just `123` (or `'#123'`, quoted, since a shell reads a word starting with `#` as a comment); a number two of them share is refused with both links. |

| Flag | Value | Description |
|---|---|---|
| `--yes` |  | Do not ask for confirmation (required without a terminal). |
| `--no-wait` |  | Print the operation id and return without waiting for the change. |
| `--wait-timeout` | `<SECONDS>` | Wait at most this many seconds for the change to finish (at most a day). Not with `--no-wait`. |

### `yaran agents prs unhide`

Show a hidden pull request again, in the place it had.

```text
yaran agents prs unhide [OPTIONS] <AGENT> <REF>
```

| Argument | Description |
|---|---|
| `<AGENT>` | Required. An agent's id or name; a name two agents share is refused with both ids. |
| `<REF>` | Required. One of the agent's pull requests: its link, `owner/repo#123`, or just `123` (or `'#123'`, quoted, since a shell reads a word starting with `#` as a comment); a number two of them share is refused with both links. |

| Flag | Value | Description |
|---|---|---|
| `--yes` |  | Do not ask for confirmation (required without a terminal). |
| `--no-wait` |  | Print the operation id and return without waiting for the change. |
| `--wait-timeout` | `<SECONDS>` | Wait at most this many seconds for the change to finish (at most a day). Not with `--no-wait`. |

### `yaran agents prs sort`

Choose how an agent's pull requests are ordered. Your own order is kept while the order is automatic, so choosing `manual` again brings it back.

```text
yaran agents prs sort [OPTIONS] <AGENT> <MODE>
```

| Argument | Description |
|---|---|
| `<AGENT>` | Required. An agent's id or name; a name two agents share is refused with both ids. |
| `<MODE>` | Required. `auto` (or `automatic`): open, draft, merged, closed, newest first. `manual`: your own order, with pull requests found later after the ones you placed. One of `auto`, `manual`. |

| Flag | Value | Description |
|---|---|---|
| `--yes` |  | Do not ask for confirmation (required without a terminal). |
| `--no-wait` |  | Print the operation id and return without waiting for the change. |
| `--wait-timeout` | `<SECONDS>` | Wait at most this many seconds for the change to finish (at most a day). Not with `--no-wait`. |

### `yaran agents prs move`

Move one of an agent's shown pull requests in its order. A move made while the order is automatic switches to your own order, starting from the order it was in, and replaces any order you had saved.

```text
yaran agents prs move [OPTIONS] <AGENT> <REF> <TO>
```

| Argument | Description |
|---|---|
| `<AGENT>` | Required. An agent's id or name; a name two agents share is refused with both ids. |
| `<REF>` | Required. One of the agent's pull requests: its link, `owner/repo#123`, or just `123` (or `'#123'`, quoted, since a shell reads a word starting with `#` as a comment); a number two of them share is refused with both links. |
| `<TO>` | Required. Where to: `top`, `up`, `down`, or a position counted from 1. |

| Flag | Value | Description |
|---|---|---|
| `--yes` |  | Do not ask for confirmation (required without a terminal). |
| `--no-wait` |  | Print the operation id and return without waiting for the change. |
| `--wait-timeout` | `<SECONDS>` | Wait at most this many seconds for the change to finish (at most a day). Not with `--no-wait`. |

### `yaran agents prs branches`

List every branch an agent's worktree has been on, the one checked out now first and the rest newest first, with the names each had before a rename and its pull requests, then the pull requests that are on none of them: the ones you attached, and any yaran found on a branch not listed.

```text
yaran agents prs branches [OPTIONS] <AGENT>
```

| Argument | Description |
|---|---|
| `<AGENT>` | Required. An agent's id or name; a name two agents share is refused with both ids. |

| Flag | Value | Description |
|---|---|---|
| `--format` | `<FORMAT>` | How to print the list: `table` to read, `json` for a script. One of `table`, `json`. Default: `table`. |
| `-q`, `--quiet` |  | Print only the ids, one per line. |

## `yaran terminals`

Terminals, project-owned, agent-owned and standalone.

```text
yaran terminals [OPTIONS] <COMMAND>
```

- [`yaran terminals ls`](#yaran-terminals-ls): List terminals.
- [`yaran terminals add`](#yaran-terminals-add): Open a terminal and print its id last.
- [`yaran terminals rm`](#yaran-terminals-rm): Close a terminal.

### `yaran terminals ls`

Also: `list`

List terminals.

```text
yaran terminals ls [OPTIONS]
```

| Flag | Value | Description |
|---|---|---|
| `--format` | `<FORMAT>` | How to print the list: `table` to read, `json` for a script. One of `table`, `json`. Default: `table`. |
| `-q`, `--quiet` |  | Print only the ids, one per line. |

### `yaran terminals add`

Open a terminal and print its id last.

```text
yaran terminals add [OPTIONS]
```

| Flag | Value | Description |
|---|---|---|
| `--agent` | `<AGENT>` | Open it in this agent's worktree. Not with `--project`. |
| `--project` | `<PROJECT>` | Open it at this project's root. |
| `--yes` |  | Do not ask for confirmation (required without a terminal). |
| `--no-wait` |  | Print the operation id and return without waiting for the change. |
| `--wait-timeout` | `<SECONDS>` | Wait at most this many seconds for the change to finish (at most a day). Not with `--no-wait`. |

### `yaran terminals rm`

Also: `remove`

Close a terminal.

```text
yaran terminals rm [OPTIONS] <TERMINAL>
```

| Argument | Description |
|---|---|
| `<TERMINAL>` | Required. A terminal's id or its name in the list; a name two terminals share is refused with both ids. |

| Flag | Value | Description |
|---|---|---|
| `--yes` |  | Do not ask for confirmation (required without a terminal). |
| `--no-wait` |  | Print the operation id and return without waiting for the change. |
| `--wait-timeout` | `<SECONDS>` | Wait at most this many seconds for the change to finish (at most a day). Not with `--no-wait`. |
| `--dangerously-ignore-connected` |  | Go ahead even though someone is attached. |

## `yaran macros`

Macros from config.toml.

```text
yaran macros [OPTIONS] <COMMAND>
```

- [`yaran macros ls`](#yaran-macros-ls): List the macros.
- [`yaran macros show`](#yaran-macros-show): Show one macro by name.
- [`yaran macros add`](#yaran-macros-add): Add a macro, or replace the one with that name.
- [`yaran macros rm`](#yaran-macros-rm): Remove a macro.

### `yaran macros ls`

Also: `list`

List the macros.

```text
yaran macros ls [OPTIONS]
```

| Flag | Value | Description |
|---|---|---|
| `--format` | `<FORMAT>` | How to print the list: `table` to read, `json` for a script. One of `table`, `json`. Default: `table`. |
| `-q`, `--quiet` |  | Print only the ids, one per line. |

### `yaran macros show`

Show one macro by name.

```text
yaran macros show [OPTIONS] <NAME>
```

| Argument | Description |
|---|---|
| `<NAME>` | Required. The macro's name, as `yaran macros ls` lists it. |

### `yaran macros add`

Add a macro, or replace the one with that name.

```text
yaran macros add [OPTIONS] <NAME> <TEXT>
```

| Argument | Description |
|---|---|
| `<NAME>` | Required. The macro's name; an existing macro with this name is replaced. |
| `<TEXT>` | Required. The text the macro types. |

| Flag | Value | Description |
|---|---|---|
| `--surface` | `<SURFACE>` | Where the macro is offered: in agents, terminals, or both. One of `agent`, `terminal`, `both`. Default: `agent`. |
| `--yes` |  | Do not ask for confirmation (required without a terminal). |
| `--no-wait` |  | Print the operation id and return without waiting for the change. |
| `--wait-timeout` | `<SECONDS>` | Wait at most this many seconds for the change to finish (at most a day). Not with `--no-wait`. |

### `yaran macros rm`

Also: `remove`

Remove a macro.

```text
yaran macros rm [OPTIONS] <NAME>
```

| Argument | Description |
|---|---|
| `<NAME>` | Required. The macro's name, as `yaran macros ls` lists it. |

| Flag | Value | Description |
|---|---|---|
| `--yes` |  | Do not ask for confirmation (required without a terminal). |
| `--no-wait` |  | Print the operation id and return without waiting for the change. |
| `--wait-timeout` | `<SECONDS>` | Wait at most this many seconds for the change to finish (at most a day). Not with `--no-wait`. |

## `yaran providers`

Providers from config.toml.

```text
yaran providers [OPTIONS] <COMMAND>
```

- [`yaran providers ls`](#yaran-providers-ls): List the providers, built-in and your own.
- [`yaran providers show`](#yaran-providers-show): Show one provider and the command it runs.

### `yaran providers ls`

Also: `list`

List the providers, built-in and your own.

```text
yaran providers ls [OPTIONS]
```

| Flag | Value | Description |
|---|---|---|
| `--format` | `<FORMAT>` | How to print the list: `table` to read, `json` for a script. One of `table`, `json`. Default: `table`. |
| `-q`, `--quiet` |  | Print only the ids, one per line. |

### `yaran providers show`

Show one provider and the command it runs.

```text
yaran providers show [OPTIONS] <NAME>
```

| Argument | Description |
|---|---|
| `<NAME>` | Required. The provider's name, as `yaran providers ls` lists it. |

## `yaran keys`

Keybindings from config.toml.

```text
yaran keys [OPTIONS] <COMMAND>
```

- [`yaran keys ls`](#yaran-keys-ls): List every action the terminal UI binds and the keys it uses, yours or the default.

### `yaran keys ls`

Also: `list`

List every action the terminal UI binds and the keys it uses, yours or the default.

```text
yaran keys ls [OPTIONS]
```

| Flag | Value | Description |
|---|---|---|
| `--format` | `<FORMAT>` | How to print the list: `table` to read, `json` for a script. One of `table`, `json`. Default: `table`. |
| `-q`, `--quiet` |  | Print only the ids, one per line. |

## `yaran themes`

Themes yaran can load.

```text
yaran themes [OPTIONS] <COMMAND>
```

- [`yaran themes ls`](#yaran-themes-ls): List the themes yaran can load, marking the one ui.theme names.

### `yaran themes ls`

Also: `list`

List the themes yaran can load, marking the one ui.theme names.

```text
yaran themes ls [OPTIONS]
```

| Flag | Value | Description |
|---|---|---|
| `--format` | `<FORMAT>` | How to print the list: `table` to read, `json` for a script. One of `table`, `json`. Default: `table`. |
| `-q`, `--quiet` |  | Print only the ids, one per line. |

## `yaran env`

The global environment from config.toml.

```text
yaran env [OPTIONS] <COMMAND>
```

- [`yaran env ls`](#yaran-env-ls): List the variables.
- [`yaran env set`](#yaran-env-set): Set a variable; the value is asked for, or read from stdin.
- [`yaran env rm`](#yaran-env-rm): Remove a variable.

### `yaran env ls`

Also: `list`

List the variables.

```text
yaran env ls [OPTIONS]
```

| Flag | Value | Description |
|---|---|---|
| `--show` |  | Print the values too, which may be secrets. |
| `--format` | `<FORMAT>` | How to print the list: `table` to read, `json` for a script. One of `table`, `json`. Default: `table`. |
| `-q`, `--quiet` |  | Print only the ids, one per line. |

### `yaran env set`

Set a variable; the value is asked for, or read from stdin.

```text
yaran env set [OPTIONS] <NAME>
```

| Argument | Description |
|---|---|
| `<NAME>` | Required. The variable's name, for example `GITHUB_TOKEN`. |

| Flag | Value | Description |
|---|---|---|
| `--stdin` |  | Read the value from standard input. |
| `--yes` |  | Do not ask for confirmation (required without a terminal). |
| `--no-wait` |  | Print the operation id and return without waiting for the change. |
| `--wait-timeout` | `<SECONDS>` | Wait at most this many seconds for the change to finish (at most a day). Not with `--no-wait`. |

### `yaran env rm`

Also: `remove`

Remove a variable.

```text
yaran env rm [OPTIONS] <NAME>
```

| Argument | Description |
|---|---|
| `<NAME>` | Required. The variable's name, as `yaran env ls` lists it. |

| Flag | Value | Description |
|---|---|---|
| `--yes` |  | Do not ask for confirmation (required without a terminal). |
| `--no-wait` |  | Print the operation id and return without waiting for the change. |
| `--wait-timeout` | `<SECONDS>` | Wait at most this many seconds for the change to finish (at most a day). Not with `--no-wait`. |

## `yaran remote`

Saved remote yaranes and the sign-ins for them.

```text
yaran remote [OPTIONS] <COMMAND>
```

- [`yaran remote add`](#yaran-remote-add): Save a remote under a name.
- [`yaran remote ls`](#yaran-remote-ls): List saved remotes.
- [`yaran remote rm`](#yaran-remote-rm): Forget a saved remote.
- [`yaran remote default`](#yaran-remote-default): Choose, or with `--unset` clear, the remote used when none is named.
- [`yaran remote login`](#yaran-remote-login): Sign in to a remote (the selected one when no name is given).
- [`yaran remote logout`](#yaran-remote-logout): Sign out of a remote (the selected one when no name is given).

### `yaran remote add`

Save a remote under a name.

```text
yaran remote add [OPTIONS] <NAME> <URL>
```

| Argument | Description |
|---|---|
| `<NAME>` | Required. The name to save the remote under, used with `--remote`. |
| `<URL>` | Required. The address of the remote yaran's web UI, for example `https://box.tailnet-name.ts.net`. |

| Flag | Value | Description |
|---|---|---|
| `--insecure` |  | Allow plain http:// to an address that is neither this machine nor a Tailscale address. The password then crosses the network unencrypted, and every login says so. |

### `yaran remote ls`

Also: `list`

List saved remotes.

```text
yaran remote ls [OPTIONS]
```

| Flag | Value | Description |
|---|---|---|
| `--format` | `<FORMAT>` | How to print the list: `table` to read, `json` for a script. One of `table`, `json`. Default: `table`. |
| `-q`, `--quiet` |  | Print only the ids, one per line. |

### `yaran remote rm`

Also: `remove`

Forget a saved remote.

```text
yaran remote rm [OPTIONS] <NAME>
```

| Argument | Description |
|---|---|
| `<NAME>` | Required. The saved remote's name, as `yaran remote ls` lists it. |

### `yaran remote default`

Choose, or with `--unset` clear, the remote used when none is named.

```text
yaran remote default [OPTIONS] [NAME]
```

| Argument | Description |
|---|---|
| `<NAME>` | Optional. The saved remote's name, as `yaran remote ls` lists it. Needed unless `--unset` is given. |

| Flag | Value | Description |
|---|---|---|
| `--unset` |  | Clear the default remote. Not with a name. |

### `yaran remote login`

Sign in to a remote (the selected one when no name is given).

```text
yaran remote login [OPTIONS] [NAME]
```

| Argument | Description |
|---|---|
| `<NAME>` | Optional. The saved remote's name (the selected one when left out). |

| Flag | Value | Description |
|---|---|---|
| `--stdin` |  | Read the password from standard input instead of asking for it. |

### `yaran remote logout`

Sign out of a remote (the selected one when no name is given).

```text
yaran remote logout [OPTIONS] [NAME]
```

| Argument | Description |
|---|---|
| `<NAME>` | Optional. The saved remote's name (the selected one when left out). |

## `yaran operations`

Look up a change that was started earlier.

```text
yaran operations [OPTIONS] <COMMAND>
```

- [`yaran operations show`](#yaran-operations-show): Show where a change stands.

### `yaran operations show`

Show where a change stands.

```text
yaran operations show [OPTIONS] <ID>
```

| Argument | Description |
|---|---|
| `<ID>` | Required. The operation id a change printed when it started. |

## `yaran doctor`

Print a diagnostic dump of this machine's yaran (`--json`, `--anonymize`).

```text
yaran doctor [OPTIONS] [ARGS]...
```

| Argument | Description |
|---|---|
| `<ARGS>` | Optional. The command's own words, read by the command itself; its `--help` lists them. |

## `yaran session`

Permanently purge an agent's stored data (`yaran session --help`).

```text
yaran session [OPTIONS] [ARGS]...
```

| Argument | Description |
|---|---|
| `<ARGS>` | Optional. The command's own words, read by the command itself; its `--help` lists them. |

## `yaran peer`

Route messages between agent sessions (`yaran peer --help` for send, list, sync-amq).

```text
yaran peer [OPTIONS] [ARGS]...
```

| Argument | Description |
|---|---|
| `<ARGS>` | Optional. The command's own words, read by the command itself; its `--help` lists them. |

## `yaran board`

Post cards for the person running yaran, or resolve them (`yaran board --help`).

```text
yaran board [OPTIONS] [ARGS]...
```

| Argument | Description |
|---|---|
| `<ARGS>` | Optional. The command's own words, read by the command itself; its `--help` lists them. |

## `yaran cloud`

Connect this machine to Yaran Cloud for your phone (`yaran cloud --help`).

```text
yaran cloud [OPTIONS] [ARGS]...
```

| Argument | Description |
|---|---|
| `<ARGS>` | Optional. The command's own words, read by the command itself; its `--help` lists them. |
