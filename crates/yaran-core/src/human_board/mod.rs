//! The human board: cards agents post for the people running yaran.
//!
//! An orchestrating agent works through tickets on its own, and the moments it
//! needs a person (a decision only the owner can make, a change to check on a
//! real device, a yes before a merge) or simply wants one to know something
//! happened scroll away in its terminal. The board is where those moments
//! wait instead: agents post a card with `yaran board post`, and the terminal
//! UI shows the open cards grouped by kind, in the same place whatever agent is
//! selected, until somebody marks them done.
//!
//! A board can have several people on it (`[board] people`), each with a
//! queue of their own: a card is assigned to one of them (`--for`), or to
//! nobody, which puts it in everybody's queue.
//!
//! # Storage
//!
//! Two stores, chosen by `[board] dir` (see [`store`]): one JSON document in
//! the yaran home, private to the machine, or a folder holding one Markdown
//! note per card ([`markdown`]), which a team can share by keeping it in a
//! synced notes vault or a git repository ([`sync`]). Every change is a
//! read-modify-write under an exclusive lock and lands with atomic renames, so
//! a reader never sees half a card and two writers never lose each other's.
//!
//! An unreadable document is an error, never an empty board: overwriting it
//! would throw away cards nobody has read yet. An unreadable note in a folder
//! is reported and left alone, and the rest of the board still loads.
//!
//! # Trust
//!
//! Card text comes from agents, which print whatever their tools printed, and
//! on a shared board from other machines and other people, so every string is
//! passed through [`crate::sanitize::for_terminal`] before it is stored or
//! shown and is bounded in length. Nothing on the board is ever executed.

pub mod cli;
pub mod id;
pub mod markdown;
pub mod relay;
pub mod seen;
pub mod settings;
pub mod store;
pub mod sync;

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use anyhow::{Result, bail};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

pub use id::CardId;
pub use settings::BoardSettings;
pub use store::{BoardSnapshot, BoardStore, BoardWatcher};

/// The board document, in the yaran home.
pub const BOARD_FILE: &str = "human_board.json";
/// The lock every writer holds for its whole read-modify-write.
pub const BOARD_LOCK: &str = "human_board.lock";

/// The schema this build writes. A document from a NEWER build is refused for
/// writing rather than rewritten without the fields this build cannot see.
pub const BOARD_VERSION: u32 = 1;

/// Longest title kept, in characters. A title is one row on the board.
pub const MAX_TITLE_CHARS: usize = 300;
/// Longest detail kept, in characters. The detail is read in the card view.
pub const MAX_DETAIL_CHARS: usize = 8_000;
/// Longest ticket reference kept, in characters.
pub const MAX_TICKET_CHARS: usize = 64;
/// Longest poster name kept, in characters.
pub const MAX_FROM_CHARS: usize = 64;
/// Longest resolution note kept, in characters.
pub const MAX_NOTE_CHARS: usize = 1_000;
/// Open cards the board accepts before refusing new ones. A person reads
/// every open card, so a board past this is an agent stuck in a loop, and
/// refusing out loud is better than burying the real cards under it.
pub const MAX_OPEN_CARDS: usize = 300;
/// Resolved cards kept as history; older ones are dropped on the next write.
pub const RESOLVED_HISTORY: usize = 200;
/// Longest message kept in a card's conversation, in characters.
pub const MAX_MESSAGE_CHARS: usize = 4_000;
/// Messages a card's conversation holds before it refuses more. A thread this
/// long has outgrown a card; the refusal says to start a new one.
pub const MAX_THREAD_MESSAGES: usize = 200;

/// What a card asks of the person. The order of [`CardKind::ALL`] is the
/// board's column order: things only a person can do first, news last.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CardKind {
    /// Something only the person can do or decide.
    Task,
    /// Work is done and needs the person to check it.
    Validate,
    /// An agent is waiting for a yes or no before it carries on.
    Confirm,
    /// What happened, for the record. Nothing is asked.
    Info,
}

impl CardKind {
    /// Every kind, in board order.
    pub const ALL: [CardKind; 4] = [
        CardKind::Task,
        CardKind::Validate,
        CardKind::Confirm,
        CardKind::Info,
    ];

