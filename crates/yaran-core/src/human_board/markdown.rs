//! One card as one Markdown note: what a folder board keeps on disk.
//!
//! The card's fields are the note's properties (a YAML front-matter block,
//! which notes apps such as Obsidian show and edit as a property table), and
//! its detail is the note's body:
//!
//! ```text
//! ---
//! id: "G-12"
//! kind: task
//! priority: high
//! status: open
//! assignee: "Sam"
//! title: "Approve the migration"
//! ticket: "4812"
//! from: "orchestrator"
//! created: 2026-10-14T20:11:05Z
//! updated: 2026-10-14T20:11:05Z
//! ---
//!
//! The detail, as Markdown.
//! ```
//!
//! yaran writes every text value as a double-quoted string with JSON escapes,
//! which is valid YAML, so a title holding a colon or a quote cannot break the
//! block. A person may edit the note by hand (or through a notes app that
//! rewrites the block in its own style), so the reader accepts the plain,
//! single-quoted and block forms of YAML scalars too. It is deliberately not
//! a YAML parser: it reads top-level `name: value` properties and skips
//! everything else (lists, nested maps), which is all a card needs.
//!
//! Notes come from other machines and other people, so every value goes
//! through the same cleaning and length bounds a posted card does.

use std::collections::BTreeMap;

use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, SecondsFormat, TimeZone, Utc};

use super::id::CardId;
use super::{
    Card, CardKind, MAX_DETAIL_CHARS, MAX_FROM_CHARS, MAX_NOTE_CHARS, MAX_TITLE_CHARS, Priority,
    clean, normalize_ticket,
};

/// Why a note that looks like a card could not be read as one.
pub type ParseError = String;

/// The note for `card`.
pub fn render(card: &Card) -> String {
    fn word(out: &mut String, key: &str, value: &str) {
        out.push_str(key);
        out.push_str(": ");
        out.push_str(value);
        out.push('\n');
    }
    fn text(out: &mut String, key: &str, value: Option<&str>) {
        if let Some(value) = value {
            word(out, key, &quote(value));
        }
    }
    let status = if card.is_open() {
        STATUS_OPEN
    } else {
        STATUS_DONE
    };
    let mut out = String::from("---\n");
    text(&mut out, "id", Some(&card.id.to_string()));
    word(&mut out, "kind", card.kind.as_str());
    word(&mut out, "priority", card.priority.as_str());
    word(&mut out, "status", status);
    text(&mut out, "assignee", card.assignee.as_deref());
    text(&mut out, "title", Some(&card.title));
    text(&mut out, "ticket", card.ticket.as_deref());
    text(&mut out, "from", card.from.as_deref());
    word(&mut out, "created", &timestamp(card.created_at));
    word(&mut out, "updated", &timestamp(card.updated_at));
    if let Some(resolved_at) = card.resolved_at {
        word(&mut out, "resolved", &timestamp(resolved_at));
    }
    text(&mut out, "resolved_by", card.resolved_by.as_deref());
    text(&mut out, "resolution", card.resolution.as_deref());
    out.push_str("---\n");
    if let Some(detail) = card.detail.as_deref() {
        out.push('\n');
        out.push_str(detail);
        out.push('\n');
    }
    out
}

const STATUS_OPEN: &str = "open";
const STATUS_DONE: &str = "done";

