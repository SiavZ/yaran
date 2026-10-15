//! `yaran board`: how agents put cards on the human board, and take them off.
//!
//! Dispatched by the binary before the terminal UI's own argument handling,
//! like `yaran peer`, and for the same reasons: it runs inside agents while a
//! yaran holds the single-instance lock, and a card title may legitimately
//! contain `--help`. It touches nothing but the board (and, for `sync`, the
//! git repository a shared board folder lives in).

use std::io::Read;
use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use chrono::Utc;

use super::{
    Audience, Board, BoardSettings, BoardStore, Card, CardId, CardKind, NewCard, PostOutcome,
    Priority, compact_age,
};
use crate::config::YaranPaths;

pub const BOARD_HELP: &str = "\
yaran board - cards for the people running yaran

Agents post a card when something needs a person or should not be missed.
The terminal UI shows the open cards (the \"Tasks for Human\" pane) until
they are marked done there or resolved here. A board with [board] people has
a queue per person: a card is for one of them (--for), or for anyone.

Subcommands:
  yaran board post --kind <kind> [--for <person>] [--priority <level>] [--ticket <id>]
                   [--blocking] [--detail <text>|-] [--from <who>] <title...>
                       Put a card on the board and print its id. An open card
                       is unique per ticket, kind and person: posting again
                       with the same --ticket, --kind and --for updates it in
                       place (its priority too, when --priority is given).
                       --for defaults to [board] me; \"anyone\" is nobody in
                       particular. --blocking says you cannot carry on until a
                       person answers: the board marks the queue until one
                       does. --detail - reads the detail from standard input.
  yaran board reply <id> [--done] [--from <who>] <text...>|-
                       Add to a card's conversation: answer a person's question
                       on it, or report on the work it asked for. The reply
                       reaches the person on the other side through the board.
                       --done marks the card done with it; - reads the text
                       from standard input.
  yaran board show <id> [--json]
                       Print one card whole: its fields, detail and conversation.
  yaran board blocking <id> <yes|no>
                       Say whether a card holds you up.
  yaran board assign <id> <person|anyone>
                       Move a card to another person's queue.
  yaran board priority <id> <level>
                       Change a card's priority.
  yaran board resolve <id>... [--note <text>]
  yaran board resolve --ticket <id> [--kind <kind>] [--note <text>]
                       Take cards off the board. They stay in its history.
  yaran board reopen <id>
                       Put a resolved card back on the board.
  yaran board list [--all] [--for <person>|--mine] [--json]
                       Show the open cards; --all adds the resolved history,
                       --for narrows to one person's queue.
  yaran board sync     Sync a shared board folder through its git repository
                       now ([board] sync = \"git\" does it in the background
                       while the terminal UI runs).
  yaran board import [<file>]
                       Copy the cards of a private board document (by default
                       the one in the yaran home) into the shared board folder.

Card ids are numbers (12), or on a shared board a prefix and a number (G-12).
A bare number names this machine's card first.

Priorities (most urgent first; urgent cards lead their group on the board):
  critical   drop everything (a release is blocked, users are affected)
  high       needed soon, ahead of the ordinary queue
  normal     the ordinary queue (the default)
  low        whenever convenient

Kinds:
  task       something only a person can do or decide
  validate   work is done and a person should check it
  confirm    an agent is waiting for a yes or no before it carries on
  info       what happened, for the record; nothing is asked

The poster is --from, else $YARAN_AMQ_HANDLE or $AM_ME, which yaran sets
for every agent it launches.";

/// The agent whose working directory `yaran board` runs in, when no handle
/// variable says who is posting: set once by [`run_board`].
static AGENT_HERE: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();

/// Entry point for `yaran board <args>`.
pub fn run_board(args: &[String], paths: &YaranPaths) -> Result<()> {
    // An agent whose launch did not export its handle is still recognised by
    // the directory it works in, so its posts and replies are signed with its
    // handle rather than the person's name.
    let _ = AGENT_HERE.set(
        std::env::current_dir()
            .ok()
            .and_then(|cwd| crate::peer::router::agent_handle_for_cwd(paths, &cwd)),
    );
    let config = crate::config::load_config(paths);
    let settings = BoardSettings::from_config(&config.board, &paths.root);
    let mut stdin = std::io::stdin();
    run_with(args, &settings, &mut stdin, &mut std::io::stdout())
}

/// The testable body of [`run_board`]: everything comes in through arguments.
pub fn run_with(
    args: &[String],
    settings: &BoardSettings,
    stdin: &mut dyn Read,
    out: &mut dyn std::io::Write,
) -> Result<()> {
    let store = &settings.store;
    let sub = args.first().map(String::as_str).unwrap_or("");
    let rest = args.get(1..).unwrap_or_default();
    match sub {
        "post" | "add" => {
            let Some(card) = parse_post(rest, settings, stdin)? else {
                writeln!(out, "{BOARD_HELP}")?;
                return Ok(());
            };
            let kind = card.kind;
            let assignee = card.assignee.clone();
            let outcome = store.update(|board| board.post(card, Utc::now()))?;
            let verb = match outcome {
                PostOutcome::Added(_) => "posted",
                PostOutcome::Updated(_) => "updated",
            };
            let kind = kind.map(CardKind::as_str).unwrap_or_default();
            let whose = assignee
                .map(|person| format!(", for {person}"))
                .unwrap_or_default();
            writeln!(out, "{verb} #{} ({kind}{whose})", outcome.id())?;
            Ok(())
        }
        "resolve" | "done" => run_resolve(rest, store, out),
        "reply" | "answer" => run_reply(rest, settings, stdin, out),
        "show" | "view" => run_show(rest, settings, out),
        "blocking" => {
            let [id, value] = rest else {
                bail!("`yaran board blocking` needs a card id and yes or no");
            };
            let blocking = match value.trim().to_ascii_lowercase().as_str() {
                "yes" | "true" | "on" | "1" => true,
                "no" | "false" | "off" | "0" => false,
                other => bail!("`yaran board blocking` takes yes or no, not {other:?}"),
            };
            let (id, changed) = store.update(|board| {
                let id = board.find(id)?;
                let changed = board.set_blocking(&id, blocking, Utc::now())?;
                Ok((id, changed))
            })?;
            let state = if blocking {
                "holds its poster up until a person answers"
            } else {
                "does not hold anybody up"
            };
            if changed {
                writeln!(out, "#{id} now {state}")?;
            } else {
                writeln!(out, "#{id} already {state}")?;
            }
            Ok(())
        }
        "priority" => {
            let [id, level] = rest else {
                bail!(
                    "`yaran board priority` needs a card id and a level (critical, high, normal, low)"
                );
            };
            let priority = parse_priority(level)?;
            let (id, changed) = store.update(|board| {
                let id = board.find(id)?;
                let changed = board.set_priority(&id, priority, Utc::now())?;
                Ok((id, changed))
            })?;
            if changed {
                writeln!(out, "#{id} is now {priority}")?;
            } else {
                writeln!(out, "#{id} was already {priority}")?;
            }
            Ok(())
        }
        "assign" => {
            let [id, person] = rest else {
                bail!("`yaran board assign` needs a card id and a person (or \"anyone\")");
            };
            let assignee = settings.person(person)?;
            let (id, changed) = store.update(|board| {
                let id = board.find(id)?;
                let changed =
                    board.assign(&id, assignee.as_deref(), settings.me.as_deref(), Utc::now())?;
                Ok((id, changed))
            })?;
            let queue = assignee
                .map(|person| format!("{person}'s queue"))
                .unwrap_or_else(|| "everybody's queue".to_string());
            if changed {
                writeln!(out, "#{id} is now in {queue}")?;
            } else {
                writeln!(out, "#{id} was already in {queue}")?;
            }
            Ok(())
        }
        "reopen" => {
            if rest.is_empty() {
                bail!("`yaran board reopen` needs a card id");
            }
            let changed = store.update(|board| {
                let now = Utc::now();
                rest.iter()
                    .map(|query| {
                        let id = board.find(query)?;
                        board.reopen(&id, now).map(|changed| (id, changed))
                    })
                    .collect::<Result<Vec<_>>>()
            })?;
            for (id, changed) in changed {
                if changed {
                    writeln!(out, "reopened #{id}")?;
                } else {
                    writeln!(out, "#{id} was already open")?;
                }
            }
            Ok(())
        }
        "list" | "ls" => run_list(rest, settings, out),
        "sync" => {
            if !store.is_folder() {
                bail!(
                    "this board is private to this machine (no [board] dir), so there is \
                     nothing to sync"
                );
            }
            let report = super::sync::sync_with_git(store)?;
            writeln!(out, "{}", report.summary())?;
            for problem in store.load()?.problems {
                writeln!(out, "note: {problem}")?;
            }
            Ok(())
        }
        "import" => run_import(rest, settings, out),
        "" | "--help" | "-h" | "help" => {
            writeln!(out, "{BOARD_HELP}")?;
            Ok(())
        }
        other => bail!("unknown board subcommand: {other}\nRun `yaran board --help` for usage."),
    }
}

/// The poster when `--from` is not given: the handle yaran gives every agent,
/// else the agent whose working directory this runs in.
fn default_from() -> Option<String> {
    ["YARAN_AMQ_HANDLE", "AM_ME"]
        .iter()
        .find_map(|var| crate::brand_env::var(var).ok())
        .filter(|value| !value.trim().is_empty())
        .or_else(|| AGENT_HERE.get().cloned().flatten())
}

/// A priority from the CLI, or an error naming the valid levels.
fn parse_priority(value: &str) -> Result<Priority> {
    Priority::parse(value).ok_or_else(|| {
        anyhow::anyhow!("unknown priority {value:?}; use one of critical, high, normal, low")
    })
}

/// The value after a flag, or an error naming the flag.
fn value_of<'a>(flag: &str, iter: &mut impl Iterator<Item = &'a String>) -> Result<&'a String> {
    match iter.next() {
        Some(value) => Ok(value),
        None => bail!("{flag} needs a value"),
    }
}

