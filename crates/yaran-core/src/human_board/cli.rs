//! `yaran board`: how agents put cards on the human board, and take them off.
//!
//! Dispatched by the binary before the terminal UI's own argument handling,
//! like `yaran peer`, and for the same reasons: it runs inside agents while a
//! yaran holds the single-instance lock, and a card title may legitimately
//! contain `--help`. It touches nothing but the board file.

use std::io::Read;

use anyhow::{Result, bail};
use chrono::Utc;

use super::{BoardStore, Card, CardKind, NewCard, PostOutcome, compact_age};
use crate::config::YaranPaths;

pub const BOARD_HELP: &str = "\
yaran board - cards for the person running yaran

Agents post a card when something needs a person or should not be missed.
The terminal UI shows the open cards (the \"Tasks for Human\" pane) until
they are marked done there or resolved here.

Subcommands:
  yaran board post --kind <kind> [--ticket <id>] [--detail <text>|-] [--from <who>] <title...>
                       Put a card on the board and print its number. An open
                       card is unique per ticket and kind: posting again with
                       the same --ticket and --kind updates it in place.
                       --detail - reads the detail from standard input.
  yaran board resolve <number>... [--note <text>]
  yaran board resolve --ticket <id> [--kind <kind>] [--note <text>]
                       Take cards off the board. They stay in its history.
  yaran board reopen <number>
                       Put a resolved card back on the board.
  yaran board list [--all] [--json]
                       Show the open cards; --all adds the resolved history.

Kinds:
  task       something only a person can do or decide
  validate   work is done and a person should check it
  confirm    an agent is waiting for a yes or no before it carries on
  info       what happened, for the record; nothing is asked

The poster is --from, else $YARAN_AMQ_HANDLE or $AM_ME, which yaran sets
for every agent it launches.";

/// Entry point for `yaran board <args>`.
pub fn run_board(args: &[String], paths: &YaranPaths) -> Result<()> {
    let store = BoardStore::new(&paths.root);
    let mut stdin = std::io::stdin();
    run_with(args, &store, &mut stdin, &mut std::io::stdout())
}

/// The testable body of [`run_board`]: everything comes in through arguments.
pub fn run_with(
    args: &[String],
    store: &BoardStore,
    stdin: &mut dyn Read,
    out: &mut dyn std::io::Write,
) -> Result<()> {
    let sub = args.first().map(String::as_str).unwrap_or("");
    let rest = args.get(1..).unwrap_or_default();
    match sub {
        "post" | "add" => {
            let Some(card) = parse_post(rest, stdin)? else {
                writeln!(out, "{BOARD_HELP}")?;
                return Ok(());
            };
            let kind = card.kind;
            let outcome = store.update(|board| board.post(card, Utc::now()))?;
            let verb = match outcome {
                PostOutcome::Added(_) => "posted",
                PostOutcome::Updated(_) => "updated",
            };
            let kind = kind.map(CardKind::as_str).unwrap_or_default();
            writeln!(out, "{verb} #{} ({kind})", outcome.id())?;
            Ok(())
        }
        "resolve" | "done" => run_resolve(rest, store, out),
        "reopen" => {
            let ids = parse_ids(rest)?;
            if ids.is_empty() {
                bail!("`yaran board reopen` needs a card number");
            }
            let changed = store.update(|board| {
                let now = Utc::now();
                ids.iter()
                    .map(|id| board.reopen(*id, now).map(|changed| (*id, changed)))
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
        "list" | "ls" => run_list(rest, store, out),
        "" | "--help" | "-h" | "help" => {
            writeln!(out, "{BOARD_HELP}")?;
            Ok(())
        }
        other => bail!("unknown board subcommand: {other}\nRun `yaran board --help` for usage."),
    }
}

/// The poster when `--from` is not given: the handle yaran gives every agent.
fn default_from() -> Option<String> {
    ["YARAN_AMQ_HANDLE", "AM_ME"]
        .iter()
        .find_map(|var| crate::brand_env::var(var).ok())
        .filter(|value| !value.trim().is_empty())
}

/// The value after a flag, or an error naming the flag.
fn value_of<'a>(flag: &str, iter: &mut impl Iterator<Item = &'a String>) -> Result<&'a String> {
    match iter.next() {
        Some(value) => Ok(value),
        None => bail!("{flag} needs a value"),
    }
}

/// Parse `post`'s arguments. `Ok(None)` is a request for the help text.
fn parse_post(args: &[String], stdin: &mut dyn Read) -> Result<Option<NewCard>> {
    let mut card = NewCard::default();
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
            "--ticket" | "-t" => card.ticket = Some(value_of(arg, &mut iter)?.clone()),
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
    Ok(Some(card))
}

/// Card numbers, written `12` or `#12`.
fn parse_ids(args: &[String]) -> Result<Vec<u64>> {
    args.iter()
        .map(|arg| {
            arg.trim_start_matches('#')
                .parse::<u64>()
                .map_err(|_| anyhow::anyhow!("{arg:?} is not a card number"))
        })
        .collect()
}

fn run_resolve(args: &[String], store: &BoardStore, out: &mut dyn std::io::Write) -> Result<()> {
    let mut ids = Vec::new();
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
            _ => ids.extend(parse_ids(std::slice::from_ref(arg))?),
        }
    }
    let by = by.or_else(default_from);
    match (ids.is_empty(), ticket) {
        (true, None) => bail!("`yaran board resolve` needs card numbers or --ticket <id>"),
        (false, Some(_)) => bail!("give card numbers or --ticket, not both"),
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
                ids.iter()
                    .map(|id| {
                        board
                            .resolve(*id, by.as_deref(), note.as_deref(), now)
                            .map(|changed| (*id, changed))
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

fn run_list(args: &[String], store: &BoardStore, out: &mut dyn std::io::Write) -> Result<()> {
    let mut all = false;
    let mut json = false;
    for arg in args {
        match arg.as_str() {
            "--all" | "-a" => all = true,
            "--json" => json = true,
            "-h" | "--help" => {
                writeln!(out, "{BOARD_HELP}")?;
                return Ok(());
            }
            other => bail!("unknown argument to `yaran board list`: {other}"),
        }
    }
    let board = store.load()?;
    let mut cards: Vec<&Card> = board.open_cards();
    if all {
        cards.extend(board.recently_resolved(usize::MAX));
    }
    if json {
        serde_json::to_writer_pretty(&mut *out, &cards)?;
        writeln!(out)?;
        return Ok(());
    }
    if cards.is_empty() {
        writeln!(out, "the board is empty")?;
        return Ok(());
    }
    let now = Utc::now();
    for card in cards {
        let state = match (card.is_open(), card.resolved_by.as_deref()) {
            (true, _) => card.kind.as_str().to_string(),
            (false, Some(by)) => format!("{} (resolved by {by})", card.kind.as_str()),
            (false, None) => format!("{} (resolved)", card.kind.as_str()),
        };
        let from = card
            .from
            .as_deref()
            .map(|from| format!("  from {from}"))
            .unwrap_or_default();
        writeln!(
            out,
            "{:<14} {:<22} {:>4}  {}{from}",
            card.label(),
            state,
            compact_age(card.updated_at, now),
            card.title
        )?;
    }
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

    fn run_stdin(store: &BoardStore, words: &[&str], input: &str) -> Result<String> {
        let mut out = Vec::new();
        let mut stdin = input.as_bytes();
        run_with(&args(words), store, &mut stdin, &mut out)?;
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
        assert!(format!("{err}").contains("needs card numbers"), "{err}");
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
}