fn timestamp(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// A string as a YAML double-quoted scalar. JSON's string escapes are a subset
/// of YAML's, so the JSON encoder does the work.
fn quote(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

/// Read a note. `Ok(None)` when it is not a card at all (no property block,
/// or one with neither a kind nor a title: an ordinary note living in the
/// folder). `file_stem` is the id when the note does not name one, and
/// `modified` stands in for a timestamp it does not carry.
pub fn parse(
    text: &str,
    file_stem: &str,
    modified: DateTime<Utc>,
) -> Result<Option<Card>, ParseError> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let text = text.replace("\r\n", "\n");
    let mut lines = text.split('\n');
    if lines.next().map(str::trim_end) != Some("---") {
        return Ok(None);
    }
    let mut block = Vec::new();
    let mut closed = false;
    for line in lines.by_ref() {
        if matches!(line.trim_end(), "---" | "...") {
            closed = true;
            break;
        }
        block.push(line);
    }
    if !closed {
        return Err("its property block (between the --- lines) never ends".to_string());
    }
    let body: Vec<&str> = lines.collect();
    let props = parse_properties(&block)?;
    if !props.contains_key("kind") && !props.contains_key("title") {
        return Ok(None);
    }

    let kind_text = props.get("kind").ok_or("it has no kind")?;
    let kind = CardKind::parse(kind_text).ok_or_else(|| {
        format!("its kind {kind_text:?} is not one of task, validate, confirm, info")
    })?;
    let title = props
        .get("title")
        .and_then(|title| clean(title, MAX_TITLE_CHARS, false))
        .ok_or("it has no title")?;
    let id = match props.get("id") {
        Some(id) => CardId::parse(id).ok_or_else(|| format!("its id {id:?} is not a card id"))?,
        None => CardId::parse(file_stem).ok_or_else(|| {
            format!("it has no id, and its file name {file_stem:?} is not one either")
        })?,
    };
    let priority = match props.get("priority") {
        Some(level) => Priority::parse(level).ok_or_else(|| {
            format!("its priority {level:?} is not one of critical, high, normal, low")
        })?,
        None => Priority::Normal,
    };
    let open = match props.get("status") {
        Some(status) => parse_status(status).ok_or_else(|| {
            format!("its status {status:?} is neither {STATUS_OPEN} nor {STATUS_DONE}")
        })?,
        None => true,
    };
    let time = |key: &str| -> Result<Option<DateTime<Utc>>, ParseError> {
        props
            .get(key)
            .map(|value| {
                parse_time(value).ok_or_else(|| format!("its {key} {value:?} is not a date"))
            })
            .transpose()
    };
    let created_at = time("created")?.unwrap_or(modified);
    // A note with no update time was last changed when it was made: the file's
    // own time is not used here, because a checkout rewrites it on every
    // machine and the update time is what settles two edits of one card.
    let updated_at = time("updated")?.unwrap_or(created_at).max(created_at);
    let resolved_at = if open {
        None
    } else {
        Some(time("resolved")?.unwrap_or(updated_at))
    };
    let text_prop = |key: &str, max: usize, keep_newlines: bool| {
        props
            .get(key)
            .and_then(|value| clean(value, max, keep_newlines))
    };
    let body = body.join("\n");
    Ok(Some(Card {
        id,
        kind,
        priority,
        assignee: text_prop("assignee", MAX_FROM_CHARS, false),
        ticket: props
            .get("ticket")
            .and_then(|ticket| normalize_ticket(ticket)),
        title,
        detail: clean(body.trim(), MAX_DETAIL_CHARS, true),
        from: text_prop("from", MAX_FROM_CHARS, false),
        created_at,
        updated_at,
        resolved_at,
        resolved_by: if open {
            None
        } else {
            text_prop("resolved_by", MAX_FROM_CHARS, false)
        },
        resolution: if open {
            None
        } else {
            text_prop("resolution", MAX_NOTE_CHARS, true)
        },
    }))
}

/// `Some(true)` for an open card, `Some(false)` for a done one. Accepts the
/// words an issue tracker's columns use, since a person may type them.
fn parse_status(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "open" | "todo" | "to do" | "to-do" | "in progress" | "in-progress" | "doing"
        | "waiting" | "blocked" | "reopened" => Some(true),
        "done" | "resolved" | "closed" | "complete" | "completed" | "finished" => Some(false),
        _ => None,
    }
}