/// Parse `post`'s arguments. `Ok(None)` is a request for the help text.
fn parse_post(
    args: &[String],
    settings: &BoardSettings,
    stdin: &mut dyn Read,
) -> Result<Option<NewCard>> {
    let mut card = NewCard::default();
    let mut assignee: Option<Option<String>> = None;
    let mut words: Vec<&str> = Vec::new();
    let mut iter = args.iter();
    let mut only_words = false;
    while let Some(arg) = iter.next() {
        if only_words {
            words.push(arg);
            continue;
        }
        match arg.as_str() {
            "--" => only_words = true,
            "--kind" | "-k" => {
                let value = value_of(arg, &mut iter)?;
                card.kind = Some(CardKind::parse(value).ok_or_else(|| {
                    anyhow::anyhow!(
                        "unknown kind {value:?}; use one of task, validate, confirm, info"
                    )
                })?);
            }
            "--for" | "--assignee" => {
                assignee = Some(settings.person(value_of(arg, &mut iter)?)?);
            }
            "--ticket" | "-t" => card.ticket = Some(value_of(arg, &mut iter)?.clone()),
            "--priority" | "-p" => card.priority = Some(parse_priority(value_of(arg, &mut iter)?)?),
            "--detail" | "-d" => {
                let value = value_of(arg, &mut iter)?;
                card.detail = Some(if value == "-" {
                    let mut text = String::new();
                    stdin.read_to_string(&mut text)?;
                    text
                } else {
                    value.clone()
                });
            }
            "--from" => card.from = Some(value_of(arg, &mut iter)?.clone()),
            "--blocking" | "--blocks" => card.blocking = Some(true),
            // Before the title starts, a dash word is a flag yaran should know;
            // once it has started, it is part of the title ("ran --help").
            "-h" | "--help" if words.is_empty() => return Ok(None),
            flag if flag.starts_with('-') && flag.len() > 1 && words.is_empty() => {
                bail!("unknown flag: {flag}")
            }
            word => words.push(word),
        }
    }
    if card.kind.is_none() {
        bail!("`yaran board post` needs --kind: one of task, validate, confirm, info");
    }
    card.title = words.join(" ");
    if card.title.trim().is_empty() {
        bail!("`yaran board post` needs a title after the flags");
    }
    if card.from.is_none() {
        card.from = default_from();
    }
    card.assignee = assignee.unwrap_or_else(|| settings.me.clone());
    card.origin = settings.me.clone();
    Ok(Some(card))
}

