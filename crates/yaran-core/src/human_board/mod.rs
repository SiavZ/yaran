//! The human board: cards agents post for the person running yaran.
//!
//! An orchestrating agent works through tickets on its own, and the moments it
//! needs a person (a decision only the owner can make, a change to check on a
//! real device, a yes before a merge) or simply wants one to know something
//! happened scroll away in its terminal. The board is where those moments
//! wait instead: agents post a card with `yaran board post`, and the terminal
//! UI shows the open cards grouped by kind, in the same place whatever agent is
//! selected, until somebody marks them done.
//!
//! # Storage
//!
//! One JSON document, [`BOARD_FILE`], in the yaran home next to the config. It
//! is written by short-lived `yaran board` processes running inside agents and
//! by the terminal UI, so every change is a read-modify-write under an
//! exclusive `flock(2)` on [`BOARD_LOCK`] and lands with an atomic rename:
//! a reader never sees half a document and two writers never lose each other's
//! card. Readers take no lock, because the rename already gives them a whole
//! document. The file is owner-only, like everything else yaran keeps.
//!
//! An unreadable document is an error, never an empty board: overwriting it
//! would throw away cards nobody has read yet.
//!
//! # Trust
//!
//! Card text comes from agents, which print whatever their tools printed, so
//! every string is passed through [`crate::sanitize::for_terminal`] before it
//! is stored and is bounded in length. Nothing on the board is ever executed.

pub mod cli;

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::{Duration, SystemTime};

use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

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
    /// The card's number, unique for the life of the board and never reused.
    pub id: u64,
    pub kind: CardKind,
    /// How urgent it is. Absent from the file for the ordinary queue, so a
    /// board written before priorities existed reads back unchanged.
    #[serde(default, skip_serializing_if = "Priority::is_normal")]
    pub priority: Priority,
    /// The ticket the card is about, when it is about one. An open card is
    /// unique per (ticket, kind): posting again updates it.
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
}

impl Card {
    pub fn is_open(&self) -> bool {
        self.resolved_at.is_none()
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
    /// The number the next new card gets.
    #[serde(default)]
    pub next_id: u64,
    #[serde(default)]
    pub cards: Vec<Card>,
}

/// A card to post, before it has a number.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NewCard {
    pub kind: Option<CardKind>,
    /// `None` keeps an updated card's priority and gives a new card the
    /// ordinary one.
    pub priority: Option<Priority>,
    pub ticket: Option<String>,
    pub title: String,
    pub detail: Option<String>,
    pub from: Option<String>,
}

/// What a post did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PostOutcome {
    /// A new card went on the board.
    Added(u64),
    /// An open card for the same ticket and kind was rewritten in place.
    Updated(u64),
}