    /// The name the CLI and the JSON use.
    pub fn as_str(self) -> &'static str {
        match self {
            CardKind::Task => "task",
            CardKind::Validate => "validate",
            CardKind::Confirm => "confirm",
            CardKind::Info => "info",
        }
    }

    /// The board's heading for this kind's group.
    pub fn heading(self) -> &'static str {
        match self {
            CardKind::Task => "Tasks for you",
            CardKind::Validate => "Validation",
            CardKind::Confirm => "Confirmation needed",
            CardKind::Info => "What happened",
        }
    }

    /// Whether an open card of this kind is waiting on the person. An `info`
    /// card is news: it is on the board until read, but nothing waits on it.
    pub fn waits_on_human(self) -> bool {
        match self {
            CardKind::Task | CardKind::Validate | CardKind::Confirm => true,
            CardKind::Info => false,
        }
    }

    /// Parse a kind from the CLI. Accepts the canonical names and the words
    /// people and agents reach for first, case-insensitively.
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "task" | "todo" | "human" | "decision" | "decide" | "needs-human" => {
                Some(CardKind::Task)
            }
            "validate" | "validation" | "verify" | "check" | "review" => Some(CardKind::Validate),
            "confirm" | "confirmation" | "approve" | "approval" => Some(CardKind::Confirm),
            "info" | "fyi" | "update" | "news" | "happened" => Some(CardKind::Info),
            _ => None,
        }
    }
}

/// How urgent a card is, graded the way an issue tracker grades one. Within a
/// kind the board lists urgent cards first; the age only orders equals.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize,
)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    /// Drop everything: a release is blocked or something is broken for users.
    Critical,
    /// Needed soon; ahead of the ordinary queue.
    High,
    /// The ordinary queue.
    #[default]
    Normal,
    /// Whenever convenient.
    Low,
}

impl Priority {
    /// Every priority, most urgent first.
    pub const ALL: [Priority; 4] = [
        Priority::Critical,
        Priority::High,
        Priority::Normal,
        Priority::Low,
    ];

    /// The name the CLI and the JSON use.
    pub fn as_str(self) -> &'static str {
        match self {
            Priority::Critical => "critical",
            Priority::High => "high",
            Priority::Normal => "normal",
            Priority::Low => "low",
        }
    }

    /// The word a person reads.
    pub fn label(self) -> &'static str {
        match self {
            Priority::Critical => "Critical",
            Priority::High => "High",
            Priority::Normal => "Normal",
            Priority::Low => "Low",
        }
    }

    /// A two-cell marker for a list row: nothing for the ordinary queue.
    pub fn marker(self) -> &'static str {
        match self {
            Priority::Critical => "!!",
            Priority::High => " !",
            Priority::Normal => "  ",
            Priority::Low => " \u{2193}",
        }
    }

    /// Critical and High: what the board counts as urgent.
    pub fn is_urgent(self) -> bool {
        matches!(self, Priority::Critical | Priority::High)
    }

    fn is_normal(&self) -> bool {
        *self == Priority::Normal
    }

    /// Parse a priority from the CLI: the canonical names, the issue-tracker
    /// words, and `p0`..`p4`, case-insensitively.
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "critical" | "blocker" | "urgent" | "highest" | "p0" | "p1" => Some(Priority::Critical),
            "high" | "important" | "p2" => Some(Priority::High),
            "normal" | "medium" | "default" | "p3" => Some(Priority::Normal),
            "low" | "lowest" | "minor" | "trivial" | "p4" | "p5" => Some(Priority::Low),
            _ => None,
        }
    }
}