/// `yaran board reply <id> [--done] [--from <who>] <text...>|-`.
fn run_reply(
    args: &[String],
    settings: &BoardSettings,
    stdin: &mut dyn Read,
    out: &mut dyn std::io::Write,
) -> Result<()> {
    let mut query: Option<&String> = None;
    let mut from: Option<String> = None;
    let mut done = false;
    let mut words: Vec<&str> = Vec::new();
    let mut from_stdin = false;
    let mut iter = args.iter();
    let mut only_words = false;
    while let Some(arg) = iter.next() {
        if only_words {
            words.push(arg);
            continue;
        }
        match arg.as_str() {
            "--" if query.is_some() => only_words = true,
            "--done" | "--resolve" => done = true,
            "--from" => from = Some(value_of(arg, &mut iter)?.clone()),
            "-h" | "--help" if words.is_empty() => {
                writeln!(out, "{BOARD_HELP}")?;
                return Ok(());
            }
            "-" if query.is_some() && words.is_empty() => from_stdin = true,
            flag if flag.starts_with('-') && flag.len() > 1 && words.is_empty() => {
                bail!("unknown flag: {flag}")
            }
            _ if query.is_none() => query = Some(arg),
            word => words.push(word),
        }
    }
    let Some(query) = query else {
        bail!("`yaran board reply` needs a card id and the reply");
    };
    let text = if from_stdin {
        let mut text = String::new();
        stdin.read_to_string(&mut text)?;
        text
    } else {
        words.join(" ")
    };
    if text.trim().is_empty() {
        bail!(
            "`yaran board reply` needs the reply after the card id (or - to read it from standard input)"
        );
    }
    let from = from
        .or_else(default_from)
        .or_else(|| settings.me.clone())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "say who is replying with --from (no agent handle or [board] me is set)"
            )
        })?;
    let message = super::NewMessage {
        from,
        side: settings.me.clone(),
        text,
        done,
    };
    let (id, closed) = settings.store.update(|board| {
        let id = board.find(query)?;
        let was_open = board.card(&id).is_some_and(Card::is_open);
        board.reply(&id, message, Utc::now())?;
        let closed = was_open && board.card(&id).is_some_and(|card| !card.is_open());
        Ok((id, closed))
    })?;
    if closed {
        writeln!(out, "replied on #{id} and marked it done")?;
    } else {
        writeln!(out, "replied on #{id}")?;
    }
    Ok(())
}

/// `yaran board show <id> [--json]`.
fn run_show(args: &[String], settings: &BoardSettings, out: &mut dyn std::io::Write) -> Result<()> {
    let mut json = false;
    let mut query: Option<&String> = None;
    for arg in args {
        match arg.as_str() {
            "--json" => json = true,
            "-h" | "--help" => {
                writeln!(out, "{BOARD_HELP}")?;
                return Ok(());
            }
            flag if flag.starts_with('-') && flag.len() > 1 => bail!("unknown flag: {flag}"),
            _ if query.is_none() => query = Some(arg),
            _ => bail!("`yaran board show` takes one card id"),
        }
    }
    let Some(query) = query else {
        bail!("`yaran board show` needs a card id");
    };
    let board = settings.store.load()?;
    let id = board.find(query)?;
    let Some(card) = board.card(&id) else {
        bail!("there is no card #{id} on the board");
    };
    if json {
        writeln!(out, "{}", serde_json::to_string_pretty(card)?)?;
        return Ok(());
    }
    let now = Utc::now();
    writeln!(out, "{} {}", card.label(), card.title)?;
    let status = if card.is_open() { "open" } else { "done" };
    let mut facts = vec![
        format!("kind {}", card.kind),
        format!("priority {}", card.priority),
        status.to_string(),
    ];
    if card.blocking {
        facts.push("blocking".to_string());
    }
    if let Some(assignee) = &card.assignee {
        facts.push(format!("for {assignee}"));
    }
    if let Some(from) = &card.from {
        facts.push(format!("from {from}"));
    }
    if let Some(origin) = settings.origin_of(card) {
        facts.push(format!("posted on {origin}'s board"));
    }
    facts.push(format!("posted {} ago", compact_age(card.created_at, now)));
    writeln!(out, "{}", facts.join(", "))?;
    if let Some(detail) = &card.detail {
        writeln!(out, "\n{detail}")?;
    }
    if let Some(resolution) = &card.resolution {
        writeln!(out, "\nResolved: {resolution}")?;
    }
    if !card.thread.is_empty() {
        writeln!(out, "\nConversation:")?;
        for message in &card.thread {
            let done = if message.done {
                " (marked it done)"
            } else {
                ""
            };
            writeln!(
                out,
                "- {} ({} ago){done}: {}",
                message.from,
                compact_age(message.at, now),
                message.text
            )?;
        }
    }
    Ok(())
}

