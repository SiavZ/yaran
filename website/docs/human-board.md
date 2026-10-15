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

or run `toggle-human-board` from the palette. The right column then gets a row of tabs:
**Board** (the cards) and **Changes** (the changed files, the Staged Changes list and the
Commit Message box, exactly as they are without the board). Switch tabs with the arrow keys
(or `h` and `l`) while the right column has focus, or click one. Running the command again
takes the tabs away; the cards stay on the board either way.

Each tab carries a count: the cards waiting on you, and the files that changed.

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
  it asks, the ticket, who posted it and when, its full detail, and the conversation on it;
- the stage key marks the selected card done, or reopens it when it is already done.

The card view has a **Mark done** (or **Reopen**) button too. A click selects a card and a
double click opens it. A long card scrolls: the mouse wheel anywhere on it, the paging keys,
and the arrow keys (also while you are typing a reply, since a one-line reply box has no use
for Up and Down).

## Priority

A card can carry a priority, graded like an issue tracker's: `critical`, `high`, `normal`
(the default) or `low`. Within its group an urgent card is listed first and wears a marker
(`!!` critical, `!` high, `↓` low); the pane's title counts them as `(2 urgent)`, and the
announcement of a new urgent card says so. Agents set it when posting
(`yaran board post --priority high …`) and anyone can change it afterwards:

```bash
yaran board priority 21 critical
```

## Replying from a card

An open card's view has a reply box. The line above it names who your reply goes to before
you send anything:

- **the agent that posted the card**, when it is running in this yaran: yaran types your
  reply into it, exactly as you would type it yourself;