impl PostOutcome {
    pub fn id(self) -> u64 {
        match self {
            PostOutcome::Added(id) | PostOutcome::Updated(id) => id,
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
    /// Post a card, or update the open card with the same ticket and kind.
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

        if let Some(ticket) = ticket.as_deref()
            && let Some(existing) = self
                .cards
                .iter_mut()
                .find(|c| c.is_open() && c.kind == kind && c.ticket.as_deref() == Some(ticket))
        {
            existing.title = title;
            existing.detail = detail;
            if from.is_some() {
                existing.from = from;
            }
            if let Some(priority) = card.priority {
                existing.priority = priority;
            }
            existing.updated_at = now;
            return Ok(PostOutcome::Updated(existing.id));
        }

        let open = self.cards.iter().filter(|c| c.is_open()).count();
        if open >= MAX_OPEN_CARDS {
            bail!(
                "the board already has {open} open cards, its limit; resolve some \
                 (`yaran board resolve`) before posting more"
            );
        }
        let id = self.next_id.max(self.highest_id() + 1).max(1);
        self.next_id = id + 1;
        self.cards.push(Card {
            id,
            kind,
            priority: card.priority.unwrap_or_default(),
            ticket,
            title,
            detail,
            from,
            created_at: now,
            updated_at: now,
            resolved_at: None,
            resolved_by: None,
            resolution: None,
        });
        Ok(PostOutcome::Added(id))
    }

    fn highest_id(&self) -> u64 {
        self.cards.iter().map(|c| c.id).max().unwrap_or(0)
    }

    pub fn card(&self, id: u64) -> Option<&Card> {
        self.cards.iter().find(|c| c.id == id)
    }

    /// Resolve one card. Resolving a card that is already resolved changes
    /// nothing and says so (`Ok(false)`); an unknown number is an error.
    pub fn resolve(
        &mut self,
        id: u64,
        by: Option<&str>,
        note: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<bool> {
        let Some(card) = self.cards.iter_mut().find(|c| c.id == id) else {
            bail!("there is no card #{id} on the board");
        };
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
    /// return their numbers. None matching is not an error: the caller says so.
    pub fn resolve_ticket(
        &mut self,
        ticket: &str,
        kind: Option<CardKind>,
        by: Option<&str>,
        note: Option<&str>,
        now: DateTime<Utc>,
    ) -> Vec<u64> {
        let Some(ticket) = normalize_ticket(ticket) else {
            return Vec::new();
        };
        let ids: Vec<u64> = self
            .cards
            .iter()
            .filter(|c| {
                c.is_open()
                    && c.ticket.as_deref() == Some(ticket.as_str())
                    && kind.is_none_or(|kind| c.kind == kind)
            })
            .map(|c| c.id)
            .collect();
        for id in &ids {
            // Every id was just found open, so this cannot fail.
            let _ = self.resolve(*id, by, note, now);
        }
        ids
    }

    /// Change a card's priority. `Ok(false)` when it already had it; an
    /// unknown number is an error.
    pub fn set_priority(
        &mut self,
        id: u64,
        priority: Priority,
        now: DateTime<Utc>,
    ) -> Result<bool> {
        let Some(card) = self.cards.iter_mut().find(|c| c.id == id) else {
            bail!("there is no card #{id} on the board");
        };
        if card.priority == priority {
            return Ok(false);
        }
        card.priority = priority;
        card.updated_at = now;
        Ok(true)
    }

    /// Put a resolved card back on the board. Reopening an open card changes
    /// nothing (`Ok(false)`); an unknown number is an error.
    pub fn reopen(&mut self, id: u64, now: DateTime<Utc>) -> Result<bool> {
        let Some(card) = self.cards.iter_mut().find(|c| c.id == id) else {
            bail!("there is no card #{id} on the board");
        };
        if card.is_open() {
            return Ok(false);
        }
        card.resolved_at = None;
        card.resolved_by = None;
        card.resolution = None;
        card.updated_at = now;
        Ok(true)
    }

    /// Drop the oldest resolved cards past [`RESOLVED_HISTORY`]. Open cards are
    /// never dropped.
    pub fn prune(&mut self) {
        let mut resolved: Vec<(DateTime<Utc>, u64)> = self
            .cards
            .iter()
            .filter_map(|c| c.resolved_at.map(|at| (at, c.id)))
            .collect();
        if resolved.len() <= RESOLVED_HISTORY {
            return;
        }
        resolved.sort_unstable_by(|a, b| b.cmp(a));
        let drop: std::collections::HashSet<u64> = resolved[RESOLVED_HISTORY..]
            .iter()
            .map(|(_, id)| *id)
            .collect();
        self.cards.retain(|c| !drop.contains(&c.id));
    }

    /// The open cards in board order: by kind (the column order), the most
    /// urgent first within a kind, and newest first among equals.
    pub fn open_cards(&self) -> Vec<&Card> {
        let mut open: Vec<&Card> = self.cards.iter().filter(|c| c.is_open()).collect();
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
        self.cards
            .iter()
            .filter(|c| c.is_open() && c.priority.is_urgent())
            .count()
    }

    /// The most recently resolved cards, newest first, at most `limit`.
    pub fn recently_resolved(&self, limit: usize) -> Vec<&Card> {
        let mut resolved: Vec<&Card> = self.cards.iter().filter(|c| !c.is_open()).collect();
        resolved.sort_by(|a, b| b.resolved_at.cmp(&a.resolved_at).then(b.id.cmp(&a.id)));
        resolved.truncate(limit);
        resolved
    }

    /// How many open cards are waiting on the person (not counting news).
    pub fn waiting_count(&self) -> usize {
        self.cards
            .iter()
            .filter(|c| c.is_open() && c.kind.waits_on_human())
            .count()
    }
}

/// Where the board lives, and the one way to read and change it.
#[derive(Clone, Debug)]
pub struct BoardStore {
    path: PathBuf,
    lock_path: PathBuf,
}

impl BoardStore {
    /// The board of the yaran home at `root`.
    pub fn new(root: &Path) -> Self {
        Self {
            path: root.join(BOARD_FILE),
            lock_path: root.join(BOARD_LOCK),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Read the board. A missing file is an empty board; an unreadable one is
    /// an error naming the file.
    pub fn load(&self) -> Result<Board> {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Board::default()),
            Err(err) => {
                return Err(err).with_context(|| format!("could not read {}", self.path.display()));
            }
        };
        if bytes.iter().all(u8::is_ascii_whitespace) {
            return Ok(Board::default());
        }
        serde_json::from_slice(&bytes).with_context(|| {
            format!(
                "{} is not a board yaran can read; fix or move it aside (it is never \
                 overwritten while unreadable, so no card in it is lost)",
                self.path.display()
            )
        })
    }

    /// Change the board under the writers' lock: read it, let `change` edit it,
    /// prune the history, and write it back atomically. Nothing is written when
    /// `change` fails.
    pub fn update<T>(&self, change: impl FnOnce(&mut Board) -> Result<T>) -> Result<T> {
        let _lock = self.lock()?;
        let mut board = self.load()?;
        if board.version > BOARD_VERSION {
            bail!(
                "{} was written by a newer yaran (board version {}); update this yaran \
                 before changing the board",
                self.path.display(),
                board.version
            );
        }
        let value = change(&mut board)?;
        board.version = BOARD_VERSION;
        board.prune();
        self.write(&board)?;
        Ok(value)
    }

    fn lock(&self) -> Result<File> {
        use rustix::fs::{FlockOperation, flock};
        if let Some(parent) = self.lock_path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("could not create {}", parent.display()))?;
        }
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .mode(0o600)
            .open(&self.lock_path)
            .with_context(|| format!("could not open {}", self.lock_path.display()))?;
        crate::io_retry::retry_on_interrupt_errno(|| flock(&file, FlockOperation::LockExclusive))
            .with_context(|| format!("could not lock {}", self.lock_path.display()))?;
        // The lock is released when the returned file is dropped.
        Ok(file)
    }

    fn write(&self, board: &Board) -> Result<()> {
        let mut body = serde_json::to_vec_pretty(board).context("could not encode the board")?;
        body.push(b'\n');
        let tmp = self.path.with_extension(format!(
            "json.tmp.{}.{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let result = (|| {
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(&tmp)
                .with_context(|| format!("could not create {}", tmp.display()))?;
            file.write_all(&body)
                .with_context(|| format!("could not write {}", tmp.display()))?;
            file.sync_all()
                .with_context(|| format!("could not sync {}", tmp.display()))?;
            fs::rename(&tmp, &self.path).with_context(|| {
                format!(
                    "could not replace {} with {}",
                    self.path.display(),
                    tmp.display()
                )
            })
        })();
        if result.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        result
    }
}

/// The board as last read, or why it could not be read. What the watcher
/// hands a surface.
#[derive(Clone, Debug)]
pub struct BoardSnapshot {
    pub board: Result<Board, String>,
}

/// What identifies one version of the board file on disk. A writer always
/// replaces the file by rename, so a new version has a new inode even when
/// the size and the mtime's resolution would hide the change.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FileStamp {
    inode: u64,
    len: u64,
    modified: Option<SystemTime>,
}