fn run_resolve(args: &[String], store: &BoardStore, out: &mut dyn std::io::Write) -> Result<()> {
    let mut queries: Vec<&String> = Vec::new();
    let mut ticket: Option<String> = None;
    let mut kind: Option<CardKind> = None;
    let mut note: Option<String> = None;
    let mut by: Option<String> = None;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--ticket" | "-t" => ticket = Some(value_of(arg, &mut iter)?.clone()),
            "--kind" | "-k" => {
                let value = value_of(arg, &mut iter)?;
                kind = Some(CardKind::parse(value).ok_or_else(|| {
                    anyhow::anyhow!(
                        "unknown kind {value:?}; use one of task, validate, confirm, info"
                    )
                })?);
            }
            "--note" | "-n" => note = Some(value_of(arg, &mut iter)?.clone()),
            "--from" => by = Some(value_of(arg, &mut iter)?.clone()),
            "-h" | "--help" => {
                writeln!(out, "{BOARD_HELP}")?;
                return Ok(());
            }
            flag if flag.starts_with("--") => bail!("unknown flag: {flag}"),
            _ => {
                if CardId::parse(arg).is_none() {
                    bail!("{arg:?} is not a card number");
                }
                queries.push(arg);
            }
        }
    }
    let by = by.or_else(default_from);
    match (queries.is_empty(), ticket) {
        (true, None) => bail!("`yaran board resolve` needs card ids or --ticket <id>"),
        (false, Some(_)) => bail!("give card ids or --ticket, not both"),
        (true, Some(ticket)) => {
            if super::normalize_ticket(&ticket).is_none() {
                bail!("--ticket needs a ticket reference");
            }
            let resolved = store.update(|board| {
                Ok(board.resolve_ticket(&ticket, kind, by.as_deref(), note.as_deref(), Utc::now()))
            })?;
            if resolved.is_empty() {
                writeln!(out, "no open card is about ticket {ticket}")?;
            } else {
                let list = resolved
                    .iter()
                    .map(|id| format!("#{id}"))
                    .collect::<Vec<_>>()
                    .join(", ");
                writeln!(out, "resolved {list}")?;
            }
            Ok(())
        }
        (false, None) => {
            if kind.is_some() {
                bail!("--kind only narrows --ticket");
            }
            let changed = store.update(|board| {
                let now = Utc::now();
                queries
                    .iter()
                    .map(|query| {
                        let id = board.find(query)?;
                        board
                            .resolve(&id, by.as_deref(), note.as_deref(), now)
                            .map(|changed| (id, changed))
                    })
                    .collect::<Result<Vec<_>>>()
            })?;
            for (id, changed) in changed {
                if changed {
                    writeln!(out, "resolved #{id}")?;
                } else {
                    writeln!(out, "#{id} was already resolved")?;
                }
            }
            Ok(())
        }
    }
}

fn run_list(args: &[String], settings: &BoardSettings, out: &mut dyn std::io::Write) -> Result<()> {
    let mut all = false;
    let mut json = false;
    let mut person: Option<String> = None;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--all" | "-a" => all = true,
            "--json" => json = true,
            "--for" | "--assignee" => {
                person = settings.person(value_of(arg, &mut iter)?)?;
            }
            "--mine" => {
                person = Some(settings.me.clone().ok_or_else(|| {
                    anyhow::anyhow!("--mine needs [board] me: who runs this yaran")
                })?);
            }
            "-h" | "--help" => {
                writeln!(out, "{BOARD_HELP}")?;
                return Ok(());
            }
            other => bail!("unknown argument to `yaran board list`: {other}"),
        }
    }
    let board = settings.store.load()?;
    let view = match person.as_deref() {
        Some(person) => Audience::Person(person),
        None => Audience::Everyone,
    };
    let mut cards: Vec<&Card> = board.open_cards_in(&view);
    if all {
        cards.extend(board.recently_resolved_in(&view, usize::MAX));
    }
    if json {
        serde_json::to_writer_pretty(&mut *out, &cards)?;
        writeln!(out)?;
        return Ok(());
    }
    for problem in &board.problems {
        writeln!(out, "note: {problem}")?;
    }
    if cards.is_empty() {
        match person {
            Some(person) => writeln!(out, "nothing on the board for {person}")?,
            None => writeln!(out, "the board is empty")?,
        }
        return Ok(());
    }
    let now = Utc::now();
    for card in cards {
        let mut state = match (card.is_open(), card.resolved_by.as_deref()) {
            (true, _) => card.kind.as_str().to_string(),
            (false, Some(by)) => format!("{} (resolved by {by})", card.kind.as_str()),
            (false, None) => format!("{} (resolved)", card.kind.as_str()),
        };
        if card.priority != Priority::Normal {
            state = format!("{state}, {}", card.priority);
        }
        let whose = card
            .assignee
            .as_deref()
            .map(|person| format!("  for {person}"))
            .unwrap_or_default();
        let from = card
            .from
            .as_deref()
            .map(|from| format!("  from {from}"))
            .unwrap_or_default();
        writeln!(
            out,
            "{:<14} {:<22} {:>4}  {}{whose}{from}",
            card.label(),
            state,
            compact_age(card.updated_at, now),
            card.title
        )?;
    }
    Ok(())
}