/// A timestamp as yaran writes it (RFC 3339), or as a notes app writes a date
/// or date-and-time property (no zone: read as this machine's local time).
fn parse_time(value: &str) -> Option<DateTime<Utc>> {
    let value = value.trim();
    if let Ok(at) = DateTime::parse_from_rfc3339(value) {
        return Some(at.with_timezone(&Utc));
    }
    let naive = [
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
    ]
    .iter()
    .find_map(|format| NaiveDateTime::parse_from_str(value, format).ok())
    .or_else(|| {
        NaiveDate::parse_from_str(value, "%Y-%m-%d")
            .ok()
            .and_then(|date| date.and_hms_opt(0, 0, 0))
    })?;
    Local
        .from_local_datetime(&naive)
        .earliest()
        .map(|at| at.with_timezone(&Utc))
}

/// The top-level `name: value` properties of a property block. Names are
/// lower-cased; a later duplicate wins. Lines that belong to a list or a
/// nested map (indented, or starting with `-`) are skipped along with the
/// property that owns them, since no card field is one.
fn parse_properties(lines: &[&str]) -> Result<BTreeMap<String, String>, ParseError> {
    let mut props = BTreeMap::new();
    let mut at = 0;
    while at < lines.len() {
        let line = lines[at];
        at += 1;
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if line.starts_with([' ', '\t', '-']) {
            continue;
        }
        let Some((name, raw)) = line.split_once(':') else {
            return Err(format!(
                "its property line {trimmed:?} is not `name: value`"
            ));
        };
        let name = name.trim().to_ascii_lowercase();
        let raw = raw.trim();
        let value = if let Some(style) = raw.chars().next().filter(|c| matches!(c, '|' | '>')) {
            let start = at;
            while at < lines.len()
                && (lines[at].trim().is_empty() || lines[at].starts_with([' ', '\t']))
            {
                at += 1;
            }
            block_scalar(&lines[start..at], style == '>')
        } else {
            scalar(raw).map_err(|why| format!("its {name} {why}"))?
        };
        match value {
            Some(value) => {
                props.insert(name, value);
            }
            None => {
                props.remove(&name);
            }
        }
    }
    Ok(props)
}