impl std::fmt::Display for Priority {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::fmt::Display for CardKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One card on the board.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Card {
    /// The card's id, unique on the board. A board that is not shared never
    /// hands a number out twice.
    pub id: CardId,
    pub kind: CardKind,
    /// How urgent it is. Absent from the file for the ordinary queue, so a
    /// board written before priorities existed reads back unchanged.
    #[serde(default, skip_serializing_if = "Priority::is_normal")]
    pub priority: Priority,
    /// Whose queue the card is in: one of `[board] people`, or nobody, which
    /// puts it in everybody's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignee: Option<String>,
    /// The ticket the card is about, when it is about one. An open card is
    /// unique per (ticket, kind, assignee): posting again updates it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ticket: Option<String>,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Who posted it: an agent handle, or whatever `--from` said.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Set while the card is resolved; cleared again by a reopen.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_by: Option<String>,
    /// What the resolver said about it, if anything.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution: Option<String>,
    /// The person whose yaran posted the card (`[board] me` there). On a
    /// shared board it says which side's agents asked, so a reply from the
    /// other side can find its way back to them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    /// The poster cannot carry on until a person answers: the board marks the
    /// card's queue until somebody does.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub blocking: bool,
    /// When the card itself was passed to an agent on another side (see
    /// [`Message::relayed_at`]), so it is passed once.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relayed_at: Option<DateTime<Utc>>,
    /// The conversation on the card, oldest first.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub thread: Vec<Message>,
}

/// One message in a card's conversation: a person's reply, or an agent's
/// answer to one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Message {
    pub at: DateTime<Utc>,
    /// Who wrote it: a person's name, or an agent's handle.
    pub from: String,
    /// The person whose yaran it was written on (`[board] me` there). A
    /// message from another side is the one this side relays and marks unread.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub side: Option<String>,
    pub text: String,
    /// The writer marked the card done with this message.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub done: bool,
    /// When yaran passed it to the agent the card belongs to on this side.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relayed_at: Option<DateTime<Utc>>,
}

impl Message {
    /// What names one message across machines: when, by whom, and what. Two
    /// boards that each gained messages are merged by this.
    pub fn key(&self) -> (DateTime<Utc>, &str, &str) {
        (self.at, self.from.as_str(), self.text.as_str())
    }

    /// Whether it was written on `person`'s side. A message that does not say
    /// (written by hand in a notes app) is on the side of whoever wrote it.
    pub fn is_from_side(&self, person: &str) -> bool {
        same_person(self.side.as_deref().unwrap_or(&self.from), person)
    }
}

/// A message to add to a card's conversation.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NewMessage {
    pub from: String,
    pub side: Option<String>,
    pub text: String,
    /// Mark the card done with it.
    pub done: bool,
}

impl Card {
    pub fn is_open(&self) -> bool {
        self.resolved_at.is_none()
    }

    /// Take in the messages of `other`, another copy of this card: the ones
    /// this copy lacks are added, and a message either copy passed to an agent
    /// counts as passed. Everything else about the card stays as this copy has
    /// it. Returns whether anything changed. Two machines that each added to a
    /// card between syncs keep both their messages this way.
    pub fn absorb_conversation(&mut self, other: &Card) -> bool {
        let mut changed = false;
        for theirs in &other.thread {
            match self
                .thread
                .iter_mut()
                .find(|ours| ours.key() == theirs.key())
            {
                Some(ours) => {
                    if ours.relayed_at.is_none() && theirs.relayed_at.is_some() {
                        ours.relayed_at = theirs.relayed_at;
                        changed = true;
                    }
                }
                None => {
                    self.thread.push(theirs.clone());
                    changed = true;
                }
            }
        }
        if self.relayed_at.is_none() && other.relayed_at.is_some() {
            self.relayed_at = other.relayed_at;
            changed = true;
        }
        if changed {
            self.thread.sort_by(|a, b| a.at.cmp(&b.at));
            self.thread.truncate(MAX_THREAD_MESSAGES);
        }
        changed
    }

    /// Whether the card holds up its poster: blocking, open, and not answered
    /// by a person since the poster last asked. `people` names who counts as
    /// a person; a message from anyone else is an agent's.
    pub fn waits_for_answer(&self, people: &[String]) -> bool {
        if !self.blocking || !self.is_open() {
            return false;
        }
        match self.thread.last() {
            None => true,
            Some(last) => !people.iter().any(|person| same_person(person, &last.from)),
        }
    }

    /// Whether the card is in `person`'s queue: assigned to them, or to
    /// nobody, which is everybody's.
    pub fn is_for(&self, person: &str) -> bool {
        self.assignee
            .as_deref()
            .is_none_or(|assignee| same_person(assignee, person))
    }

    /// Whether the card is in the queue `view` shows.
    pub fn is_in(&self, view: &Audience<'_>) -> bool {
        match view {
            Audience::Everyone => true,
            Audience::Person(person) => self.is_for(person),
        }
    }

