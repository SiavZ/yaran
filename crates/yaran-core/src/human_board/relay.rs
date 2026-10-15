//! Passing a card's conversation from people to agents (`[board] relay`).
//!
//! On a shared board a person on another machine answers a card an agent of
//! this machine posted, or assigns a card of their own to the person running
//! this yaran. Neither reaches an agent by itself: the agent is here, the
//! words arrived through the board. While the terminal UI runs, it plans
//! [`RelayJob`]s from every board it reads and sends each one the way
//! `yaran peer send` sends a message, never by typing into a terminal; once
//! sent, the messages are marked relayed on the card, so each is passed
//! exactly once and both sides can see that it was.
//!
//! Which agent a card belongs to on this machine:
//!
//! - the agent that posted it, when the card was posted here and that agent
//!   is one of this yaran's sessions;
//! - otherwise `[board] relay_to`, for a card posted on another side and
//!   assigned to the person running this yaran: someone there handed it over.
//!
//! What is passed is only what another side wrote: what this side's person
//! types into an agent reaches it directly, and an agent's own answers need
//! no echo.

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use chrono::{DateTime, Utc};

use super::{
    Board, BoardSettings, BoardStore, Card, CardId, MAX_DETAIL_CHARS, Message, clean, same_person,
};
use crate::bounded_command::{CommandOutcome, DEFAULT_READER_DRAIN, run_command_with_timeout};

/// Longest card detail quoted when a whole card is handed to an agent.
pub const RELAY_DETAIL_CHARS: usize = 2_000;
/// How long one relay may take to send before it is given up and retried.
pub const RELAY_TIMEOUT: Duration = Duration::from_secs(30);

/// One message (or card) to pass to one agent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RelayJob {
    pub card: CardId,
    /// The agent handle it goes to.
    pub to: String,
    /// Who it is from, as an AMQ handle: the person whose side wrote it.
    pub sender: String,
    /// The person, as configured, for the status line.
    pub person: String,
    /// What the agent receives.
    pub text: String,
    /// The card itself is being handed over (see [`Card::relayed_at`]).
    pub card_itself: bool,
    /// The messages it carries, by [`Message::key`], owned.
    pub messages: Vec<(DateTime<Utc>, String, String)>,
}

impl RelayJob {
    /// A name for this job that stays the same until it is done, so the same
    /// work is never sent twice while one send is still in flight.
    pub fn key(&self) -> String {
        let newest = self
            .messages
            .last()
            .map(|(at, from, _)| format!("{}|{from}", at.timestamp_millis()))
            .unwrap_or_default();
        format!("{}|{}|{newest}", self.card, self.card_itself)
    }
}

/// Send `job` with the yaran binary at `exe` (`yaran peer send`, so it takes
/// the route every agent message takes), then record it on the card in
/// `store`. A send that fails records nothing, so the job is planned again.
pub fn deliver(job: &RelayJob, transport: &str, exe: &Path, store: &BoardStore) -> Result<()> {
    let mut cmd = Command::new(exe);
    cmd.arg("peer")
        .arg("send")
        .arg("--transport")
        .arg(transport)
        .arg("--from")
        .arg(&job.sender)
        .arg(&job.to)
        .arg(&job.text);
    let label = format!("yaran peer send to {}", job.to);
    match run_command_with_timeout(cmd, RELAY_TIMEOUT, DEFAULT_READER_DRAIN, &label) {
        CommandOutcome::Completed(output) if output.status.success() => {}
        CommandOutcome::Completed(output) => {
            let why = crate::sanitize::for_terminal(String::from_utf8_lossy(&output.stderr).trim());
            let why = if why.is_empty() {
                format!("it exited with {}", output.status)
            } else {
                why
            };
            bail!("{label} failed: {why}");
        }
        CommandOutcome::TimedOut => {
            bail!("{label} took longer than {}s", RELAY_TIMEOUT.as_secs())
        }
        CommandOutcome::Failed(why) => return Err(anyhow!("could not run {label}: {why}")),
    }
    record(job, store, Utc::now())
}