/// A `|` (literal) or `>` (folded) block scalar's lines, de-indented.
fn block_scalar(lines: &[&str], folded: bool) -> Option<String> {
    let indent = lines
        .iter()
        .filter(|line| !line.trim().is_empty())
        .map(|line| line.len() - line.trim_start().len())
        .min()?;
    let lines: Vec<&str> = lines
        .iter()
        .map(|line| line.get(indent..).unwrap_or("").trim_end())
        .collect();
    let joined = if folded {
        let mut out = String::new();
        for line in lines {
            if line.is_empty() {
                out.push('\n');
            } else {
                if !out.is_empty() && !out.ends_with('\n') {
                    out.push(' ');
                }
                out.push_str(line);
            }
        }
        out
    } else {
        lines.join("\n")
    };
    let trimmed = joined.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// One flow scalar. `Ok(None)` for null and for flow collections (`[a, b]`),
/// which no card field is.
fn scalar(raw: &str) -> Result<Option<String>, String> {
    if raw.is_empty() || raw == "~" || raw.eq_ignore_ascii_case("null") {
        return Ok(None);
    }
    if raw.starts_with('"') {
        return serde_json::from_str::<String>(raw)
            .or_else(|_| yaml_double_quoted(raw))
            .map(Some);
    }
    if let Some(inner) = raw.strip_prefix('\'') {
        let inner = inner
            .strip_suffix('\'')
            .ok_or("is a quoted value with no closing quote")?;
        return Ok(Some(inner.replace("''", "'")));
    }
    if raw.starts_with(['[', '{']) {
        return Ok(None);
    }
    let value = match raw.find(" #") {
        Some(comment) => &raw[..comment],
        None => raw,
    }
    .trim();
    Ok((!value.is_empty()).then(|| value.to_string()))
}

/// A YAML double-quoted scalar that is not also valid JSON: YAML has escapes
/// JSON lacks (`\x41`, `\e`, `\ `, ...).
fn yaml_double_quoted(raw: &str) -> Result<String, String> {
    let inner = raw
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .ok_or("is a quoted value with no closing quote")?;
    let mut out = String::new();
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c == '"' {
            return Err("is a quoted value with a stray quote in it".to_string());
        }
        if c != '\\' {
            out.push(c);
            continue;
        }
        let escape = chars.next().ok_or("ends in a lone backslash")?;
        let hex = |chars: &mut std::str::Chars<'_>, digits: usize| -> Result<char, String> {
            let code: String = chars.by_ref().take(digits).collect();
            u32::from_str_radix(&code, 16)
                .ok()
                .filter(|_| code.len() == digits)
                .and_then(char::from_u32)
                .ok_or_else(|| format!("has a bad escape \\{escape}{code}"))
        };
        out.push(match escape {
            '0' => '\0',
            'a' => '\u{7}',
            'b' => '\u{8}',
            't' | '\t' => '\t',
            'n' => '\n',
            'v' => '\u{b}',
            'f' => '\u{c}',
            'r' => '\r',
            'e' => '\u{1b}',
            ' ' => ' ',
            '"' => '"',
            '/' => '/',
            '\\' => '\\',
            'N' => '\u{85}',
            '_' => '\u{a0}',
            'L' => '\u{2028}',
            'P' => '\u{2029}',
            'x' => hex(&mut chars, 2)?,
            'u' => hex(&mut chars, 4)?,
            'U' => hex(&mut chars, 8)?,
            other => return Err(format!("has an unknown escape \\{other}")),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;

    fn at(minute: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 14, 20, minute, 0).unwrap()
    }

    fn sample() -> Card {
        Card {
            id: CardId::new("G", 12),
            kind: CardKind::Validate,
            priority: Priority::High,
            assignee: Some("Sam".to_string()),
            ticket: Some("4812".to_string()),
            title: "Check the \"signup\" page: it moved".to_string(),
            detail: Some("Line one.\n\n- a list item\n---\nnot a property block".to_string()),
            from: Some("orchestrator".to_string()),
            created_at: at(1),
            updated_at: at(2),
            resolved_at: None,
            resolved_by: None,
            resolution: None,
        }
    }

    #[test]
    fn a_card_survives_the_round_trip_through_its_note() {
        let card = sample();
        let note = render(&card);
        assert!(
            note.starts_with("---\nid: \"G-12\"\nkind: validate\n"),
            "{note}"
        );
        assert_eq!(parse(&note, "whatever", at(0)).unwrap(), Some(card.clone()));

        let mut done = card;
        done.resolved_at = Some(at(3));
        done.resolved_by = Some("human".to_string());
        done.resolution = Some("Looks right.\nShipped.".to_string());
        done.detail = None;
        let note = render(&done);
        assert!(note.contains("status: done\n"), "{note}");
        assert!(note.ends_with("---\n"), "no body without a detail: {note}");
        assert_eq!(parse(&note, "x", at(0)).unwrap(), Some(done));
    }

    #[test]
    fn a_hand_written_note_reads_with_plain_and_single_quoted_values() {
        let note = "---\r\n\
                    kind: Task\r\n\
                    title: Pick a name # a comment\r\n\
                    assignee: 'Sam O''Neil'\r\n\
                    priority: P2\r\n\
                    status: In Progress\r\n\
                    tags:\r\n  - board\r\n  - human\r\n\
                    created: 2026-10-10T21:00\r\n\
                    aliases: [a, b]\r\n\
                    ---\r\n\
                    Some detail.\r\n";
        let card = parse(note, "S-3", at(0)).unwrap().unwrap();
        assert_eq!(card.id, CardId::new("S", 3), "the file name is the id");
        assert_eq!(card.kind, CardKind::Task);
        assert_eq!(card.title, "Pick a name");
        assert_eq!(card.assignee.as_deref(), Some("Sam O'Neil"));
        assert_eq!(card.priority, Priority::High);
        assert!(card.is_open());
        assert_eq!(card.detail.as_deref(), Some("Some detail."));
        assert_eq!(
            card.updated_at, card.created_at,
            "no updated: the created time"
        );
        assert_ne!(
            card.created_at,
            at(0),
            "the note's own date wins over the file's"
        );
    }

    #[test]
    fn block_and_yaml_only_escapes_are_read() {
        let note = "---\nkind: info\ntitle: \"tab\\there \\x41\"\nresolution: |\n  first\n  second\nstatus: done\nresolved: 2026-10-14T20:05:00Z\n---\n";
        let card = parse(note, "4", at(0)).unwrap().unwrap();
        assert_eq!(card.title, "tab here A", "a title is one line");
        assert_eq!(card.resolution.as_deref(), Some("first\nsecond"));
        assert_eq!(card.resolved_at, Some(at(5)));
        assert_eq!(card.id, CardId::plain(4));
    }

    #[test]
    fn ordinary_notes_are_not_cards_and_broken_cards_say_why() {
        assert_eq!(parse("# Just a note\n", "README", at(0)).unwrap(), None);
        assert_eq!(
            parse("---\ntags: [x]\n---\nbody", "README", at(0)).unwrap(),
            None
        );

        let err = |note: &str| parse(note, "G-1", at(0)).unwrap_err();
        assert!(err("---\nkind: task\ntitle: x\n").contains("never ends"));
        assert!(err("---\nkind: chore\ntitle: x\n---\n").contains("kind \"chore\""));
        assert!(err("---\ntitle: x\n---\n").contains("no kind"));
        assert!(err("---\nkind: task\n---\n").contains("no title"));
        assert!(err("---\nkind: task\ntitle: x\npriority: asap\n---\n").contains("priority"));
        assert!(err("---\nkind: task\ntitle: x\nstatus: maybe\n---\n").contains("status"));
        assert!(err("---\nkind: task\ntitle: x\ncreated: soon\n---\n").contains("created"));
        assert!(err("---\nkind: task\ntitle: 'x\n---\n").contains("closing quote"));
        assert!(err("---\nkind task\n---\n").contains("name: value"));
        let no_id = parse("---\nkind: task\ntitle: x\n---\n", "notes", at(0)).unwrap_err();
        assert!(no_id.contains("no id"), "{no_id}");
    }

    #[test]
    fn values_from_a_note_are_cleaned_like_posted_ones() {
        let note = "---\nkind: task\ntitle: \"\\u001b[31mred\\u001b[0m title\"\nid: G-2\n---\n";
        let card = parse(note, "G-2", at(0)).unwrap().unwrap();
        // The sanitizer shows a control byte as its escape rather than
        // passing it to the terminal.
        assert!(!card.title.contains('\x1b'), "{:?}", card.title);
        assert_eq!(card.title, "\\x1b[31mred\\x1b[0m title");
        let long = format!("---\nkind: task\ntitle: {}\n---\n", "x".repeat(400));
        let card = parse(&long, "G-3", at(0)).unwrap().unwrap();
        assert_eq!(card.title.chars().count(), MAX_TITLE_CHARS);
    }

    #[test]
    fn a_done_card_reopened_by_hand_forgets_its_resolution() {
        let mut card = sample();
        card.resolved_at = Some(at(3));
        card.resolved_by = Some("human".to_string());
        card.resolution = Some("ok".to_string());
        let note = render(&card).replace("status: done", "status: open");
        let read = parse(&note, "G-12", at(0)).unwrap().unwrap();
        assert!(read.is_open());
        assert_eq!(read.resolved_by, None);
        assert_eq!(read.resolution, None);
    }
}