    /// `#12`, or `#12 [4812]` when the card names a ticket. The board's and the
    /// CLI's one way of naming a card in a sentence.
    pub fn label(&self) -> String {
        match &self.ticket {
            Some(ticket) => format!("#{} [{ticket}]", self.id),
            None => format!("#{}", self.id),
        }
    }
}

/// The whole board document.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Board {
    #[serde(default)]
    pub version: u32,
    /// The number the next new unprefixed card gets. Only a board document
    /// keeps it; a folder board numbers from the highest id it holds.
    #[serde(default)]
    pub next_id: u64,
    #[serde(default)]
    pub cards: Vec<Card>,
    /// What this machine puts in front of the numbers it hands out (see
    /// [`id`]). Set by the store; never written.
    #[serde(skip)]
    pub prefix: String,
    /// Notes in a folder board that could not be read, one sentence each.
    /// They are left exactly as they are.
    #[serde(skip)]
    pub problems: Vec<String>,
    /// Ids that unreadable notes' file names claim, so a new card never takes
    /// the name of a note nobody could read.
    #[serde(skip)]
    pub(crate) reserved: BTreeSet<CardId>,
    /// Which note each card of a folder board was read from.
    #[serde(skip)]
    pub(crate) files: BTreeMap<CardId, PathBuf>,
}

/// Whose queue a view of the board shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Audience<'a> {
    /// Every card on the board.
    Everyone,
    /// One person's cards and the unassigned ones.
    Person(&'a str),
}

/// Whether two spellings name the same person: names are matched
/// case-insensitively, ignoring surrounding space.
pub fn same_person(a: &str, b: &str) -> bool {
    a.trim().to_lowercase() == b.trim().to_lowercase()
}

/// A card to post, before it has a number.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NewCard {
    pub kind: Option<CardKind>,
    /// Whose queue it goes in; `None` is nobody's in particular.
    pub assignee: Option<String>,
    /// `None` keeps an updated card's priority and gives a new card the
    /// ordinary one.
    pub priority: Option<Priority>,
    pub ticket: Option<String>,
    pub title: String,
    pub detail: Option<String>,
    pub from: Option<String>,
    /// `Some` sets whether the card holds up its poster; `None` keeps an
    /// updated card's flag and leaves a new card not blocking.
    pub blocking: Option<bool>,
    /// The person whose yaran posts it (`[board] me`).
    pub origin: Option<String>,
}

/// What a post did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PostOutcome {
    /// A new card went on the board.
    Added(CardId),
    /// An open card for the same ticket, kind and assignee was rewritten in
    /// place.
    Updated(CardId),
}

impl PostOutcome {
    pub fn id(&self) -> CardId {
        match self {
            PostOutcome::Added(id) | PostOutcome::Updated(id) => id.clone(),
        }
    }
}

/// Clean one piece of agent-supplied text: strip control bytes, trim, bound
/// the length on a character boundary. `None` when nothing is left.
fn clean(value: &str, max_chars: usize, keep_newlines: bool) -> Option<String> {
    let sanitized = crate::sanitize::for_terminal(value);
    let flattened = if keep_newlines {
        sanitized.replace('\t', "    ")
    } else {
        sanitized.split_whitespace().collect::<Vec<_>>().join(" ")
    };
    let trimmed = flattened.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.chars().count() <= max_chars {
        return Some(trimmed.to_string());
    }
    let mut cut: String = trimmed.chars().take(max_chars.saturating_sub(1)).collect();
    cut.push('\u{2026}');
    Some(cut)
}

/// A ticket reference as stored: cleaned, and without a leading `#` so `#4812`
/// and `4812` name the same ticket.
pub fn normalize_ticket(value: &str) -> Option<String> {
    let cleaned = clean(value, MAX_TICKET_CHARS, false)?;
    let bare = cleaned.trim_start_matches('#').trim();
    (!bare.is_empty()).then(|| bare.to_string())
}