/// `import [<file>]`: copy a private board document's cards into the shared
/// folder. Each card keeps its number behind this machine's prefix when that
/// id is free, and a card already imported (same title and creation time) is
/// skipped, so running it twice copies nothing twice. Cards for nobody in
/// particular go to `[board] me`. The document itself is left as it is.
fn run_import(
    args: &[String],
    settings: &BoardSettings,
    out: &mut dyn std::io::Write,
) -> Result<()> {
    let store = &settings.store;
    if !store.is_folder() {
        bail!(
            "`yaran board import` copies cards into a shared board folder; set [board] dir \
             first (this board is already the private document)"
        );
    }
    let document = match args {
        [] => store.private_document().load()?,
        [path] if !path.starts_with('-') => {
            let path = PathBuf::from(path);
            let bytes = std::fs::read(&path)
                .with_context(|| format!("could not read {}", path.display()))?;
            serde_json::from_slice::<Board>(&bytes)
                .with_context(|| format!("{} is not a board document", path.display()))?
        }
        _ => bail!("`yaran board import` takes at most one board document path"),
    };
    let me = settings.me.clone();
    let imported = store.update(|board| {
        let mut moved = Vec::new();
        for card in &document.cards {
            // A note keeps whole seconds, so that is the precision compared.
            let already = board.cards.iter().any(|existing| {
                existing.title == card.title
                    && existing.created_at.timestamp() == card.created_at.timestamp()
            });
            if already {
                continue;
            }
            let wanted = CardId::new(store.prefix(), card.id.number());
            let id = if board.card(&wanted).is_none() && !board.reserved.contains(&wanted) {
                wanted
            } else {
                board.next_card_id()
            };
            let mut copy = card.clone();
            copy.id = id.clone();
            if copy.assignee.is_none() {
                copy.assignee = me.clone();
            }
            board.cards.push(copy);
            moved.push((card.id.clone(), id));
        }
        Ok(moved)
    })?;
    if imported.is_empty() {
        writeln!(
            out,
            "nothing to import: every card is already on the shared board"
        )?;
        return Ok(());
    }
    for (from, to) in &imported {
        writeln!(out, "#{from} -> #{to}")?;
    }
    writeln!(
        out,
        "imported {} card{} into {}",
        imported.len(),
        if imported.len() == 1 { "" } else { "s" },
        store.path().display()
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(words: &[&str]) -> Vec<String> {
        words.iter().map(|w| w.to_string()).collect()
    }

    fn run(store: &BoardStore, words: &[&str]) -> Result<String> {
        run_stdin(store, words, "")
    }

    fn settings(store: &BoardStore) -> BoardSettings {
        BoardSettings {
            store: store.clone(),
            people: Vec::new(),
            me: None,
            sync: super::super::sync::SyncMode::Off,
            sync_every: std::time::Duration::from_secs(60),
            relay: false,
            relay_to: None,
            relay_transport: "auto".to_string(),
        }
    }

    fn run_stdin(store: &BoardStore, words: &[&str], input: &str) -> Result<String> {
        run_as(&settings(store), words, input)
    }

    fn run_as(settings: &BoardSettings, words: &[&str], input: &str) -> Result<String> {
        let mut out = Vec::new();
        let mut stdin = input.as_bytes();
        run_with(&args(words), settings, &mut stdin, &mut out)?;
        Ok(String::from_utf8(out).unwrap())
    }

    fn store() -> (tempfile::TempDir, BoardStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = BoardStore::new(dir.path());
        (dir, store)
    }

    #[test]
    fn post_prints_the_new_number_and_stores_every_field() {
        let (_dir, store) = store();
        let out = run(
            &store,
            &[
                "post",
                "--kind",
                "validate",
                "--ticket",
                "#4812",
                "--from",
                "orchestrator",
                "--detail",
                "PR #417 merged",
                "Check",
                "the",
                "signup",
                "page",
            ],
        )
        .unwrap();
        assert_eq!(out, "posted #1 (validate)\n");
        let board = store.load().unwrap();
        let card = board.card(1).unwrap();
        assert_eq!(card.kind, CardKind::Validate);
        assert_eq!(card.ticket.as_deref(), Some("4812"));
        assert_eq!(card.title, "Check the signup page");
        assert_eq!(card.detail.as_deref(), Some("PR #417 merged"));
        assert_eq!(card.from.as_deref(), Some("orchestrator"));
    }

    #[test]
    fn posting_the_same_ticket_and_kind_again_updates_the_card() {
        let (_dir, store) = store();
        run(&store, &["post", "-k", "confirm", "-t", "7", "first"]).unwrap();
        let out = run(&store, &["post", "-k", "confirm", "-t", "7", "second"]).unwrap();
        assert_eq!(out, "updated #1 (confirm)\n");
        let board = store.load().unwrap();
        assert_eq!(board.cards.len(), 1);
        assert_eq!(board.cards[0].title, "second");
    }

    #[test]
    fn detail_dash_reads_standard_input() {
        let (_dir, store) = store();
        run_stdin(
            &store,
            &["post", "--kind", "task", "--detail", "-", "Decide"],
            "line one\nline two\n",
        )
        .unwrap();
        let board = store.load().unwrap();
        assert_eq!(board.cards[0].detail.as_deref(), Some("line one\nline two"));
    }

    #[test]
    fn a_title_may_contain_words_that_look_like_flags_after_the_first_word() {
        let (_dir, store) = store();
        run(
            &store,
            &[
                "post",
                "--kind",
                "info",
                "ran",
                "--help",
                "and",
                "--verbose",
            ],
        )
        .unwrap();
        assert_eq!(
            store.load().unwrap().cards[0].title,
            "ran --help and --verbose"
        );
        // Known flags still work after the title, and `--` ends them.
        run(&store, &["post", "Check", "it", "--kind", "validate"]).unwrap();
        assert_eq!(
            store.load().unwrap().card(2).unwrap().kind,
            CardKind::Validate
        );
        run(
            &store,
            &["post", "-k", "task", "--", "--kind", "is", "a", "word"],
        )
        .unwrap();
        assert_eq!(
            store.load().unwrap().card(3).unwrap().title,
            "--kind is a word"
        );
    }

    #[test]
    fn post_refuses_a_missing_or_unknown_kind_and_a_missing_title() {
        let (_dir, store) = store();
        let err = run(&store, &["post", "no kind"]).unwrap_err();
        assert!(format!("{err}").contains("needs --kind"), "{err}");
        let err = run(&store, &["post", "--kind", "urgent", "x"]).unwrap_err();
        assert!(format!("{err}").contains("unknown kind"), "{err}");
        let err = run(&store, &["post", "--kind", "task"]).unwrap_err();
        assert!(format!("{err}").contains("needs a title"), "{err}");
        let err = run(&store, &["post", "--kind"]).unwrap_err();
        assert!(format!("{err}").contains("needs a value"), "{err}");
        let err = run(&store, &["post", "--bogus", "x"]).unwrap_err();
        assert!(format!("{err}").contains("unknown flag"), "{err}");
        assert!(store.load().unwrap().cards.is_empty());
    }

    #[test]
    fn resolve_by_number_and_by_ticket() {
        let (_dir, store) = store();
        run(&store, &["post", "-k", "task", "-t", "1", "a"]).unwrap();
        run(&store, &["post", "-k", "validate", "-t", "1", "b"]).unwrap();
        run(&store, &["post", "-k", "info", "c"]).unwrap();

        assert_eq!(run(&store, &["resolve", "#3"]).unwrap(), "resolved #3\n");
        assert_eq!(
            run(&store, &["resolve", "3"]).unwrap(),
            "#3 was already resolved\n"
        );
        assert_eq!(
            run(&store, &["resolve", "--ticket", "1", "--kind", "validate"]).unwrap(),
            "resolved #2\n"
        );
        assert_eq!(
            run(&store, &["resolve", "--ticket", "#1", "--note", "shipped"]).unwrap(),
            "resolved #1\n"
        );
        assert_eq!(
            run(&store, &["resolve", "--ticket", "1"]).unwrap(),
            "no open card is about ticket 1\n"
        );
        let board = store.load().unwrap();
        assert!(board.open_cards().is_empty());
        assert_eq!(
            board.card(1).unwrap().resolution.as_deref(),
            Some("shipped")
        );
    }

    #[test]
    fn resolve_refuses_unknown_numbers_and_ambiguous_requests() {
        let (_dir, store) = store();
        run(&store, &["post", "-k", "task", "a"]).unwrap();
        let err = run(&store, &["resolve", "9"]).unwrap_err();
        assert!(format!("{err}").contains("no card #9"), "{err}");
        let err = run(&store, &["resolve"]).unwrap_err();
        assert!(format!("{err}").contains("needs card ids"), "{err}");
        let err = run(&store, &["resolve", "1", "--ticket", "x"]).unwrap_err();
        assert!(format!("{err}").contains("not both"), "{err}");
        let err = run(&store, &["resolve", "one"]).unwrap_err();
        assert!(format!("{err}").contains("not a card number"), "{err}");
        // A refused resolve of several numbers changes none of them.
        let err = run(&store, &["resolve", "1", "9"]).unwrap_err();
        assert!(format!("{err}").contains("no card #9"), "{err}");
        assert!(store.load().unwrap().card(1).unwrap().is_open());
    }

    #[test]
    fn reopen_puts_a_card_back() {
        let (_dir, store) = store();
        run(&store, &["post", "-k", "task", "a"]).unwrap();
        run(&store, &["resolve", "1"]).unwrap();
        assert_eq!(run(&store, &["reopen", "1"]).unwrap(), "reopened #1\n");
        assert_eq!(
            run(&store, &["reopen", "1"]).unwrap(),
            "#1 was already open\n"
        );
        assert!(store.load().unwrap().card(1).unwrap().is_open());
    }

    #[test]
    fn list_shows_open_cards_and_all_adds_history() {
        let (_dir, store) = store();
        assert_eq!(run(&store, &["list"]).unwrap(), "the board is empty\n");
        run(&store, &["post", "-k", "info", "-t", "5", "deployed"]).unwrap();
        run(&store, &["post", "-k", "task", "pick a name"]).unwrap();
        run(&store, &["resolve", "1", "--from", "tester"]).unwrap();

        let open = run(&store, &["list"]).unwrap();
        assert!(open.contains("pick a name"), "{open}");
        assert!(!open.contains("deployed"), "{open}");

        let all = run(&store, &["list", "--all"]).unwrap();
        assert!(all.contains("#1 [5]"), "{all}");
        assert!(all.contains("info (resolved by tester)"), "{all}");

        let json = run(&store, &["list", "--json", "--all"]).unwrap();
        let cards: Vec<Card> = serde_json::from_str(&json).unwrap();
        assert_eq!(cards.len(), 2);
        assert_eq!(cards[0].id, 2, "open cards come first");
    }

    #[test]
    fn priority_is_posted_changed_and_listed() {
        let (_dir, store) = store();
        assert_eq!(
            run(&store, &["post", "-k", "task", "-p", "high", "soon please"]).unwrap(),
            "posted #1 (task)\n"
        );
        run(&store, &["post", "-k", "task", "later"]).unwrap();
        assert_eq!(
            store.load().unwrap().card(1).unwrap().priority,
            Priority::High
        );
        assert_eq!(
            store.load().unwrap().card(2).unwrap().priority,
            Priority::Normal
        );
        assert_eq!(
            run(&store, &["priority", "2", "critical"]).unwrap(),
            "#2 is now critical\n"
        );
        assert_eq!(
            run(&store, &["priority", "2", "p0"]).unwrap(),
            "#2 was already critical\n"
        );
        let listed = run(&store, &["list"]).unwrap();
        let first = listed.lines().next().unwrap();
        assert!(
            first.contains("#2") && first.contains("task, critical"),
            "{listed}"
        );
        assert!(
            listed.lines().nth(1).unwrap().contains("task, high"),
            "{listed}"
        );
        let err = run(&store, &["post", "-k", "task", "-p", "asap", "x"]).unwrap_err();
        assert!(format!("{err}").contains("unknown priority"), "{err}");
        let err = run(&store, &["priority", "2"]).unwrap_err();
        assert!(format!("{err}").contains("needs a card id"), "{err}");
    }

    #[test]
    fn help_and_unknown_subcommands() {
        let (_dir, store) = store();
        assert!(run(&store, &[]).unwrap().contains("yaran board post"));
        assert!(run(&store, &["post", "--help"]).unwrap().contains("Kinds:"));
        let err = run(&store, &["frobnicate"]).unwrap_err();
        assert!(
            format!("{err}").contains("unknown board subcommand"),
            "{err}"
        );
        assert!(!store.path().exists(), "help writes nothing");
    }

    fn team(home: &std::path::Path) -> BoardSettings {
        BoardSettings {
            store: BoardStore::folder(&home.join("vault/Board"), home, "S"),
            people: vec!["Sam".to_string(), "Alex".to_string()],
            me: Some("Sam".to_string()),
            sync: super::super::sync::SyncMode::Off,
            sync_every: std::time::Duration::from_secs(60),
            relay: false,
            relay_to: None,
            relay_transport: "auto".to_string(),
        }
    }

    #[test]
    fn a_card_goes_to_me_unless_it_names_someone_else() {
        let home = tempfile::tempdir().unwrap();
        let team = team(home.path());
        assert_eq!(
            run_as(&team, &["post", "-k", "task", "mine"], "").unwrap(),
            "posted #S-1 (task, for Sam)\n"
        );
        assert_eq!(
            run_as(
                &team,
                &["post", "-k", "task", "--for", "alex", "theirs"],
                ""
            )
            .unwrap(),
            "posted #S-2 (task, for Alex)\n"
        );
        assert_eq!(
            run_as(
                &team,
                &["post", "-k", "info", "--for", "anyone", "news"],
                ""
            )
            .unwrap(),
            "posted #S-3 (info)\n"
        );
        let err = run_as(&team, &["post", "-k", "task", "--for", "Kim", "x"], "").unwrap_err();
        assert!(format!("{err}").contains("Sam, Alex"), "{err}");

        // The same ticket and kind for two people is two cards.
        run_as(&team, &["post", "-k", "task", "-t", "9", "a"], "").unwrap();
        run_as(
            &team,
            &["post", "-k", "task", "-t", "9", "--for", "Alex", "b"],
            "",
        )
        .unwrap();
        assert_eq!(team.store.load().unwrap().cards.len(), 5);
    }

    #[test]
    fn list_narrows_to_a_queue_and_assign_moves_a_card() {
        let home = tempfile::tempdir().unwrap();
        let team = team(home.path());
        run_as(&team, &["post", "-k", "task", "for sam"], "").unwrap();
        run_as(
            &team,
            &["post", "-k", "task", "--for", "Alex", "for alex"],
            "",
        )
        .unwrap();
        run_as(
            &team,
            &["post", "-k", "info", "--for", "anyone", "for all"],
            "",
        )
        .unwrap();

        let mine = run_as(&team, &["list", "--mine"], "").unwrap();
        assert!(
            mine.contains("for sam") && mine.contains("for all"),
            "{mine}"
        );
        assert!(!mine.contains("for alex"), "{mine}");
        let alex = run_as(&team, &["list", "--for", "ALEX"], "").unwrap();
        assert!(
            alex.contains("for alex") && !alex.contains("for sam"),
            "{alex}"
        );

        assert_eq!(
            run_as(&team, &["assign", "1", "Alex"], "").unwrap(),
            "#S-1 is now in Alex's queue\n",
            "a bare number names this machine's card"
        );
        assert_eq!(
            run_as(&team, &["assign", "S-1", "alex"], "").unwrap(),
            "#S-1 was already in Alex's queue\n"
        );
        assert_eq!(
            run_as(&team, &["assign", "s-1", "anyone"], "").unwrap(),
            "#S-1 is now in everybody's queue\n"
        );
        let json = run_as(&team, &["list", "--json"], "").unwrap();
        assert!(json.contains("\"id\": \"S-2\""), "{json}");
        assert!(json.contains("\"assignee\": \"Alex\""), "{json}");
    }

    #[test]
    fn a_bare_number_shared_by_two_prefixes_is_refused() {
        let home = tempfile::tempdir().unwrap();
        let team = team(home.path());
        let other = BoardSettings {
            store: BoardStore::folder(&home.path().join("vault/Board"), home.path(), "A"),
            ..team.clone()
        };
        run_as(&other, &["post", "-k", "task", "from a"], "").unwrap();
        // This machine (S) resolves #1: only A-1 has that number, so it is that.
        assert_eq!(
            run_as(&team, &["resolve", "1"], "").unwrap(),
            "resolved #A-1\n"
        );
        run_as(&team, &["post", "-k", "task", "from s"], "").unwrap();
        run_as(&other, &["post", "-k", "task", "from a again"], "").unwrap();
        // Now S-1 and A-2 exist beside A-1: #1 is this machine's S-1.
        assert_eq!(
            run_as(&team, &["reopen", "1"], "").unwrap(),
            "#S-1 was already open\n"
        );
        let third = BoardSettings {
            store: BoardStore::folder(&home.path().join("vault/Board"), home.path(), "Z"),
            ..team.clone()
        };
        let err = run_as(&third, &["resolve", "1"], "").unwrap_err();
        assert!(format!("{err}").contains("#A-1, #S-1"), "{err}");
    }

    #[test]
    fn import_copies_a_private_board_once() {
        let home = tempfile::tempdir().unwrap();
        let private = BoardStore::new(home.path());
        run(&private, &["post", "-k", "task", "old one"]).unwrap();
        run(&private, &["post", "-k", "info", "old two"]).unwrap();
        run(&private, &["resolve", "2"]).unwrap();

        let team = team(home.path());
        let out = run_as(&team, &["import"], "").unwrap();
        assert!(
            out.contains("#1 -> #S-1") && out.contains("#2 -> #S-2"),
            "{out}"
        );
        let board = team.store.load().unwrap();
        assert_eq!(board.cards.len(), 2);
        assert!(
            board
                .cards
                .iter()
                .all(|c| c.assignee.as_deref() == Some("Sam"))
        );
        assert!(!board.card(CardId::new("S", 2)).unwrap().is_open());

        let again = run_as(&team, &["import"], "").unwrap();
        assert!(again.contains("nothing to import"), "{again}");
        assert!(
            private.path().exists(),
            "the private board is left as it was"
        );

        let err = run(&private, &["import"]).unwrap_err();
        assert!(format!("{err}").contains("set [board] dir"), "{err}");
        let err = run(&private, &["sync"]).unwrap_err();
        assert!(format!("{err}").contains("nothing to sync"), "{err}");
    }

    #[test]
    fn reply_show_and_blocking_carry_a_conversation() {
        let home = tempfile::tempdir().unwrap();
        let sam = team(home.path());
        let out = run_as(
            &sam,
            &[
                "post",
                "-k",
                "confirm",
                "--for",
                "Alex",
                "--blocking",
                "--from",
                "orchestrator",
                "Drop",
                "the",
                "table?",
            ],
            "",
        )
        .unwrap();
        assert_eq!(out, "posted #S-1 (confirm, for Alex)\n");
        let card = sam
            .store
            .load()
            .unwrap()
            .card(CardId::new("S", 1))
            .unwrap()
            .clone();
        assert!(card.blocking);
        assert_eq!(
            card.origin.as_deref(),
            Some("Sam"),
            "the card says whose board posted it"
        );

        // Alex's machine shares the folder and answers from there.
        let mut alex = team(home.path());
        alex.me = Some("Alex".to_string());
        assert_eq!(
            run_as(
                &alex,
                &["reply", "S-1", "--from", "Alex", "Which", "table?"],
                ""
            )
            .unwrap(),
            "replied on #S-1\n"
        );
        assert_eq!(
            run_as(
                &sam,
                &["reply", "S-1", "--from", "orchestrator", "-"],
                "The audit table.\n"
            )
            .unwrap(),
            "replied on #S-1\n"
        );
        assert_eq!(
            run_as(
                &alex,
                &[
                    "reply", "1", "--done", "--from", "Alex", "--", "--yes", "drop", "it"
                ],
                ""
            )
            .unwrap(),
            "replied on #S-1 and marked it done\n"
        );
        let card = sam
            .store
            .load()
            .unwrap()
            .card(CardId::new("S", 1))
            .unwrap()
            .clone();
        assert!(!card.is_open());
        let thread: Vec<(String, Option<String>, String)> = card
            .thread
            .iter()
            .map(|m| (m.from.clone(), m.side.clone(), m.text.clone()))
            .collect();
        assert_eq!(
            thread,
            [
                (
                    "Alex".to_string(),
                    Some("Alex".to_string()),
                    "Which table?".to_string()
                ),
                (
                    "orchestrator".to_string(),
                    Some("Sam".to_string()),
                    "The audit table.".to_string()
                ),
                (
                    "Alex".to_string(),
                    Some("Alex".to_string()),
                    "--yes drop it".to_string()
                ),
            ]
        );

        let shown = run_as(&sam, &["show", "S-1"], "").unwrap();
        assert!(shown.starts_with("#S-1 Drop the table?\n"), "{shown}");
        assert!(
            shown.contains("blocking, for Alex, from orchestrator, posted on Sam's board"),
            "{shown}"
        );
        assert!(shown.contains("Conversation:\n- Alex ("), "{shown}");
        assert!(shown.contains("(marked it done): --yes drop it"), "{shown}");
        let json = run_as(&sam, &["show", "S-1", "--json"], "").unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["thread"].as_array().unwrap().len(), 3);

        assert_eq!(
            run_as(&sam, &["blocking", "S-1", "no"], "").unwrap(),
            "#S-1 now does not hold anybody up\n"
        );
        assert_eq!(
            run_as(&sam, &["blocking", "S-1", "no"], "").unwrap(),
            "#S-1 already does not hold anybody up\n"
        );
    }

    #[test]
    fn reply_refuses_what_it_cannot_carry() {
        let home = tempfile::tempdir().unwrap();
        let sam = team(home.path());
        run_as(&sam, &["post", "-k", "task", "x"], "").unwrap();
        let err = run_as(&sam, &["reply"], "").unwrap_err();
        assert!(err.to_string().contains("card id"), "{err}");
        let err = run_as(&sam, &["reply", "S-1"], "").unwrap_err();
        assert!(err.to_string().contains("needs the reply"), "{err}");
        let err = run_as(&sam, &["reply", "S-9", "hi"], "").unwrap_err();
        assert!(err.to_string().contains("no card"), "{err}");
        let err = run_as(&sam, &["reply", "S-1", "--bogus", "hi"], "").unwrap_err();
        assert!(err.to_string().contains("unknown flag"), "{err}");
        let err = run_as(&sam, &["blocking", "S-1", "maybe"], "").unwrap_err();
        assert!(err.to_string().contains("yes or no"), "{err}");
        let err = run_as(&sam, &["show"], "").unwrap_err();
        assert!(err.to_string().contains("card id"), "{err}");
    }
}
