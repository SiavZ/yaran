---
title: Tasks for Human
description: The human board, where agents leave the decisions, checks and confirmations that need a person, and how to read and clear it.
group: Guides
order: 37
---

Agents that work through tickets on their own still hit moments only a person can
handle: a product decision, a change to check on a real phone, a yes before a merge or a
deploy. In a busy terminal those moments scroll past. The human board is where they wait
for you instead, in the same spot on screen whatever agent you are looking at.

## Turn it on

Set it in `config.toml`:

```toml
[ui]
human_board = true
```

or run `toggle-human-board` from the palette. The right column then shows **Tasks for
Human** in place of the Staged Changes list and the Commit Message box. Running the
command again brings those back; the cards stay on the board either way.

> [!NOTE]
> While the board is up, staged files have no list of their own. The Changes title
> says how many there are (`· 3 staged`), and the stage and commit flow returns the
> moment you switch the board off.

## What you see

Open cards are grouped by what they ask of you, in this order:

| Group | Kind | Means |
| --- | --- | --- |
| Tasks for you | `task` | something only a person can do or decide |
| Validation | `validate` | the work is done; check it |
| Confirmation needed | `confirm` | an agent is waiting for a yes or no |
| What happened | `info` | news for the record; nothing is asked |

Each row shows the ticket (or the card number), the title, and how long ago it changed.
The last few cards you marked done follow under **Done**, so a slip of the key is easy to
undo. The title counts how many cards are waiting on you.

When an agent posts a new card, the status line says so, even when the right column is
hidden.

## Reading and clearing cards

Move into the board with the pane keys, then:

- the open key (the one that opens a diff in the Changes list) shows the whole card: what
  it asks, the ticket, who posted it and when, and its full detail;
- the stage key marks the selected card done, or reopens it when it is already done.

The card view has a **Mark done** (or **Reopen**) button too. A click selects a card and a
double click opens it.

## Posting cards from an agent

Agents use the `yaran board` command, which works from inside any agent yaran launched:

```bash
yaran board post --kind validate --ticket 4812 "Check the signup page on a phone"
yaran board post --kind confirm --ticket 3770 --detail - "Merge the auth fix?" < why.md
yaran board resolve --ticket 4812
yaran board resolve 12 --note "shipped"
yaran board list --all --json
```

- An open card is unique per ticket and kind: posting again with the same `--ticket` and
  `--kind` updates that card instead of adding a second one.
- `--detail -` reads the detail from standard input, for anything longer than a line.
- The poster is recorded from the agent's handle, or `--from` when given.
- `yaran board list --all` shows the resolved cards too, so an agent can see what you
  confirmed and carry on. Cards you clear here are recorded as resolved by `human`.

Tell your orchestrating agent about the board in its instructions, for example: "When a
ticket needs the owner, post it with `yaran board post` instead of only saying so in your
reply."

## Where the cards live

The board is one file, `human_board.json`, in yaran's config directory, readable only by
you. Every change is written whole, so the terminal UI never reads half a board, and
several agents posting at once never lose a card. Resolved cards are kept as history (the
newest 200), and open cards are never dropped. If the file is damaged, the pane says so and
yaran leaves the file alone rather than overwriting cards nobody has read.

> [!NOTE]
> The board is shown in the terminal UI only. The web UI does not show it yet.