impl Board {
    /// Post a card, or update the open card with the same ticket, kind and
    /// assignee. A new card is numbered behind the board's [`Board::prefix`].
    pub fn post(&mut self, card: NewCard, now: DateTime<Utc>) -> Result<PostOutcome> {
        let Some(kind) = card.kind else {
            bail!("a card needs a kind: one of task, validate, confirm, info");
        };
        let Some(title) = clean(&card.title, MAX_TITLE_CHARS, false) else {
            bail!("a card needs a title");
        };
        let ticket = card.ticket.as_deref().and_then(normalize_ticket);
        let detail = card
            .detail
            .as_deref()
            .and_then(|detail| clean(detail, MAX_DETAIL_CHARS, true));
        let from = card
            .from
            .as_deref()
            .and_then(|from| clean(from, MAX_FROM_CHARS, false));
        let assignee = card
            .assignee
            .as_deref()
            .and_then(|assignee| clean(assignee, MAX_FROM_CHARS, false));

        if let Some(ticket) = ticket.as_deref()
            && let Some(existing) = self.cards.iter_mut().find(|c| {
                c.is_open()
                    && c.kind == kind
                    && c.ticket.as_deref() == Some(ticket)
                    && same_assignee(c.assignee.as_deref(), assignee.as_deref())
            })
        {
            existing.title = title;
            existing.detail = detail;
            if from.is_some() {
                existing.from = from;
            }
            if let Some(priority) = card.priority {
                existing.priority = priority;
            }
            if let Some(blocking) = card.blocking {
                existing.blocking = blocking;
            }
            existing.updated_at = now;
            return Ok(PostOutcome::Updated(existing.id.clone()));
        }

        let open = self.cards.iter().filter(|c| c.is_open()).count();
        if open >= MAX_OPEN_CARDS {
            bail!(
                "the board already has {open} open cards, its limit; resolve some \
                 (`yaran board resolve`) before posting more"
            );
        }
        let id = self.next_card_id();
        if id.prefix().is_empty() {
            self.next_id = id.number() + 1;
        }
        self.cards.push(Card {
            id: id.clone(),
            kind,
            priority: card.priority.unwrap_or_default(),
            assignee,
            ticket,
            title,
            detail,
            from,
            created_at: now,
            updated_at: now,
            resolved_at: None,
            resolved_by: None,
            resolution: None,
            origin: card
                .origin
                .as_deref()
                .and_then(|origin| clean(origin, MAX_FROM_CHARS, false)),
            blocking: card.blocking.unwrap_or(false),
            relayed_at: None,
            thread: Vec::new(),
        });
        Ok(PostOutcome::Added(id))
    }

    /// The id the next new card gets: one past the highest number behind this
    /// board's prefix, counting the names unreadable notes hold, and never
    /// below the document's own counter on a board that is not shared.
    pub(crate) fn next_card_id(&self) -> CardId {
        let highest = self
            .cards
            .iter()
            .map(|c| &c.id)
            .chain(self.reserved.iter())
            .filter(|id| id.prefix() == self.prefix)
            .map(CardId::number)
            .max()
            .unwrap_or(0);
        let floor = if self.prefix.is_empty() {
            self.next_id
        } else {
            0
        };
        CardId::new(&self.prefix, (highest + 1).max(floor).max(1))
    }

    pub fn card(&self, id: impl Into<CardId>) -> Option<&Card> {
        let id = id.into();
        self.cards.iter().find(|c| c.id == id)
    }

    fn card_mut(&mut self, id: impl Into<CardId>) -> Result<&mut Card> {
        let id = id.into();
        match self.cards.iter_mut().find(|c| c.id == id) {
            Some(card) => Ok(card),
            None => bail!("there is no card #{id} on the board"),
        }
    }

    /// The card a person or an agent means by `query`: an exact id first; then,
    /// for a bare number, this machine's card with that number, and failing
    /// that the one card of any prefix that has it. Two cards sharing the
    /// number is an error naming both, never a guess.
    pub fn find(&self, query: &str) -> Result<CardId> {
        let Some(wanted) = CardId::parse(query) else {
            bail!("{query:?} is not a card number");
        };
        if self.card(&wanted).is_some() {
            return Ok(wanted);
        }
        if wanted.prefix().is_empty() {
            let mine = CardId::new(&self.prefix, wanted.number());
            if self.card(&mine).is_some() {
                return Ok(mine);
            }
            let same_number: Vec<&CardId> = self
                .cards
                .iter()
                .map(|c| &c.id)
                .filter(|id| id.number() == wanted.number())
                .collect();
            match same_number.as_slice() {
                [] => {}
                [only] => return Ok((*only).clone()),
                several => {
                    let names: Vec<String> = several.iter().map(|id| format!("#{id}")).collect();
                    bail!(
                        "#{wanted} could be any of {}; name the card with its prefix",
                        names.join(", ")
                    );
                }
            }
        }
        bail!("there is no card #{wanted} on the board")
    }