- **the selected agent**, when the poster is not running here;
- **a person**, on a board with [people](#a-queue-per-person): your reply joins the card's
  conversation and reaches them with the board (see
  [Talking across boards](#talking-across-boards)).

When there is more than one choice, the name is a control of its own: move to it and press
it (or click it) to go to the next one.

Two buttons send:

- **Send** keeps the card open, for a question or a reply in a longer exchange;
- **Send & mark done** (it reads **Mark done** while the box is empty) closes the card with
  your reply kept as its note.

Pressing Enter in the box does what the key line under it says: it sends and marks done when
you are answering the agent that asked, and only sends when the conversation goes on with a
person or the card is handed to an agent to work on. Every reply is kept in the card's
conversation.

What is typed into an agent carries the card it answers in front of it:

```text
Reply to board card #21 [mvp-go-1013] (MVP GO re-check COMPLETE): looks good, roll it
```

Change that wording with `human_board_reply_template` in `[ui]`. It understands `{reply}`,
`{card}`, `{ticket}` and `{title}`; an empty template sends your reply alone.

> [!NOTE]
> A reply typed into an agent is a keystroke like any other: when another device is driving
> the agent's terminal, the send is refused, nothing is marked done, and your reply stays in
> the box.

On a board with people, **Assign to …** moves the card to the next person's queue, so you can
hand a card to a colleague (and they can hand it back) without leaving it.

## Posting cards from an agent

Agents use the `yaran board` command, which works from inside any agent yaran launched:

```bash
yaran board post --kind validate --ticket 4812 "Check the signup page on a phone"
yaran board post --kind confirm --ticket 3770 --detail - "Merge the auth fix?" < why.md
yaran board post --kind confirm --blocking "Can I drop the old audit table?"
yaran board reply 12 "The audit_2019 table; nothing reads it since March."
yaran board reply 12 --done "Dropped; the backup is in the bucket."
yaran board show 12
yaran board resolve --ticket 4812
yaran board resolve 12 --note "shipped"
yaran board list --all --json
```

- An open card is unique per ticket and kind: posting again with the same `--ticket` and
  `--kind` updates that card instead of adding a second one.
- `--detail -` reads the detail from standard input, for anything longer than a line. A
  title too long for one row (over 300 characters) is never cut short: the card keeps its
  first sentence or clause as the title, and the whole title opens the detail.
- The poster is recorded from the agent's handle, or `--from` when given.
- `--blocking` says the agent cannot carry on until a person answers; the board marks the
  card and its queue in red until somebody does (see [The dots](#the-dots)).
- `yaran board reply` adds to a card's conversation, to answer a question a person asked on
  it or to report on the work it asked for; `--done` marks the card done with it. An agent's
  posts and replies are signed with its handle, also when it runs without one in its
  environment (yaran recognises the agent by the folder it works in).
  `yaran board show` prints one card whole, conversation included.
- `yaran board list --all` shows the resolved cards too, so an agent can see what you
  confirmed and carry on. Cards you clear here are recorded as resolved by `human` (by your
  name, when `[board] me` is set).

Tell your orchestrating agent about the board in its instructions, for example: "When a
ticket needs the owner, post it with `yaran board post` instead of only saying so in your
reply."

## A queue per person

When more than one person handles what the agents ask, give each of them a queue:

```toml
[board]
people = ["Sam", "Alex"]
me = "Sam"
```

The tabs become **Sam**, **Alex**, **All** and **Changes**, and the column opens on the
queue of `me`, the person running this yaran. Agents put a card in someone's queue with
`--for`:

```bash
yaran board post --kind task --for Alex "Approve the payout terms"
yaran board assign 14 Sam
yaran board list --for Alex
```

- A card posted without `--for` goes to `me`. `--for anyone` puts it in every queue.
- A name that is not in `people` is refused with the list, so a typo never parks a card
  in a queue nobody reads.
- **All** shows every card with whose queue it is in. Only new cards in your own queue are
  announced on the status line.

## Sharing the board

On its own, the board lives in one file, `human_board.json`, in yaran's config directory,
readable only by you. Point `[board] dir` at a folder instead and every card becomes a
Markdown note there (`S-12.md`), with the card's fields as note properties and its detail
as the body, followed by its conversation under a `## Conversation` heading, one callout per
message. A reply written there by hand (a `> [!reply] Name` callout) is read like any other. Notes apps such as Obsidian show and edit them like any other note, and a
person can change a card's `status` to `done` (or its `priority`, or its `assignee`) right
there.

```toml
[board]
dir = "~/notes/Board"
people = ["Sam", "Alex"]
me = "Sam"
id_prefix = "S"
sync = "git"
sync_interval_seconds = 60
```

To share that folder between machines, keep it somewhere both can reach:

- In a synced notes vault, leave `sync = "off"` and let the vault's own sync carry it.
- Inside a git repository whose branch has an upstream, set `sync = "git"`. While the
  terminal UI runs, yaran commits the folder's changes (only the folder's, whatever else in
  the repository is changed or staged), merges the upstream and pushes, once every
  `sync_interval_seconds` and a few seconds after anything changes the board. The board's
  bottom edge shows when it last synced. `yaran board sync` runs one sync by hand.

Every machine numbers the cards it adds behind its own `id_prefix` (`S-12`, `A-3`), so two
machines never hand out the same id. It defaults to the first letter of `me`; give each
machine its own. A bare number such as `yaran board resolve 12` means this machine's card
12 first.

> [!IMPORTANT]
> With `sync = "git"`, yaran pushes the branch the folder's repository has checked out,
> including commits other tools made there and have not pushed yet. It never rebases or
> forces. When two machines changed the same card, the later edit is kept, and the messages
> both added to its conversation are kept too. Anything else it cannot merge, such as a
> conflict in another file, is undone and reported, and the sync tries again later.

## Talking across boards

On a shared board a card is a conversation between the people on it and their agents, the
way a pull request review is. Say Sam's agent posts a card for Alex:

1. Alex's board shows it in Alex's queue. Its view says **Reply to Sam** and names the agent
   on Sam's side that posted it.
2. Alex sends a question, or an answer with **Send & mark done**. It joins the card's
   conversation and reaches Sam's board with the next sync.
3. On Sam's board the card wears a green dot until Sam opens it. With
   [relaying](#passing-replies-to-agents) on, Sam's yaran also passes Alex's words to the
   agent that posted the card, which answers on the card with `yaran board reply`; that
   answer reaches Alex the same way. Without it, the card's **Forward** (the Send button
   while the box is empty) passes Alex's words on by hand.
4. Either of them can write on the card at any point. Sam's own view offers **Ask Alex** as
   well as replying to the agent, and Alex can **Hand to** an agent of their own (the
   selected one) to work on the card and report back on it.

### The dots

A queue tab, and each card row, can wear a dot after its count:

- **green**: something from another person's side that you have not opened yet (a card
  posted on their board, or a message on one). Opening the card clears it.
- **red**: a card that says its agent cannot carry on (`--blocking`) and that no person has
  answered since the agent last asked. Answering, or marking it done, clears it.

What you have read is kept per machine, in `human_board_seen.json` in yaran's config
directory, never in the shared folder.

### Passing replies to agents

```toml
[board]
relay = true
relay_to = "orchestrator"
relay_transport = "auto"
```

With `relay` on, while the terminal UI runs, what another side writes on a card an agent of
this machine posted is passed to that agent, as `yaran peer send` passes a message between
agents (never typed into its terminal). A card another person hands you with **Assign** goes
to `relay_to`, an agent that can take the work on, and its report comes back on the card;
without `relay_to` such cards wait on the board. A card the other side's agents merely posted
for you is a question for you, and always waits for you. Each message is passed once, the card's conversation shows that it
was, and the status line says so. `relay_transport` picks the route the way
`yaran peer send --transport` does.

> [!WARNING]
> With `relay` on, anyone who can write the shared folder can put words in front of your
> agents as if a colleague had written them. Turn it on only for a folder whose writers you
> would let instruct your agents.

To move an existing private board into a new shared folder, set `dir` and run:

```bash
yaran board import
```

It copies every card (keeping its number behind this machine's prefix where it can) and
leaves the private file alone. Running it twice copies nothing twice.

## Where the cards live

Every change is written whole, so the terminal UI never reads half a board, and several
agents posting at once never lose a card. Resolved cards are kept as history (the newest
200), and open cards are never dropped. If the private file is damaged, the pane says so
and yaran leaves the file alone rather than overwriting cards nobody has read. In a shared
folder a note yaran cannot read is left exactly as it is, the rest of the board still loads,
and the board's bottom edge counts the unreadable notes (`yaran board list` names them).

> [!NOTE]
> The board is shown in the terminal UI only. The web UI does not show it yet.
