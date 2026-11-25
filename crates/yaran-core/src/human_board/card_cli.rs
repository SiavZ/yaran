//! Read a whole board card and save its agent-written TL;DR.

use std::io::Read;

use anyhow::{Result, bail};
use jiff::Timestamp;

use super::super::{BoardSettings, compact_age};
use super::BOARD_HELP;

pub(super) fn run_summarize(
    args: &[String],
    settings: &BoardSettings,
    stdin: &mut dyn Read,
    out: &mut dyn std::io::Write,
) -> Result<()> {
    let [query, flag, revision, words @ ..] = args else {
        bail!("use yaran board summarize <id> --revision <summary_revision> <text>|-");
    };
    if flag != "--revision" {
        bail!("read yaran board show <id> --json, then pass --revision <summary_revision>");
    }
    let words = words.strip_prefix(&["--".to_string()]).unwrap_or(words);
    let text = if words == ["-"] {
        let mut text = String::new();
        stdin.take(16_000).read_to_string(&mut text)?;
        text
    } else {
        words.join(" ")
    };
    let id = settings.store.update(|board| {
        let id = board.find(query)?;
        board.summarize(&id, revision, &text, Timestamp::now())?;
        Ok(id)
    })?;
    writeln!(out, "Updated the TL;DR for #{id}.")?;
    Ok(())
}

pub(super) fn run_show(
    args: &[String],
    settings: &BoardSettings,
    out: &mut dyn std::io::Write,
) -> Result<()> {
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
            _ => bail!("yaran board show takes one card id"),
        }
    }
    let Some(query) = query else {
        bail!("yaran board show needs a card id");
    };
    let board = settings.store.load()?;
    let id = board.find(query)?;
    let Some(card) = board.card(&id) else {
        bail!("there is no card #{id} on the board");
    };
    if json {
        let mut value = serde_json::to_value(card)?;
        value["summary_revision"] = card.summary_revision().into();
        value["summary_current"] = card.summary_current().into();
        writeln!(out, "{}", serde_json::to_string_pretty(&value)?)?;
        return Ok(());
    }
    let now = Timestamp::now();
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
    if let Some(summary) = &card.summary {
        let status = if card.summary_current() {
            "current"
        } else {
            "needs updating"
        };
        writeln!(out, "\nTL;DR ({status}): {}", summary.text)?;
    }
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