    /// Resolve one card. Resolving a card that is already resolved changes
    /// nothing and says so (`Ok(false)`); an unknown id is an error.
    pub fn resolve(
        &mut self,
        id: impl Into<CardId>,
        by: Option<&str>,
        note: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<bool> {
        let card = self.card_mut(id)?;
        if !card.is_open() {
            return Ok(false);
        }
        card.resolved_at = Some(now);
        card.resolved_by = by.and_then(|by| clean(by, MAX_FROM_CHARS, false));
        card.resolution = note.and_then(|note| clean(note, MAX_NOTE_CHARS, true));
        card.updated_at = now;
        Ok(true)
    }

    /// Resolve every open card about `ticket` (of `kind`, when given), and
    /// return their ids. None matching is not an error: the caller says so.
    pub fn resolve_ticket(
        &mut self,
        ticket: &str,
        kind: Option<CardKind>,
        by: Option<&str>,
        note: Option<&str>,
        now: DateTime<Utc>,
    ) -> Vec<CardId> {
        let Some(ticket) = normalize_ticket(ticket) else {
            return Vec::new();
        };
        let ids: Vec<CardId> = self
            .cards
            .iter()
            .filter(|c| {
                c.is_open()
                    && c.ticket.as_deref() == Some(ticket.as_str())
                    && kind.is_none_or(|kind| c.kind == kind)
            })
            .map(|c| c.id.clone())
            .collect();
        for id in &ids {
            // Every id was just found open, so this cannot fail.
            let _ = self.resolve(id, by, note, now);
        }
        ids
    }

    /// Change a card's priority. `Ok(false)` when it already had it; an
    /// unknown id is an error.
    pub fn set_priority(
        &mut self,
        id: impl Into<CardId>,
        priority: Priority,
        now: DateTime<Utc>,
    ) -> Result<bool> {
        let card = self.card_mut(id)?;
        if card.priority == priority {
            return Ok(false);
        }
        card.priority = priority;
        card.updated_at = now;
        Ok(true)
    }

    /// Put a card in `assignee`'s queue, or in nobody's in particular with
    /// `None`. `Ok(false)` when it already was there; an unknown id is an
    /// error.
    pub fn assign(
        &mut self,
        id: impl Into<CardId>,
        assignee: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<bool> {
        let assignee = assignee.and_then(|assignee| clean(assignee, MAX_FROM_CHARS, false));
        let card = self.card_mut(id)?;
        if same_assignee(card.assignee.as_deref(), assignee.as_deref()) {
            return Ok(false);
        }
        card.assignee = assignee;
        card.updated_at = now;
        Ok(true)
    }

    /// Put a resolved card back on the board. Reopening an open card changes
    /// nothing (`Ok(false)`); an unknown id is an error.
    pub fn reopen(&mut self, id: impl Into<CardId>, now: DateTime<Utc>) -> Result<bool> {
        let card = self.card_mut(id)?;
        if card.is_open() {
            return Ok(false);
        }
        card.resolved_at = None;
        card.resolved_by = None;
        card.resolution = None;
        card.updated_at = now;
        Ok(true)
    }

    /// Add a message to a card's conversation, and mark the card done with it
    /// when `message.done` says so (a card that is already done stays done).
    /// Returns the stored message. An empty message, an unknown id and a full
    /// conversation are errors.
    pub fn reply(
        &mut self,
        id: impl Into<CardId>,
        message: NewMessage,
        now: DateTime<Utc>,
    ) -> Result<Message> {
        let Some(text) = clean(&message.text, MAX_MESSAGE_CHARS, true) else {
            bail!("a reply needs some text");
        };
        let Some(from) = clean(&message.from, MAX_FROM_CHARS, false) else {
            bail!("a reply needs to say who wrote it");
        };
        let side = message
            .side
            .as_deref()
            .and_then(|side| clean(side, MAX_FROM_CHARS, false));
        let card = self.card_mut(id)?;
        if card.thread.len() >= MAX_THREAD_MESSAGES {
            bail!(
                "card #{} already holds {MAX_THREAD_MESSAGES} messages, its limit; post a new \
                 card to carry the conversation on",
                card.id
            );
        }
        // Two messages from one writer in the same instant would share a key;
        // a later one is stamped a moment later instead, so both survive a
        // merge.
        let mut at = now;
        while card.thread.iter().any(|m| m.at == at && m.from == from) {
            at += chrono::Duration::milliseconds(1);
        }
        let stored = Message {
            at,
            from,
            side,
            text,
            done: message.done,
            relayed_at: None,
        };
        card.thread.push(stored.clone());
        card.thread.sort_by(|a, b| a.at.cmp(&b.at));
        if message.done && card.is_open() {
            card.resolved_at = Some(now);
            card.resolved_by = Some(stored.from.clone());
            card.resolution = clean(&stored.text, MAX_NOTE_CHARS, true);
        }
        card.updated_at = now;
        Ok(stored)
    }

    /// Say whether a card holds up its poster. `Ok(false)` when it already
    /// said so; an unknown id is an error.
    pub fn set_blocking(
        &mut self,
        id: impl Into<CardId>,
        blocking: bool,
        now: DateTime<Utc>,
    ) -> Result<bool> {
        let card = self.card_mut(id)?;
        if card.blocking == blocking {
            return Ok(false);
        }
        card.blocking = blocking;
        card.updated_at = now;
        Ok(true)
    }

    /// Record that the message `key` names on card `id` was passed to its
    /// agent. `Ok(false)` when it already was, or the message is gone. The
    /// card's update time does not move: relaying is bookkeeping, not news.
    pub fn mark_relayed(
        &mut self,
        id: impl Into<CardId>,
        key: (DateTime<Utc>, &str, &str),
        now: DateTime<Utc>,
    ) -> Result<bool> {
        let card = self.card_mut(id)?;
        match card.thread.iter_mut().find(|m| m.key() == key) {
            Some(message) if message.relayed_at.is_none() => {
                message.relayed_at = Some(now);
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    /// Record that card `id` itself was passed to an agent. `Ok(false)` when
    /// it already was.
    pub fn mark_card_relayed(&mut self, id: impl Into<CardId>, now: DateTime<Utc>) -> Result<bool> {
        let card = self.card_mut(id)?;
        if card.relayed_at.is_some() {
            return Ok(false);
        }
        card.relayed_at = Some(now);
        Ok(true)
    }

    /// Drop the oldest resolved cards past [`RESOLVED_HISTORY`]. Open cards are
    /// never dropped.
    pub fn prune(&mut self) {
        let mut resolved: Vec<(DateTime<Utc>, CardId)> = self
            .cards
            .iter()
            .filter_map(|c| c.resolved_at.map(|at| (at, c.id.clone())))
            .collect();
        if resolved.len() <= RESOLVED_HISTORY {
            return;
        }
        resolved.sort_unstable_by(|a, b| b.cmp(a));
        let drop: BTreeSet<CardId> = resolved
            .drain(RESOLVED_HISTORY..)
            .map(|(_, id)| id)
            .collect();
        self.cards.retain(|c| !drop.contains(&c.id));
    }

    /// The open cards in board order: by kind (the column order), the most
    /// urgent first within a kind, and newest first among equals.
    pub fn open_cards(&self) -> Vec<&Card> {
        self.open_cards_in(&Audience::Everyone)
    }

    /// [`Board::open_cards`], narrowed to the queue `view` shows.
    pub fn open_cards_in(&self, view: &Audience<'_>) -> Vec<&Card> {
        let mut open: Vec<&Card> = self
            .cards
            .iter()
            .filter(|c| c.is_open() && c.is_in(view))
            .collect();
        open.sort_by(|a, b| {
            a.kind
                .cmp(&b.kind)
                .then(a.priority.cmp(&b.priority))
                .then(b.updated_at.cmp(&a.updated_at))
                .then(b.id.cmp(&a.id))
        });
        open
    }

    /// How many open cards are urgent (critical or high).
    pub fn urgent_count(&self) -> usize {
        self.urgent_count_in(&Audience::Everyone)
    }

    /// [`Board::urgent_count`] within the queue `view` shows.
    pub fn urgent_count_in(&self, view: &Audience<'_>) -> usize {
        self.cards
            .iter()
            .filter(|c| c.is_open() && c.priority.is_urgent() && c.is_in(view))
            .count()
    }

    /// The most recently resolved cards, newest first, at most `limit`.
    pub fn recently_resolved(&self, limit: usize) -> Vec<&Card> {
        self.recently_resolved_in(&Audience::Everyone, limit)
    }

    /// [`Board::recently_resolved`] within the queue `view` shows.
    pub fn recently_resolved_in(&self, view: &Audience<'_>, limit: usize) -> Vec<&Card> {
        let mut resolved: Vec<&Card> = self
            .cards
            .iter()
            .filter(|c| !c.is_open() && c.is_in(view))
            .collect();
        resolved.sort_by(|a, b| b.resolved_at.cmp(&a.resolved_at).then(b.id.cmp(&a.id)));
        resolved.truncate(limit);
        resolved
    }

    /// How many open cards are waiting on a person (not counting news).
    pub fn waiting_count(&self) -> usize {
        self.waiting_count_in(&Audience::Everyone)
    }

    /// [`Board::waiting_count`] within the queue `view` shows.
    pub fn waiting_count_in(&self, view: &Audience<'_>) -> usize {
        self.cards
            .iter()
            .filter(|c| c.is_open() && c.kind.waits_on_human() && c.is_in(view))
            .count()
    }

    /// How many open cards are news within the queue `view` shows.
    pub fn news_count_in(&self, view: &Audience<'_>) -> usize {
        self.cards
            .iter()
            .filter(|c| c.is_open() && !c.kind.waits_on_human() && c.is_in(view))
            .count()
    }
}

/// Whether two optional assignees are the same queue.
fn same_assignee(a: Option<&str>, b: Option<&str>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => same_person(a, b),
        _ => false,
    }
}

impl From<&CardId> for CardId {
    fn from(id: &CardId) -> Self {
        id.clone()
    }
}

impl From<u64> for CardId {
    fn from(number: u64) -> Self {
        CardId::plain(number)
    }
}

impl PartialEq<u64> for CardId {
    fn eq(&self, number: &u64) -> bool {
        self.prefix().is_empty() && self.number() == *number
    }
}

/// The default `[ui] human_board_reply_template`.
pub const DEFAULT_REPLY_TEMPLATE: &str = "Reply to board card {card} ({title}): {reply}";

/// Longest card title quoted into a reply prompt, in characters.
pub const REPLY_TITLE_CHARS: usize = 80;

/// The prompt a reply typed on `card` becomes, from `template`.
///
/// Placeholders: `{reply}` the typed text, `{card}` the card's label (`#21`, or
/// `#21 [ticket]`), `{ticket}` the bare ticket (empty when there is none), and
/// `{title}` the title cut to [`REPLY_TITLE_CHARS`]. A template that forgot
/// `{reply}` still carries the reply, after it, so what was typed is never
/// lost; an empty template sends the reply alone. Line breaks are folded to
/// spaces, so the prompt is one line however the template was written.
pub fn render_reply(template: &str, card: &Card, reply: &str) -> String {
    let reply = reply.trim();
    let template = template.trim();
    if template.is_empty() {
        return reply.to_string();
    }
    let title = clean(&card.title, REPLY_TITLE_CHARS, false).unwrap_or_default();
    let rendered = template
        .replace("{card}", &card.label())
        .replace("{ticket}", card.ticket.as_deref().unwrap_or(""))
        .replace("{title}", &title);
    let rendered = if rendered.contains("{reply}") {
        rendered.replace("{reply}", reply)
    } else {
        format!("{rendered} {reply}")
    };
    rendered.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A short age for a board row: `now`, `5m`, `3h`, `2d`.
pub fn compact_age(from: DateTime<Utc>, now: DateTime<Utc>) -> String {
    let seconds = (now - from).num_seconds().max(0);
    match seconds {
        s if s < 60 => "now".to_string(),
        s if s < 3_600 => format!("{}m", s / 60),
        s if s < 86_400 => format!("{}h", s / 3_600),
        s => format!("{}d", s / 86_400),
    }
}

#[cfg(test)]
mod tests;