/// Mark what `job` carried as relayed on its card.
pub fn record(job: &RelayJob, store: &BoardStore, now: DateTime<Utc>) -> Result<()> {
    store.update(|board| {
        if job.card_itself {
            board.mark_card_relayed(&job.card, now)?;
        }
        for (at, from, text) in &job.messages {
            board.mark_relayed(&job.card, (*at, from, text), now)?;
        }
        Ok(())
    })
}

/// The relays `board` needs. `is_local_agent` says whether a handle is one of
/// this yaran's agent sessions. Nothing when relaying is off or this machine
/// has no person (`[board] me`).
pub fn plan(
    board: &Board,
    settings: &BoardSettings,
    is_local_agent: &dyn Fn(&str) -> bool,
) -> Vec<RelayJob> {
    if !settings.relay {
        return Vec::new();
    }
    let Some(me) = settings.me.as_deref() else {
        return Vec::new();
    };
    let mut jobs = Vec::new();
    for card in &board.cards {
        let origin = settings.origin_of(card);
        let posted_here = origin
            .as_deref()
            .is_none_or(|origin| same_person(origin, me));
        // Handed over: someone on another side assigned it to `me`. A card the
        // other side's agents merely posted for `me` is a question for the
        // person, and waits for them on the board.
        let handed_over = !posted_here
            && card
                .assignee
                .as_deref()
                .is_some_and(|assignee| same_person(assignee, me))
            && card
                .assigned_by
                .as_deref()
                .is_some_and(|by| !same_person(by, me));
        let to = match (&card.from, &settings.relay_to) {
            (Some(poster), _) if posted_here && is_local_agent(poster) => poster.clone(),
            (_, Some(relay_to)) if handed_over => relay_to.clone(),
            _ => continue,
        };
        let pending: Vec<&Message> = card
            .thread
            .iter()
            .filter(|message| message.relayed_at.is_none() && !message.is_from_side(me))
            .collect();
        let card_itself = handed_over && card.relayed_at.is_none() && card.is_open();
        if !card_itself && pending.is_empty() {
            continue;
        }
        let person = pending
            .first()
            .map(|message| message.side.clone().unwrap_or_else(|| message.from.clone()))
            .or_else(|| card.assigned_by.clone().filter(|_| card_itself))
            .or_else(|| origin.clone())
            .unwrap_or_else(|| "someone".to_string());
        let text = if card_itself {
            card_text(card, &person, me, &pending)
        } else {
            reply_text(card, &person, &pending)
        };
        jobs.push(RelayJob {
            card: card.id.clone(),
            to,
            sender: crate::sanitize::amq_handle(&person),
            person,
            text,
            card_itself,
            messages: pending
                .iter()
                .map(|message| (message.at, message.from.clone(), message.text.clone()))
                .collect(),
        });
    }
    jobs
}

/// How a card is named to an agent: `card #G-12 [4812] "Approve it"`.
fn card_name(card: &Card) -> String {
    let title = clean(&card.title, 120, false).unwrap_or_default();
    format!("card {} \"{title}\"", card.label())
}

