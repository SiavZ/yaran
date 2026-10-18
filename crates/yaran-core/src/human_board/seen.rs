//! What the person running this yaran has read on the board.
//!
//! A shared board carries messages between people, and a person wants to
//! see at a glance that the other side wrote something new. Which cards and
//! messages this person has already opened is theirs alone, so it lives in
//! the yaran home ([`SEEN_FILE`]), never in the shared folder.
//!
//! The file starts as a baseline of everything on the board the first time it
//! is needed, so turning the feature on does not light up a board's whole
//! history as unread.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};

use super::{Board, Card, Message};

/// The file, in the yaran home.
pub const SEEN_FILE: &str = "human_board_seen.json";

/// What one card's reader has seen of it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SeenCard {
    /// The card itself was opened (or was on the board at the baseline).
    #[serde(default)]
    pub opened: bool,
    /// The messages already read, by [`message_key`].
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub messages: BTreeSet<String>,
}

/// What the person running this yaran has read, card by card.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SeenState {
    #[serde(default)]
    pub cards: BTreeMap<String, SeenCard>,
}

/// One message's name in the file: when and by whom. [`Board::reply`] never
/// gives one writer two messages at the same instant.
pub fn message_key(message: &Message) -> String {
    format!(
        "{}|{}",
        message.at.to_rfc3339_opts(SecondsFormat::AutoSi, true),
        message.from
    )
}

impl SeenState {
    /// Everything on `board` counted as read.
    pub fn baseline(board: &Board) -> Self {
        let mut state = SeenState::default();
        for card in &board.cards {
            state.mark_read(card);
        }
        state
    }

    /// The file in the yaran home at `home`.
    pub fn path(home: &Path) -> PathBuf {
        home.join(SEEN_FILE)
    }

    /// Read the file. `Ok(None)` when there is none yet; a damaged file is
    /// an error, and the caller starts from a fresh baseline rather than
    /// lighting up every card.
    pub fn load(path: &Path) -> Result<Option<Self>> {
        let text = match fs::read_to_string(path) {
            Ok(text) => text,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) => {
                return Err(err).with_context(|| format!("could not read {}", path.display()));
            }
        };
        serde_json::from_str(&text)
            .map(Some)
            .with_context(|| format!("{} is not a read-state file", path.display()))
    }

    /// Write the file whole, owner-only.
    pub fn save(&self, path: &Path) -> Result<()> {
        let body = serde_json::to_vec_pretty(self)?;
        super::store::write_private(path, &body)
    }

    /// Count `card` and every message on it as read. Returns whether that
    /// changed anything.
    pub fn mark_read(&mut self, card: &Card) -> bool {
        let entry = self.cards.entry(card.id.to_string()).or_default();
        let mut changed = !entry.opened;
        entry.opened = true;
        for message in &card.thread {
            changed |= entry.messages.insert(message_key(message));
        }
        changed
    }

    /// Whether `card` holds something `me` has not read yet from another
    /// side: the card itself, when `origin` (the side that posted it) is not
    /// `me`, or a message written on another side. What this side wrote is
    /// never unread here.
    pub fn is_unread(&self, card: &Card, me: &str, origin: Option<&str>) -> bool {
        let entry = self.cards.get(&card.id.to_string());
        let from_elsewhere = origin.is_some_and(|origin| !super::same_person(origin, me));
        if from_elsewhere && !entry.is_some_and(|entry| entry.opened) {
            return true;
        }
        card.thread.iter().any(|message| {
            !message.is_from_side(me)
                && !entry.is_some_and(|entry| entry.messages.contains(&message_key(message)))
        })
    }

    /// Forget cards that are no longer on `board`. Returns whether any were.
    pub fn prune(&mut self, board: &Board) -> bool {
        let before = self.cards.len();
        self.cards
            .retain(|id, _| board.cards.iter().any(|card| card.id.to_string() == *id));
        self.cards.len() != before
    }
}

/// When the newest thing on `card` happened, for ordering what is unread.
pub fn latest_activity(card: &Card) -> DateTime<Utc> {
    card.thread
        .last()
        .map(|message| message.at.max(card.updated_at))
        .unwrap_or(card.updated_at)
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;
    use crate::human_board::{CardKind, NewCard, NewMessage};

    fn at(minute: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 15, 9, minute, 0).unwrap()
    }

    fn board_with(origin: &str) -> (Board, crate::human_board::CardId) {
        let mut board = Board::default();
        let id = board
            .post(
                NewCard {
                    kind: Some(CardKind::Task),
                    title: "Decide".to_string(),
                    origin: Some(origin.to_string()),
                    ..NewCard::default()
                },
                at(0),
            )
            .unwrap()
            .id();
        (board, id)
    }

    fn reply(board: &mut Board, id: &crate::human_board::CardId, from: &str, minute: u32) {
        board
            .reply(
                id,
                NewMessage {
                    from: from.to_string(),
                    side: Some(from.to_string()),
                    text: format!("from {from}"),
                    done: false,
                },
                at(minute),
            )
            .unwrap();
    }

    #[test]
    fn a_card_from_the_other_side_is_unread_until_opened() {
        let (board, id) = board_with("Alex");
        let mut seen = SeenState::default();
        let card = board.card(&id).unwrap();
        assert!(seen.is_unread(card, "Sam", Some("Alex")));
        assert!(
            !seen.is_unread(card, "Alex", Some("Alex")),
            "your own side's card is not news"
        );
        assert!(seen.mark_read(card));
        assert!(!seen.mark_read(card));
        assert!(!seen.is_unread(card, "Sam", Some("Alex")));
    }

    #[test]
    fn a_message_from_the_other_side_is_unread_and_your_own_is_not() {
        let (mut board, id) = board_with("Sam");
        let mut seen = SeenState::baseline(&board);
        reply(&mut board, &id, "Sam", 1);
        assert!(!seen.is_unread(board.card(&id).unwrap(), "Sam", Some("Sam")));
        reply(&mut board, &id, "Alex", 2);
        assert!(seen.is_unread(board.card(&id).unwrap(), "Sam", Some("Sam")));
        seen.mark_read(board.card(&id).unwrap());
        assert!(!seen.is_unread(board.card(&id).unwrap(), "Sam", Some("Sam")));
    }

    #[test]
    fn the_file_round_trips_and_forgets_cards_that_left() {
        let (mut board, id) = board_with("Alex");
        reply(&mut board, &id, "Alex", 1);
        let seen = SeenState::baseline(&board);
        let dir = tempfile::tempdir().unwrap();
        let path = SeenState::path(dir.path());
        assert_eq!(SeenState::load(&path).unwrap(), None);
        seen.save(&path).unwrap();
        let mut read = SeenState::load(&path).unwrap().unwrap();
        assert_eq!(read, seen);
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert!(!read.prune(&board));
        board.cards.clear();
        assert!(read.prune(&board));
        assert!(read.cards.is_empty());
        fs::write(&path, "not json").unwrap();
        assert!(SeenState::load(&path).is_err());
    }
}