fn stamp(path: &Path) -> Option<FileStamp> {
    let meta = fs::metadata(path).ok()?;
    Some(FileStamp {
        inode: meta.ino(),
        len: meta.len(),
        modified: meta.modified().ok(),
    })
}

/// Watches the board on a background thread and hands over a snapshot
/// whenever it changes, starting with one straight away.
///
/// The thread looks every `every` and costs one `stat` per look while nothing
/// changes. It stops once this handle is dropped (at its next look), so a
/// surface that switches the board off simply drops its watcher.
pub struct BoardWatcher {
    rx: mpsc::Receiver<BoardSnapshot>,
    stop: Arc<AtomicBool>,
}

impl BoardWatcher {
    pub fn spawn(store: BoardStore, every: Duration) -> io::Result<Self> {
        let (tx, rx) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        thread::Builder::new()
            .name("yaran-human-board".to_string())
            .spawn(move || {
                // `Some(None)` is "seen, and the file did not exist", so a board
                // that is deleted is reported once as empty rather than every look.
                let mut last: Option<Option<FileStamp>> = None;
                while !thread_stop.load(Ordering::Relaxed) {
                    let now = stamp(store.path());
                    if last != Some(now) {
                        last = Some(now);
                        let snapshot = BoardSnapshot {
                            board: store.load().map_err(|err| format!("{err:#}")),
                        };
                        if tx.send(snapshot).is_err() {
                            return;
                        }
                    }
                    thread::sleep(every);
                }
            })?;
        Ok(Self { rx, stop })
    }

    /// The newest snapshot sent since the last call, if any. Older ones are
    /// skipped: only the board as it is now matters.
    pub fn latest(&self) -> Option<BoardSnapshot> {
        self.rx.try_iter().last()
    }

    /// Wait up to `timeout` for the next snapshot. For tests and tools.
    pub fn next_within(&self, timeout: Duration) -> Option<BoardSnapshot> {
        self.rx.recv_timeout(timeout).ok()
    }
}

impl Drop for BoardWatcher {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
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