/// The messages, one line each (a message keeps its own line breaks).
fn message_lines(messages: &[&Message]) -> String {
    messages
        .iter()
        .map(|message| {
            let done = if message.done {
                " (and marked the card done)"
            } else {
                ""
            };
            format!("- {}{done}: {}", message.from, message.text)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// What the agent that posted `card` gets when another side answered on it.
fn reply_text(card: &Card, person: &str, messages: &[&Message]) -> String {
    let id = &card.id;
    format!(
        "Board: {person} answered on {name}, which you posted.\n{lines}\n\
         Answer on the card, not here: yaran board reply {id} \"...\" reaches {person}. \
         yaran board show {id} prints the whole card and its conversation.",
        name = card_name(card),
        lines = message_lines(messages),
    )
}

/// What `[board] relay_to` gets when another side hands `card` to `me`.
fn card_text(card: &Card, person: &str, me: &str, messages: &[&Message]) -> String {
    let id = &card.id;
    let mut text = format!(
        "Board: {person} assigned {name} to {me}. Kind: {kind}, priority: {priority}.",
        name = card_name(card),
        kind = card.kind,
        priority = card.priority,
    );
    if let Some(detail) = card
        .detail
        .as_deref()
        .and_then(|detail| clean(detail, RELAY_DETAIL_CHARS.min(MAX_DETAIL_CHARS), true))
    {
        text.push('\n');
        text.push_str(&detail);
    }
    if !messages.is_empty() {
        text.push_str("\nSo far on the card:\n");
        text.push_str(&message_lines(messages));
    }
    text.push_str(&format!(
        "\nTake it on and report on the card, not here: yaran board reply {id} \"...\" reaches \
         {person}; when it is finished, yaran board reply {id} --done \"what was done\". \
         yaran board show {id} prints the whole card."
    ));
    text
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;
    use crate::human_board::{BoardStore, CardKind, NewCard, NewMessage, sync::SyncMode};

    fn at(minute: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 15, 9, minute, 0).unwrap()
    }

    fn settings(me: &str, relay_to: Option<&str>) -> BoardSettings {
        BoardSettings {
            store: BoardStore::folder(
                std::path::Path::new("/nonexistent/Board"),
                std::path::Path::new("/nonexistent"),
                &me[..1],
            ),
            people: vec!["Sam".to_string(), "Alex".to_string()],
            me: Some(me.to_string()),
            sync: SyncMode::Off,
            sync_every: std::time::Duration::from_secs(60),
            relay: true,
            relay_to: relay_to.map(str::to_string),
            relay_transport: "amq".to_string(),
        }
    }

    fn post(board: &mut Board, origin: &str, from: &str, assignee: &str) -> CardId {
        board.prefix = origin[..1].to_string();
        board
            .post(
                NewCard {
                    kind: Some(CardKind::Confirm),
                    title: "Drop the table?".to_string(),
                    detail: Some("It is the old audit table.".to_string()),
                    from: Some(from.to_string()),
                    assignee: Some(assignee.to_string()),
                    origin: Some(origin.to_string()),
                    ..NewCard::default()
                },
                at(0),
            )
            .unwrap()
            .id()
    }

    fn say(board: &mut Board, id: &CardId, from: &str, side: &str, text: &str, done: bool) {
        board
            .reply(
                id,
                NewMessage {
                    from: from.to_string(),
                    side: Some(side.to_string()),
                    text: text.to_string(),
                    done,
                },
                at(1),
            )
            .unwrap();
    }

    fn here(handle: &str) -> bool {
        handle == "orchestrator"
    }

    #[test]
    fn another_sides_answer_goes_to_the_agent_that_asked() {
        let sam = settings("Sam", None);
        let mut board = Board::default();
        let id = post(&mut board, "Sam", "orchestrator", "Alex");
        assert!(plan(&board, &sam, &here).is_empty(), "nothing to pass yet");

        say(
            &mut board,
            &id,
            "orchestrator",
            "Sam",
            "Asking again.",
            false,
        );
        assert!(
            plan(&board, &sam, &here).is_empty(),
            "this side's words are not echoed"
        );

        say(&mut board, &id, "Alex", "Alex", "Yes, drop it.", true);
        let jobs = plan(&board, &sam, &here);
        assert_eq!(jobs.len(), 1);
        let job = &jobs[0];
        assert_eq!(job.to, "orchestrator");
        assert_eq!(job.sender, "alex");
        assert_eq!(job.person, "Alex");
        assert!(!job.card_itself);
        assert_eq!(job.messages.len(), 1);
        assert!(
            job.text.contains("Alex answered on card #S-1"),
            "{}",
            job.text
        );
        assert!(
            job.text
                .contains("- Alex (and marked the card done): Yes, drop it."),
            "{}",
            job.text
        );
        assert!(job.text.contains("yaran board reply S-1"), "{}", job.text);

        // Once marked relayed it is never planned again.
        let (at, from, text) = job.messages[0].clone();
        board.mark_relayed(&id, (at, &from, &text), at).unwrap();
        assert!(plan(&board, &sam, &here).is_empty());
    }

    #[test]
    fn a_card_handed_over_goes_to_relay_to_with_its_conversation() {
        let mut board = Board::default();
        let id = post(&mut board, "Alex", "Alex", "Sam");
        say(
            &mut board,
            &id,
            "Alex",
            "Alex",
            "Needed before Friday.",
            false,
        );
        assert!(
            plan(&board, &settings("Sam", Some("hub")), &here).is_empty(),
            "posted for Sam is a question for Sam: it waits for the person"
        );
        board.assign(&id, None, Some("Alex"), at(1)).unwrap();
        board.assign(&id, Some("Sam"), Some("Alex"), at(1)).unwrap();

        assert!(
            plan(&board, &settings("Sam", None), &here).is_empty(),
            "without relay_to it waits for a person"
        );
        let sam = settings("Sam", Some("hub"));
        let jobs = plan(&board, &sam, &here);
        assert_eq!(jobs.len(), 1);
        let job = &jobs[0];
        assert_eq!(job.to, "hub");
        assert!(job.card_itself);
        assert!(
            job.text.starts_with("Board: Alex assigned card #A-1"),
            "{}",
            job.text
        );
        assert!(
            job.text.contains("It is the old audit table."),
            "{}",
            job.text
        );
        assert!(
            job.text.contains("- Alex: Needed before Friday."),
            "{}",
            job.text
        );
        assert!(job.text.contains("--done"), "{}", job.text);

        board.mark_card_relayed(&id, at(2)).unwrap();
        for (at, from, text) in &job.messages {
            board.mark_relayed(&id, (*at, from, text), *at).unwrap();
        }
        assert!(plan(&board, &sam, &here).is_empty());

        // Alex's own board never relays Alex's card back to an agent there.
        assert!(plan(&board, &settings("Alex", Some("hub")), &|_| true).is_empty());
    }

    #[test]
    fn delivering_sends_through_peer_send_and_records_it_once() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let store = BoardStore::folder(&dir.path().join("Board"), dir.path(), "S");
        let id = store
            .update(|board| {
                board.prefix = "S".to_string();
                let id = post(board, "Sam", "orchestrator", "Alex");
                say(board, &id, "Alex", "Alex", "Yes.", false);
                Ok(id)
            })
            .unwrap();
        let log = dir.path().join("sent.txt");
        let fake = dir.path().join("fake-yaran");
        std::fs::write(
            &fake,
            format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > {}\n", log.display()),
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();

        let board = store.load().unwrap();
        let jobs = plan(&board, &settings("Sam", None), &here);
        deliver(&jobs[0], "amq", &fake, &store).unwrap();
        let sent = std::fs::read_to_string(&log).unwrap();
        let args: Vec<&str> = sent.lines().collect();
        assert_eq!(
            &args[..7],
            [
                "peer",
                "send",
                "--transport",
                "amq",
                "--from",
                "alex",
                "orchestrator"
            ]
        );
        assert!(sent.contains("Alex answered on card #S-1"), "{sent}");
        let card = store.load().unwrap().card(&id).unwrap().clone();
        assert!(card.thread[0].relayed_at.is_some());
        assert!(plan(&store.load().unwrap(), &settings("Sam", None), &here).is_empty());

        // A send that fails records nothing: the job comes back next time.
        let failing = dir.path().join("failing-yaran");
        std::fs::write(&failing, "#!/bin/sh\necho 'no such agent' >&2\nexit 1\n").unwrap();
        std::fs::set_permissions(&failing, std::fs::Permissions::from_mode(0o755)).unwrap();
        store
            .update(|board| {
                say(board, &id, "Alex", "Alex", "Also: today.", false);
                Ok(())
            })
            .unwrap();
        let jobs = plan(&store.load().unwrap(), &settings("Sam", None), &here);
        let err = deliver(&jobs[0], "amq", &failing, &store).unwrap_err();
        assert!(err.to_string().contains("no such agent"), "{err}");
        assert_eq!(
            plan(&store.load().unwrap(), &settings("Sam", None), &here).len(),
            1
        );
    }

    #[test]
    fn nothing_is_relayed_when_off_or_to_an_agent_of_another_machine() {
        let mut board = Board::default();
        let id = post(&mut board, "Sam", "orchestrator", "Alex");
        say(&mut board, &id, "Alex", "Alex", "Yes.", false);
        let mut off = settings("Sam", None);
        off.relay = false;
        assert!(plan(&board, &off, &here).is_empty());
        assert!(
            plan(&board, &settings("Sam", None), &|_| false).is_empty(),
            "the poster is not one of this yaran's agents"
        );
        let mut nobody = settings("Sam", None);
        nobody.me = None;
        assert!(plan(&board, &nobody, &here).is_empty());
    }
}
