//! The human board pane ("Tasks for Human"): the cards agents post with
//! `yaran board post`, shown in the right column while `[ui] human_board` is
//! on.
//!
//! With the board on, the right column has a row of tabs: one per person of
//! `[board] people` (that person's queue), All (every card; "Board" when there
//! are no people), and Changes, which is the column as it is without the
//! board (the Changes list, the staged list and the commit box).
//!
//! The board is a file in the yaran home or a folder of notes (see
//! `yaran_core::human_board`). A background watcher reads it whenever it
//! changes and the run loop only folds the newest snapshot in, so the pane is
//! current within a second of an agent posting without the run loop ever
//! touching the disk. Marking a card done (or reopening one) is a write, so it
//! runs on a worker too, and its result reaches the pane through the same
//! watcher. A folder shared through git is synced by a second background
//! thread, poked whenever the board changes.
//!
//! The selection is held as a card ID, not a row: cards arrive while the
//! person is looking, and a row index would quietly slide onto another card
//! between reading one and pressing the key that resolves it.
//!
//! An open card's dialog carries a reply field. Sending a reply types it into
//! an agent the way the web compose bar does (the text, then a lone Enter
//! [`yaran_core::macros::COMPOSE_SUBMIT_DELAY_MS`] later), through the same
//! ownership gate every keystroke goes through, and only once the Enter has
//! been written is the card marked done, with the reply kept as its note. The
//! reply goes to the agent that posted the card when it is running here, and
//! to the selected agent otherwise; the dialog names which before anything is
//! sent.

use std::collections::HashSet;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use yaran_core::config::BoardConfig;
use yaran_core::human_board::sync::{BoardSyncer, SyncMode, SyncOutcome};
use yaran_core::human_board::{
    Audience, Board, BoardSettings, BoardStore, BoardWatcher, Card, CardId, CardKind, NewMessage,
};
use yaran_core::ids::TabIdRef;
use yaran_core::statusline::StatusTone;

use super::text_input::TextInput;
use super::{App, FocusPane, InputTarget, PromptState, RightSection};
use crate::logger;

/// How often the watcher looks at the board file.
const WATCH_EVERY: Duration = Duration::from_millis(750);
/// How many resolved cards stay visible under "Done", newest first. Enough to
/// undo a slip of the key, not a history browser: `yaran board list --all`
/// is that.
pub(crate) const RECENT_DONE: usize = 5;
/// The status key a mark-done or reopen spinner rides on.
pub(crate) const BOARD_JOB_STATUS_KEY: &str = "human-board-job";
/// Who the board records as resolving a card from this pane.
pub(crate) const RESOLVED_BY: &str = "human";
/// Who the board records as closing news nobody marked done.
pub(crate) const NEWS_CLOSED_BY: &str = "board";
/// How often the pane looks for news old enough to close by itself.
const NEWS_CHECK_EVERY: Duration = Duration::from_secs(60);
/// The heading of the resolved group.
pub(crate) const DONE_HEADING: &str = "Done";

/// A tab of the right column while the board is on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum RightTab {
    /// A queue: one person's (`Some`), or every card (`None`).
    Queue(Option<String>),
    /// The column as it is without the board: Changes, staged, commit.
    Changes,
}

impl RightTab {
    /// Whose cards this tab shows; `None` for the Changes tab.
    pub(crate) fn audience(&self) -> Option<Audience<'_>> {
        match self {
            RightTab::Queue(Some(person)) => Some(Audience::Person(person)),
            RightTab::Queue(None) => Some(Audience::Everyone),
            RightTab::Changes => None,
        }
    }

    /// The tab's name in the strip. The every-card queue is "All" beside
    /// people's queues and simply "Board" when it is the only one.
    pub(crate) fn label(&self, has_people: bool) -> String {
        match self {
            RightTab::Queue(Some(person)) => person.clone(),
            RightTab::Queue(None) if has_people => "All".to_string(),
            RightTab::Queue(None) => "Board".to_string(),
            RightTab::Changes => "Changes".to_string(),
        }
    }
}

/// The right column's tabs, in strip order: each person's queue, every card,
/// then Changes.
pub(crate) fn right_tabs(settings: &BoardSettings) -> Vec<RightTab> {
    let mut tabs: Vec<RightTab> = settings
        .people
        .iter()
        .map(|person| RightTab::Queue(Some(person.clone())))
        .collect();
    tabs.push(RightTab::Queue(None));
    tabs.push(RightTab::Changes);
    tabs
}

/// The tab the column opens on: this machine's person's queue when they have
/// one, otherwise the first queue.
pub(crate) fn default_right_tab(settings: &BoardSettings) -> RightTab {
    let mine = settings.me.as_ref().and_then(|me| {
        settings
            .people
            .iter()
            .find(|person| yaran_core::human_board::same_person(person, me))
    });
    match mine.or(settings.people.first()) {
        Some(person) => RightTab::Queue(Some(person.clone())),
        None => RightTab::Queue(None),
    }
}

/// One row of the board pane, top to bottom.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum BoardRow {
    /// A group heading: one per kind with open cards, then "Done".
    Heading {
        kind: Option<CardKind>,
        count: usize,
    },
    /// A card, by id. `slot` is its index among the selectable cards.
    Card { id: CardId, slot: usize },
}

/// The cards `view` shows as rows, and the selectable card ids in the same
/// order. Open cards come grouped by kind in the board's column order; the
/// most recently resolved follow under "Done".
pub(crate) fn board_rows(board: &Board, view: &Audience<'_>) -> (Vec<BoardRow>, Vec<CardId>) {
    let open = board.open_cards_in(view);
    let done = board.recently_resolved_in(view, RECENT_DONE);
    let mut rows = Vec::new();
    let mut slots = Vec::new();
    for kind in CardKind::ALL {
        let cards: Vec<&Card> = open.iter().copied().filter(|c| c.kind == kind).collect();
        if cards.is_empty() {
            continue;
        }
        rows.push(BoardRow::Heading {
            kind: Some(kind),
            count: cards.len(),
        });
        for card in cards {
            rows.push(BoardRow::Card {
                id: card.id.clone(),
                slot: slots.len(),
            });
            slots.push(card.id.clone());
        }
    }
    if !done.is_empty() {
        rows.push(BoardRow::Heading {
            kind: None,
            count: done.len(),
        });
        for card in done {
            rows.push(BoardRow::Card {
                id: card.id.clone(),
                slot: slots.len(),
            });
            slots.push(card.id.clone());
        }
    }
    (rows, slots)
}

/// What a mark-done or reopen worker was asked to do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum BoardJob {
    Resolve {
        id: CardId,
        label: String,
        /// Kept on the card as its resolution: the reply that was sent.
        note: Option<String>,
        /// The agent the reply went to, for the confirmation.
        sent_to: Option<String>,
    },
    Reopen {
        id: CardId,
        label: String,
    },
    /// Add a message to the card's conversation (and mark it done with it,
    /// when the message says so).
    Reply {
        id: CardId,
        label: String,
        message: NewMessage,
        /// The agent it was typed into, when it was; `None` when it went to a
        /// person through the board.
        sent_to: Option<String>,
        /// The person it is for, when it went through the board.
        for_person: Option<String>,
    },
    /// Put the card in another person's queue.
    Assign {
        id: CardId,
        label: String,
        person: String,
        /// Who assigned it: this machine's person.
        by: Option<String>,
    },
    /// Close the news cards posted before `cutoff` (`[board] news_close_hours`).
    CloseStaleNews {
        cutoff: DateTime<Utc>,
        hours: u64,
    },
    /// Record that messages another side wrote were passed to an agent here
    /// by hand (the dialog's forward).
    MarkRelayed {
        id: CardId,
        label: String,
        keys: Vec<(DateTime<Utc>, String, String)>,
        to: String,
    },
}

/// Which control of the card dialog has focus.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum HumanBoardCardFocus {
    /// The reply field: where focus starts whenever the dialog has one.
    #[default]
    Reply,
    /// Who the reply goes to, when there is more than one choice: acting on
    /// it moves to the next.
    Recipient,
    /// Close, the safe button, and the start when there is no reply field.
    Close,
    /// Send the reply without marking the card done (or pass on what another
    /// side wrote, with the field empty).
    Send,
    /// Mark done, Send & mark done, or Reopen.
    Action,
    /// Put the card in the next person's queue.
    Assign,
}

/// Which stops a card dialog's focus ring has.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct CardStops {
    pub(crate) reply: bool,
    pub(crate) recipient: bool,
    pub(crate) assign: bool,
}

impl HumanBoardCardFocus {
    /// The next stop of the ring: the reply field and the recipient (when the
    /// dialog has them), then the buttons in the order they are drawn.
    pub(crate) fn step(self, forward: bool, stops: CardStops) -> Self {
        let mut ring: Vec<Self> = Vec::with_capacity(6);
        if stops.reply {
            ring.push(Self::Reply);
            if stops.recipient {
                ring.push(Self::Recipient);
            }
        }
        ring.push(Self::Close);
        if stops.reply {
            ring.push(Self::Send);
        }
        ring.push(Self::Action);
        if stops.assign {
            ring.push(Self::Assign);
        }
        let at = ring.iter().position(|stop| *stop == self).unwrap_or(0);
        let len = ring.len();
        ring[if forward {
            (at + 1) % len
        } else {
            (at + len - 1) % len
        }]
    }
}

/// The agent a reply goes to, chosen when the dialog opens and named in it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ReplyTarget {
    pub(crate) session_id: String,
    /// The tab the reply is typed into: the agent's focused tab.
    pub(crate) tab_id: String,
    /// The agent's name as the sidebar shows it.
    pub(crate) label: String,
    /// The agent posted the card, as opposed to merely being selected.
    pub(crate) is_poster: bool,
}

/// Who a reply typed in the card dialog goes to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Recipient {
    /// Typed into an agent of this yaran, the way the person would type it.
    Agent(ReplyTarget),
    /// Added to the card's conversation for a person: it reaches them through
    /// the board, and their yaran passes it on to an agent of theirs when the
    /// card is one of theirs (`[board] relay`).
    Person {
        name: String,
        /// The agent that posted the card on that person's side, if any.
        poster: Option<String>,
    },
}

/// The reply half of an open card's dialog.
#[derive(Clone, Debug)]
pub(crate) struct CardReply {
    pub(crate) input: TextInput,
    /// Who it can go to, the first the most likely; never empty.
    pub(crate) recipients: Vec<Recipient>,
    pub(crate) chosen: usize,
    /// The card came from another person's board: an agent here is handed the
    /// card, not answering it.
    pub(crate) from_elsewhere: bool,
}

impl CardReply {
    pub(crate) fn recipient(&self) -> &Recipient {
        &self.recipients[self.chosen.min(self.recipients.len().saturating_sub(1))]
    }

    /// Move to the next recipient, round the list.
    pub(crate) fn next_recipient(&mut self) {
        if !self.recipients.is_empty() {
            self.chosen = (self.chosen + 1) % self.recipients.len();
        }
    }

    /// What Enter in the field does: send and mark the card done when it
    /// answers the agent that asked (or, on a board without people, the agent
    /// it goes to), and only send when the conversation goes on with a person
    /// or the card is handed to an agent to work on.
    pub(crate) fn enter_marks_done(&self) -> bool {
        match self.recipient() {
            Recipient::Agent(target) => {
                !self.from_elsewhere && (target.is_poster || self.recipients.len() == 1)
            }
            Recipient::Person { .. } => false,
        }
    }
}

/// What happens once a reply typed into an agent has been submitted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum AfterSubmit {
    /// Keep it in the card's conversation, and mark the card done with it.
    Record { done: bool },
    /// It passed on what another side wrote: record those messages as relayed.
    Relayed {
        keys: Vec<(DateTime<Utc>, String, String)>,
    },
}

/// A reply already typed into an agent, waiting for its submitting Enter.
#[derive(Clone, Debug)]
pub(crate) struct PendingReplySubmit {
    pub(crate) due: Instant,
    pub(crate) target: ReplyTarget,
    pub(crate) card_id: CardId,
    pub(crate) card_label: String,
    pub(crate) reply: String,
    pub(crate) after: AfterSubmit,
}

/// What came back: whether the card changed (`false` when it already was in
/// that state), or the error.
#[derive(Debug)]
pub(crate) struct BoardJobAnswer {
    pub(crate) job: BoardJob,
    pub(crate) result: Result<bool, String>,
}

/// The pane's state. Inert (no thread, no file reads) while the board is off.
#[derive(Default)]
pub(crate) struct HumanBoardState {
    /// `[board]`, resolved, and the section it was resolved from, so a config
    /// reload that changes it starts the watcher and the syncer over.
    pub(crate) settings: Option<BoardSettings>,
    resolved_from: Option<BoardConfig>,
    watcher: Option<BoardWatcher>,
    syncer: Option<BoardSyncer>,
    /// The newest finished sync, for the pane's footer.
    pub(crate) last_sync: Option<SyncOutcome>,
    /// The failure last announced, so a sync failing every round says so once.
    sync_error_announced: Option<String>,
    /// The right column's tab. `None` until the settings are resolved.
    pub(crate) tab: Option<RightTab>,
    /// The board as last read, or why it could not be read. `None` until the
    /// watcher's first snapshot.
    pub(crate) board: Option<Result<Board, String>>,
    /// The selected card's id.
    pub(crate) selected: Option<CardId>,
    /// The open card ids already seen, so only genuinely new cards are
    /// announced. `None` until the first snapshot: the cards already on the
    /// board at startup are not news.
    known_open: Option<HashSet<CardId>>,
    job: Option<mpsc::Receiver<BoardJobAnswer>>,
    /// Replies typed into an agent whose submitting Enter is still due, oldest
    /// first.
    pub(crate) pending_submits: Vec<PendingReplySubmit>,
    /// What this machine's person has read, and the relays in flight.
    pub(crate) talk: super::human_board_relay::BoardTalk,
    /// The open card dialog's text as last drawn, and its selection.
    pub(crate) card_view: super::human_board_dialog::CardView,
    /// When stale news was last looked for (see `[board] news_close_hours`).
    news_checked: Option<Instant>,
}

impl HumanBoardState {
    /// The board when it was read successfully.
    pub(crate) fn readable(&self) -> Option<&Board> {
        self.board.as_ref().and_then(|board| board.as_ref().ok())
    }

    /// Whose cards the pane shows: the queue tab's audience, or every card
    /// while the Changes tab (or no tab yet) is up.
    pub(crate) fn view(&self) -> Audience<'_> {
        self.tab
            .as_ref()
            .and_then(RightTab::audience)
            .unwrap_or(Audience::Everyone)
    }

    /// Whether the column shows a queue (rather than the Changes tab).
    pub(crate) fn showing_queue(&self) -> bool {
        !matches!(self.tab, Some(RightTab::Changes))
    }

    /// The selectable card ids, in row order.
    pub(crate) fn slots(&self) -> Vec<CardId> {
        self.readable()
            .map(|board| board_rows(board, &self.view()).1)
            .unwrap_or_default()
    }

    /// The selected card's position among the selectable cards.
    pub(crate) fn selected_slot(&self) -> Option<usize> {
        self.selected_slot_in(self.readable()?)
    }

    /// The selected card's position among `board`'s selectable cards.
    pub(crate) fn selected_slot_in(&self, board: &Board) -> Option<usize> {
        let id = self.selected.as_ref()?;
        board_rows(board, &self.view())
            .1
            .iter()
            .position(|slot| slot == id)
    }

    /// The selected card.
    pub(crate) fn selected_card(&self) -> Option<&Card> {
        let id = self.selected.as_ref()?;
        let card = self.readable()?.card(id)?;
        card.is_in(&self.view()).then_some(card)
    }

    /// Keep the selection on a card that is still in view. A card that left
    /// (pruned, resolved away, moved to another queue) hands the selection to
    /// the card now at its old position, or the last one.
    fn reconcile_selection(&mut self, previous_slot: Option<usize>) {
        let slots = self.slots();
        if self.selected.as_ref().is_some_and(|id| slots.contains(id)) {
            return;
        }
        self.selected = match previous_slot {
            Some(slot) => slots.get(slot).or(slots.last()).cloned(),
            None => slots.first().cloned(),
        };
    }

    /// Show `tab`, keeping the selection on the same card when it is in the
    /// new tab's queue and otherwise starting at its first card.
    pub(crate) fn set_tab(&mut self, tab: RightTab) {
        self.tab = Some(tab);
        self.reconcile_selection(None);
    }

    /// Fold a new snapshot in and return the cards that are new on the board.
    pub(crate) fn apply_snapshot(&mut self, board: Result<Board, String>) -> Vec<Card> {
        let previous_slot = self.selected_slot();
        let mut fresh = Vec::new();
        if let Ok(board) = &board {
            let open: HashSet<CardId> = board.open_cards().iter().map(|c| c.id.clone()).collect();
            if let Some(known) = &self.known_open {
                fresh = board
                    .open_cards()
                    .into_iter()
                    .filter(|c| !known.contains(&c.id))
                    .cloned()
                    .collect();
            }
            self.known_open = Some(open);
        }
        self.board = Some(board);
        self.reconcile_selection(previous_slot);
        fresh
    }

    /// Move the selection by `delta` cards, stopping at either end.
    pub(crate) fn move_selection(&mut self, delta: isize) {
        let slots = self.slots();
        if slots.is_empty() {
            self.selected = None;
            return;
        }
        let current = self.selected_slot().unwrap_or(0) as isize;
        let next = (current + delta).clamp(0, slots.len() as isize - 1) as usize;
        self.selected = Some(slots[next].clone());
    }

    /// Select the card in `slot`, if there is one.
    pub(crate) fn select_slot(&mut self, slot: usize) {
        if let Some(id) = self.slots().get(slot) {
            self.selected = Some(id.clone());
        }
    }
}

/// `text` cut to `width` display columns, with an ellipsis when it was cut.
pub(crate) fn fit_width(text: &str, width: usize) -> String {
    use super::components::wrap_lines::{char_display_width, display_width};
    if display_width(text) <= width {
        return text.to_string();
    }
    if width == 0 {
        return String::new();
    }
    let mut out = String::new();
    let mut used = 0;
    for c in text.chars() {
        let w = char_display_width(c);
        if used + w + 1 > width {
            break;
        }
        out.push(c);
        used += w;
    }
    out.push('\u{2026}');
    out
}

/// The new cards worth announcing on this machine: the ones in `me`'s queue
/// (theirs, or anyone's). Without a `me`, every new card.
pub(crate) fn cards_for_me(fresh: Vec<Card>, me: Option<&str>) -> Vec<Card> {
    fresh
        .into_iter()
        .filter(|card| me.is_none_or(|me| card.is_for(me)))
        .collect()
}

/// The sentence announcing new cards on the status line.
pub(crate) fn announcement(fresh: &[Card]) -> Option<String> {
    let newest = fresh.iter().max_by_key(|c| (c.created_at, c.id.clone()))?;
    let from = newest
        .from
        .as_deref()
        .map(|from| format!(" from {from}"))
        .unwrap_or_default();
    let urgency = if newest.priority.is_urgent() {
        format!("{} priority, ", newest.priority.label())
    } else {
        String::new()
    };
    let what = format!(
        "{} {} ({urgency}{}{from})",
        newest.label(),
        newest.title,
        newest.kind.heading()
    );
    let waiting = fresh.iter().any(|c| c.kind.waits_on_human());
    let lead = match (fresh.len(), waiting) {
        (1, true) => "New on the board for you:".to_string(),
        (1, false) => "New on the board:".to_string(),
        (n, true) => format!("{n} new cards on the board, some waiting on you; newest:"),
        (n, false) => format!("{n} new cards on the board; newest:"),
    };
    Some(format!(
        "{lead} {what}. Open it in Tasks for Human, in the right column."
    ))
}

/// The worker half: apply the job to the board file.
pub(crate) fn run_board_job(store: &BoardStore, job: &BoardJob) -> Result<bool, String> {
    let now = chrono::Utc::now();
    store
        .update(|board| match job {
            BoardJob::Resolve { id, note, .. } => {
                board.resolve(id, Some(RESOLVED_BY), note.as_deref(), now)
            }
            BoardJob::Reopen { id, .. } => board.reopen(id, now),
            BoardJob::Reply { id, message, .. } => {
                let was_open = board.card(id).is_some_and(Card::is_open);
                board.reply(id, message.clone(), now)?;
                Ok(was_open && board.card(id).is_some_and(|card| !card.is_open()))
            }
            BoardJob::Assign { id, person, by, .. } => {
                board.assign(id, Some(person), by.as_deref(), now)
            }
            BoardJob::CloseStaleNews { cutoff, .. } => Ok(!board
                .close_stale_news(*cutoff, NEWS_CLOSED_BY, now)
                .is_empty()),
            BoardJob::MarkRelayed { id, keys, .. } => {
                let mut changed = false;
                for (at, from, text) in keys {
                    changed |= board.mark_relayed(id, (*at, from, text), now)?;
                }
                Ok(changed)
            }
        })
        .map_err(|err| format!("{err:#}"))
}

impl App {
    pub(crate) fn human_board_enabled(&self) -> bool {
        self.engine.config.ui.human_board
    }

    /// `[board]`, resolved, re-resolved whenever the section changed (a config
    /// reload); a change drops the watcher and the syncer so they start over
    /// on the new store.
    fn ensure_human_board_settings(&mut self) {
        let config = &self.engine.config.board;
        if self.human_board.resolved_from.as_ref() == Some(config) {
            return;
        }
        let settings = BoardSettings::from_config(config, &self.engine.paths.root);
        let tabs = right_tabs(&settings);
        let keep = self
            .human_board
            .tab
            .as_ref()
            .is_some_and(|tab| tabs.contains(tab));
        if !keep {
            self.human_board.tab = Some(default_right_tab(&settings));
        }
        let store_moved = self
            .human_board
            .settings
            .as_ref()
            .is_some_and(|old| old.store.path() != settings.store.path());
        self.human_board.resolved_from = Some(config.clone());
        self.human_board.settings = Some(settings);
        self.human_board.watcher = None;
        self.human_board.syncer = None;
        self.human_board.last_sync = None;
        self.human_board.sync_error_announced = None;
        if store_moved {
            self.human_board.board = None;
            self.human_board.known_open = None;
            self.human_board.selected = None;
            self.human_board.talk.reset();
        }
        self.mark_frame_dirty();
    }

    pub(crate) fn human_board_settings(&mut self) -> &BoardSettings {
        self.ensure_human_board_settings();
        self.human_board
            .settings
            .as_ref()
            .expect("the board settings were just resolved")
    }

    fn human_board_store(&mut self) -> BoardStore {
        self.human_board_settings().store.clone()
    }

    /// Once per run-loop tick: start or stop the watcher and the syncer to
    /// match the settings, fold in the newest snapshot, the newest sync and
    /// any finished job, and keep the right column's cursor on a section that
    /// is on screen.
    pub(crate) fn drain_human_board(&mut self) {
        self.sync_human_board_watcher();
        self.normalize_right_section_for_board();
        self.drain_human_board_job();
        self.drain_human_board_sync();
        self.submit_due_replies(Instant::now());
        self.drain_board_talk();
        self.close_stale_news();
        let Some(snapshot) = self
            .human_board
            .watcher
            .as_ref()
            .and_then(BoardWatcher::latest)
        else {
            return;
        };
        let first = self.human_board.board.is_none();
        let fresh = self.human_board.apply_snapshot(snapshot.board);
        self.mark_frame_dirty();
        // The board changed on disk: whatever changed it, a shared folder
        // should hear about it soon. The first read is the board as it was.
        if !first && let Some(syncer) = self.human_board.syncer.as_ref() {
            syncer.poke();
        }
        let me = self
            .human_board
            .settings
            .as_ref()
            .and_then(|settings| settings.me.clone());
        if let Some(message) = announcement(&cards_for_me(fresh, me.as_deref())) {
            self.set_info(message);
        }
        self.after_board_snapshot();
    }

    /// Close the news cards older than `[board] news_close_hours`, about once a
    /// minute, when no other board change is being saved.
    fn close_stale_news(&mut self) {
        let now = Instant::now();
        if self.human_board.job.is_some()
            || self
                .human_board
                .news_checked
                .is_some_and(|at| now.duration_since(at) < NEWS_CHECK_EVERY)
        {
            return;
        }
        self.human_board.news_checked = Some(now);
        let Some(after) = self
            .human_board
            .settings
            .as_ref()
            .and_then(|settings| settings.news_close_after)
        else {
            return;
        };
        let Ok(age) = chrono::Duration::from_std(after) else {
            return;
        };
        let cutoff = chrono::Utc::now() - age;
        let any = self
            .human_board
            .readable()
            .is_some_and(|board| !board.stale_news(cutoff).is_empty());
        if any {
            self.dispatch_board_job(BoardJob::CloseStaleNews {
                cutoff,
                hours: after.as_secs() / 3600,
            });
        }
    }

    fn sync_human_board_watcher(&mut self) {
        let enabled = self.human_board_enabled();
        if enabled {
            self.ensure_human_board_settings();
        }
        if enabled && self.human_board.watcher.is_none() {
            let store = self.human_board_store();
            match BoardWatcher::spawn(store, WATCH_EVERY) {
                Ok(watcher) => self.human_board.watcher = Some(watcher),
                Err(err) => {
                    // Shown in the pane rather than retried every tick: the
                    // pane is where the person looks for the board.
                    let reason = format!("could not start the board watcher: {err}");
                    logger::warn(&reason);
                    if self.human_board.board.is_none() {
                        self.human_board.board = Some(Err(reason));
                    }
                }
            }
        } else if !enabled && self.human_board.watcher.is_some() {
            // Dropping the watcher and the syncer stops their threads. A reply
            // already typed into an agent still gets its Enter: switching the
            // pane off is not a cancel.
            let pending_submits = std::mem::take(&mut self.human_board.pending_submits);
            self.human_board = super::human_board::HumanBoardState {
                pending_submits,
                ..Default::default()
            };
            self.mark_frame_dirty();
            return;
        }
        if enabled && self.human_board.syncer.is_none() {
            self.start_human_board_syncer();
        }
    }

    /// Start the background sync when the board is a folder synced through
    /// git. Once per settings: a failure to start is said once and not retried
    /// every tick (a config reload tries again).
    fn start_human_board_syncer(&mut self) {
        let Some(settings) = self.human_board.settings.as_ref() else {
            return;
        };
        if settings.sync != SyncMode::Git || !settings.store.is_folder() {
            return;
        }
        if self.human_board.last_sync.is_some() && self.human_board.syncer.is_none() {
            // Already tried with these settings and the thread did not start.
            return;
        }
        match BoardSyncer::spawn(settings.store.clone(), settings.sync_every) {
            Ok(syncer) => self.human_board.syncer = Some(syncer),
            Err(err) => {
                let reason = format!("could not start the board's sync: {err}");
                logger::warn(&reason);
                self.human_board.last_sync = Some(SyncOutcome {
                    at: chrono::Utc::now(),
                    result: Err(reason.clone()),
                });
                self.set_warning(format!(
                    "The shared board is not syncing: {reason}. Run `yaran board sync` to sync \
                     it by hand."
                ));
            }
        }
    }

    /// Fold the newest finished sync in. A failure is announced once per
    /// distinct reason, and the recovery once; quiet rounds say nothing (new
    /// cards they bring are announced as cards).
    fn drain_human_board_sync(&mut self) {
        let Some(outcome) = self
            .human_board
            .syncer
            .as_ref()
            .and_then(BoardSyncer::latest)
        else {
            return;
        };
        self.mark_frame_dirty();
        match &outcome.result {
            Err(err) => {
                logger::warn(&format!("board sync failed: {err}"));
                if self.human_board.sync_error_announced.as_deref() != Some(err.as_str()) {
                    self.human_board.sync_error_announced = Some(err.clone());
                    let every = self
                        .human_board
                        .settings
                        .as_ref()
                        .map(|settings| settings.sync_every.as_secs())
                        .unwrap_or_default();
                    self.set_warning(format!(
                        "The shared board did not sync: {err}. Your board changes are kept here \
                         and it tries again every {every}s; `yaran board sync` runs one by hand."
                    ));
                }
            }
            Ok(report) => {
                if self.human_board.sync_error_announced.take().is_some() {
                    self.set_info(format!(
                        "The shared board syncs again. {}",
                        report.summary()
                    ));
                } else if !report.settled.is_empty() {
                    self.set_info(report.summary());
                }
            }
        }
        self.human_board.last_sync = Some(outcome);
    }

    /// The right column's tabs, in strip order. Empty while the board is off.
    pub(crate) fn right_column_tabs(&mut self) -> Vec<RightTab> {
        if !self.human_board_enabled() {
            return Vec::new();
        }
        right_tabs(self.human_board_settings())
    }

    /// Show `tab` in the right column.
    pub(crate) fn show_right_tab(&mut self, tab: RightTab) {
        self.human_board.set_tab(tab);
        self.normalize_right_section_for_board();
        self.mark_frame_dirty();
    }

    /// Show the tab `delta` steps along the strip, wrapping. Does nothing while
    /// the board is off.
    pub(crate) fn cycle_right_tab(&mut self, delta: isize) {
        let tabs = self.right_column_tabs();
        if tabs.is_empty() {
            return;
        }
        let at = self
            .human_board
            .tab
            .as_ref()
            .and_then(|tab| tabs.iter().position(|t| t == tab))
            .unwrap_or(0) as isize;
        let len = tabs.len() as isize;
        let next = (at + delta).rem_euclid(len) as usize;
        self.show_right_tab(tabs[next].clone());
    }

    /// The board takes the whole column on a queue tab and none of it on the
    /// Changes tab, so the cursor cannot be left on a section that is not on
    /// screen.
    pub(crate) fn normalize_right_section_for_board(&mut self) {
        let board = self.right_lower() == super::RightLower::Board;
        match self.right_section {
            RightSection::Unstaged | RightSection::Staged | RightSection::CommitInput if board => {
                self.right_section = RightSection::Board;
                if self.input_target == InputTarget::CommitMessage {
                    self.input_target = InputTarget::None;
                }
            }
            RightSection::Board if !board => {
                self.right_section = RightSection::Unstaged;
                self.clamp_files_cursor();
            }
            _ => {}
        }
    }

    /// Flip `ui.human_board` and persist it, the way the other chrome toggles
    /// do. The watcher follows on the next tick.
    pub(crate) fn toggle_human_board(&mut self) {
        let next = !self.engine.config.ui.human_board;
        self.engine.config.ui.human_board = next;
        self.engine
            .config_writer
            .save_lazy(self.engine.config.clone());
        self.normalize_right_section_for_board();
        let palette_key = self.bindings.label_for(super::Action::OpenPalette);
        let next_tab = self.bindings.label_for(super::Action::NextRightTab);
        if next {
            self.set_ui_hint(format!(
                "The right column now shows Tasks for Human, with a tab per queue and a Changes \
                 tab for the changed files ({next_tab} switches tabs). Agents post to it with \
                 `yaran board post`. Run toggle-human-board from the palette ({palette_key}) to \
                 switch back."
            ));
        } else {
            self.set_ui_hint(format!(
                "The right column shows the changed files again; cards stay on the board. Run \
                 toggle-human-board from the palette ({palette_key}) to show it."
            ));
        }
    }

    /// Open the selected card in its own dialog. An open card gets a reply
    /// field when its reply can go somewhere: an agent running here, or a
    /// person on the other side of a shared board. Opening a card counts it
    /// and its conversation as read.
    pub(crate) fn open_selected_board_card(&mut self) {
        let Some(card) = self.human_board.selected_card().cloned() else {
            self.set_info("There is no card to open: the board is empty.");
            return;
        };
        self.ensure_human_board_settings();
        let from_elsewhere = self.board_card_from_elsewhere(&card);
        let recipients = if card.is_open() {
            self.reply_recipients_for(&card)
        } else {
            Vec::new()
        };
        let reply = (!recipients.is_empty()).then(|| {
            Box::new(CardReply {
                input: TextInput::new(),
                recipients,
                chosen: 0,
                from_elsewhere,
            })
        });
        let focus = if reply.is_some() {
            HumanBoardCardFocus::Reply
        } else {
            HumanBoardCardFocus::Close
        };
        self.mark_board_card_read(&card);
        self.human_board.card_view = Default::default();
        self.prompt = PromptState::HumanBoardCard {
            card: Box::new(card),
            focus,
            scroll: 0,
            reply,
        };
    }

    /// Whether `card` was posted on another person's board.
    pub(crate) fn board_card_from_elsewhere(&self, card: &Card) -> bool {
        let Some(settings) = self.human_board.settings.as_ref() else {
            return false;
        };
        match (settings.me.as_deref(), settings.origin_of(card)) {
            (Some(me), Some(origin)) => !yaran_core::human_board::same_person(&origin, me),
            _ => false,
        }
    }

    /// Who a reply to `card` can go to, the most likely first.
    ///
    /// A card from another person's board answers them first (their yaran
    /// passes it to the agent that asked), then can be handed to the agent
    /// selected here to work on. A card from this board answers the agent that
    /// posted it when it runs here, then can go to any other person on the
    /// board (the card's own person first); without a running poster the
    /// selected agent takes it, as on a board without people.
    pub(crate) fn reply_recipients_for(&self, card: &Card) -> Vec<Recipient> {
        let (people, me, origin) = match self.human_board.settings.as_ref() {
            Some(settings) => (
                settings.people.clone(),
                settings.me.clone(),
                settings.origin_of(card),
            ),
            None => (Vec::new(), None, None),
        };
        let same = yaran_core::human_board::same_person;
        let target = self.reply_target_for(card);
        let mut recipients = Vec::new();
        if let (Some(me), Some(origin)) = (me.as_deref(), origin.as_deref())
            && !same(origin, me)
        {
            recipients.push(Recipient::Person {
                name: origin.to_string(),
                poster: card.from.clone(),
            });
            if let Some(target) = target.filter(|target| !target.is_poster) {
                recipients.push(Recipient::Agent(target));
            }
            return recipients;
        }
        let poster_runs = target.as_ref().is_some_and(|target| target.is_poster);
        if poster_runs && let Some(target) = target.clone() {
            recipients.push(Recipient::Agent(target));
        }
        let mut others: Vec<&String> = people
            .iter()
            .filter(|person| me.as_deref().is_none_or(|me| !same(person, me)))
            .collect();
        // The person whose queue the card is in comes first.
        others.sort_by_key(|person| {
            card.assignee
                .as_deref()
                .is_none_or(|assignee| !same(person, assignee))
        });
        for person in others {
            recipients.push(Recipient::Person {
                name: person.clone(),
                poster: None,
            });
        }
        if !poster_runs && let Some(target) = target {
            recipients.push(Recipient::Agent(target));
        }
        recipients
    }

    /// The agent a reply to `card` goes to: the agent that posted it when it is
    /// running here, otherwise the selected agent when that one is running.
    /// `None` when neither is.
    pub(crate) fn reply_target_for(&self, card: &Card) -> Option<ReplyTarget> {
        let running_tab = |session: &crate::model::AgentSession| {
            let tab = self.focused_tab_id(&session.id);
            self.engine
                .providers
                .contains_key(TabIdRef::new(&tab))
                .then_some(tab)
        };
        let poster =
            card.from
                .as_deref()
                .map(yaran_core::model::normalize_agent_handle)
                .and_then(|handle| {
                    self.engine.sessions.iter().find(|session| {
                        session.deleted_at.is_none() && session.agent_handle == handle
                    })
                });
        // Only an agent of this board posted it: a same-named agent on another
        // person's machine is somebody else.
        let posted_here = !self.board_card_from_elsewhere(card);
        if posted_here
            && let Some(session) = poster
            && let Some(tab_id) = running_tab(session)
        {
            return Some(ReplyTarget {
                session_id: session.id.clone(),
                tab_id,
                label: self.session_label(session),
                is_poster: true,
            });
        }
        let session = self.selected_session()?;
        let tab_id = running_tab(session)?;
        Some(ReplyTarget {
            session_id: session.id.clone(),
            tab_id,
            label: self.session_label(session),
            is_poster: false,
        })
    }

    /// The person running this yaran, as the board names them in a
    /// conversation; "human" without `[board] me`.
    pub(crate) fn board_writer(&self) -> String {
        self.human_board
            .settings
            .as_ref()
            .and_then(|settings| settings.me.clone())
            .unwrap_or_else(|| RESOLVED_BY.to_string())
    }

    /// Whether `card` can be handed to someone else's queue: an open task (news,
    /// validations and confirmations belong to whoever they were posted for),
    /// on a board with more than one person.
    pub(crate) fn board_card_assignable(&self, card: &Card) -> bool {
        card.is_open()
            && card.kind == CardKind::Task
            && self
                .human_board
                .settings
                .as_ref()
                .is_some_and(|settings| settings.people.len() > 1)
    }

    /// Mark the selected card done, or reopen it when it already is.
    pub(crate) fn toggle_selected_board_card(&mut self) {
        let Some(card) = self.human_board.selected_card() else {
            self.set_info("There is no card to mark done: the board is empty.");
            return;
        };
        let job = if card.is_open() {
            BoardJob::Resolve {
                id: card.id.clone(),
                label: card.label(),
                note: None,
                sent_to: None,
            }
        } else {
            BoardJob::Reopen {
                id: card.id.clone(),
                label: card.label(),
            }
        };
        self.dispatch_board_job(job);
    }

    /// Resolve the card dialog: close it, and act when its action was chosen.
    /// With a reply typed, the action is sending it and marking the card
    /// done; without one, it is mark done or reopen.
    pub(crate) fn resolve_human_board_card(&mut self, act: bool) {
        if act
            && let PromptState::HumanBoardCard {
                reply: Some(reply), ..
            } = &self.prompt
            && !reply.input.text.trim().is_empty()
        {
            self.send_board_reply(true);
            return;
        }
        let prompt = std::mem::replace(&mut self.prompt, PromptState::None);
        let PromptState::HumanBoardCard { card, .. } = prompt else {
            self.prompt = prompt;
            return;
        };
        if !act {
            return;
        }
        let job = if card.is_open() {
            BoardJob::Resolve {
                id: card.id.clone(),
                label: card.label(),
                note: None,
                sent_to: None,
            }
        } else {
            BoardJob::Reopen {
                id: card.id.clone(),
                label: card.label(),
            }
        };
        self.dispatch_board_job(job);
    }

    /// The card dialog's Assign: open the picker of people over the dialog.
    /// Leaving the picker without a choice brings the dialog back as it was.
    pub(crate) fn assign_board_card_from_dialog(&mut self) {
        let PromptState::HumanBoardCard { card, .. } = &self.prompt else {
            return;
        };
        if !self.board_card_assignable(card) {
            self.set_info(
                "Only an open task can be handed to someone else's queue; news, validations and \
                 confirmations stay with whoever they were posted for.",
            );
            return;
        }
        let card = card.clone();
        let people = self
            .human_board
            .settings
            .as_ref()
            .map(|settings| settings.people.clone())
            .unwrap_or_default();
        let same = yaran_core::human_board::same_person;
        // Start on the first person whose queue the card is not in.
        let selected = people
            .iter()
            .position(|person| {
                card.assignee
                    .as_deref()
                    .is_none_or(|now| !same(person, now))
            })
            .unwrap_or(0);
        let back = std::mem::replace(&mut self.prompt, PromptState::None);
        self.prompt = PromptState::AssignBoardCard(super::AssignBoardCardPrompt {
            card,
            people,
            selected,
            back: Box::new(back),
        });
        self.mark_frame_dirty();
    }

    /// The picker's choice: put the card in that person's queue.
    pub(crate) fn pick_board_card_assignee(&mut self) {
        let PromptState::AssignBoardCard(picker) = &self.prompt else {
            return;
        };
        let Some(person) = picker.people.get(picker.selected).cloned() else {
            return;
        };
        if picker
            .card
            .assignee
            .as_deref()
            .is_some_and(|now| yaran_core::human_board::same_person(now, &person))
        {
            self.set_info(format!(
                "Card {} is already in {person}'s queue; pick someone else, or leave the picker \
                 to keep it there.",
                picker.card.label()
            ));
            return;
        }
        let job = BoardJob::Assign {
            id: picker.card.id.clone(),
            label: picker.card.label(),
            person,
            by: self
                .human_board
                .settings
                .as_ref()
                .and_then(|settings| settings.me.clone()),
        };
        if self.dispatch_board_job(job) {
            self.prompt = PromptState::None;
        }
    }

    /// Leave the picker without a choice: the card dialog comes back.
    pub(crate) fn leave_board_assign_picker(&mut self) {
        let prompt = std::mem::replace(&mut self.prompt, PromptState::None);
        if let PromptState::AssignBoardCard(picker) = prompt {
            self.prompt = *picker.back;
        } else {
            self.prompt = prompt;
        }
        self.mark_frame_dirty();
    }

    /// The focus stops the open card dialog has.
    pub(crate) fn board_card_stops(&self) -> CardStops {
        let PromptState::HumanBoardCard { card, reply, .. } = &self.prompt else {
            return CardStops::default();
        };
        CardStops {
            reply: reply.is_some(),
            recipient: reply
                .as_ref()
                .is_some_and(|reply| reply.recipients.len() > 1),
            assign: self.board_card_assignable(card),
        }
    }

    /// The card dialog's recipient control: go to the next one.
    pub(crate) fn cycle_board_reply_recipient(&mut self) {
        if let PromptState::HumanBoardCard {
            reply: Some(reply), ..
        } = &mut self.prompt
        {
            reply.next_recipient();
            self.mark_frame_dirty();
        }
    }

    /// What another side wrote on `card` that has not been passed on: the
    /// messages a forward would carry.
    pub(crate) fn forwardable_messages(
        &self,
        card: &Card,
    ) -> Vec<yaran_core::human_board::Message> {
        let Some(me) = self
            .human_board
            .settings
            .as_ref()
            .and_then(|settings| settings.me.clone())
        else {
            return Vec::new();
        };
        card.thread
            .iter()
            .filter(|message| message.relayed_at.is_none() && !message.is_from_side(&me))
            .cloned()
            .collect()
    }

    /// Send the reply typed in the open card dialog to its recipient, marking
    /// the card done with it when `mark_done`. An agent here gets it typed
    /// (the Enter follows on its delay, and the board is written after); a
    /// person gets it through the card's conversation. With the field empty
    /// and an agent chosen, Send passes on what another side wrote instead.
    /// Anything that stops the send leaves the dialog open with the reply
    /// still in it, and says why.
    pub(crate) fn send_board_reply(&mut self, mark_done: bool) {
        let PromptState::HumanBoardCard {
            card,
            reply: Some(reply),
            ..
        } = &self.prompt
        else {
            return;
        };
        let text = reply.input.text.trim().to_string();
        let recipient = reply.recipient().clone();
        let from_elsewhere = reply.from_elsewhere;
        let card = (**card).clone();
        let forward = if text.is_empty() && !mark_done {
            self.forwardable_messages(&card)
        } else {
            Vec::new()
        };
        if text.is_empty() && (forward.is_empty() || !matches!(recipient, Recipient::Agent(_))) {
            let focus_key = self
                .bindings
                .label_for_text_field_dialog(super::Action::ToggleSelection);
            self.set_ui_hint(match focus_key {
                Some(key) => format!(
                    "Type a reply first, or press {key} to reach Mark done and close the card \
                     without one."
                ),
                None => "Type a reply first; Mark done closes the card without one.".to_string(),
            });
            return;
        }
        match recipient {
            Recipient::Person { name, .. } => {
                let message = NewMessage {
                    from: self.board_writer(),
                    side: self
                        .human_board
                        .settings
                        .as_ref()
                        .and_then(|settings| settings.me.clone()),
                    text,
                    done: mark_done,
                };
                let job = BoardJob::Reply {
                    id: card.id.clone(),
                    label: card.label(),
                    message,
                    sent_to: None,
                    for_person: Some(name),
                };
                if self.dispatch_board_job(job) {
                    self.prompt = PromptState::None;
                }
            }
            Recipient::Agent(target) => {
                let (typed, after) = if text.is_empty() {
                    let lines: Vec<String> = forward
                        .iter()
                        .map(|message| format!("{} wrote: {}", message.from, message.text))
                        .collect();
                    (
                        lines.join(" / "),
                        AfterSubmit::Relayed {
                            keys: forward
                                .iter()
                                .map(|m| (m.at, m.from.clone(), m.text.clone()))
                                .collect(),
                        },
                    )
                } else {
                    (text.clone(), AfterSubmit::Record { done: mark_done })
                };
                let mut prompt = yaran_core::human_board::render_reply(
                    &self.engine.config.ui.human_board_reply_template,
                    &card,
                    &typed,
                );
                if from_elsewhere {
                    prompt.push_str(&format!(
                        " (Read the whole card with yaran board show {id}; report back on it with \
                         yaran board reply {id}.)",
                        id = card.id
                    ));
                }
                self.type_board_reply(target, &card, prompt, text, after);
            }
        }
    }

    /// Type `prompt` into `target` now and schedule its submitting Enter, then
    /// `after` once it is in.
    fn type_board_reply(
        &mut self,
        target: ReplyTarget,
        card: &Card,
        prompt: String,
        reply: String,
        after: AfterSubmit,
    ) {
        if !self
            .engine
            .providers
            .contains_key(TabIdRef::new(&target.tab_id))
        {
            self.set_warning(format!(
                "Did not send your reply: {} is no longer running. The reply is still in the \
                 box; close the card and reopen it to send it to the agent that is selected.",
                target.label
            ));
            return;
        }
        if let Some(reason) = self.agent_tab_write_refusal(&target.tab_id) {
            self.set_warning(format!(
                "Did not send your reply to {}: {reason} The reply is still in the box.",
                target.label
            ));
            return;
        }
        let writes = yaran_core::macros::compose_send_writes(&prompt);
        let (body, has_submit) = match writes.as_slice() {
            [body, _submit] => (body.clone(), true),
            [submit] => (submit.clone(), false),
            _ => return,
        };
        if !self.write_into_agent_tab(&target.tab_id, &body) {
            self.set_warning(format!(
                "Did not send your reply to {}: its terminal refused the keystrokes. The reply \
                 is still in the box.",
                target.label
            ));
            return;
        }
        self.prompt = PromptState::None;
        let delay = if has_submit {
            Duration::from_millis(yaran_core::macros::COMPOSE_SUBMIT_DELAY_MS)
        } else {
            Duration::ZERO
        };
        self.status.set(
            Instant::now(),
            Some(BOARD_JOB_STATUS_KEY.to_string()),
            StatusTone::Busy,
            format!(
                "Sending your reply on card {} to {}\u{2026}",
                card.label(),
                target.label
            ),
        );
        self.human_board.pending_submits.push(PendingReplySubmit {
            due: Instant::now() + delay,
            target,
            card_id: card.id.clone(),
            card_label: card.label(),
            reply,
            after,
        });
    }

    /// Write the submitting Enter of every reply that is due, and mark its card
    /// done once the Enter is in. One card write runs at a time, so a reply
    /// waits for an earlier one's to land rather than being refused.
    pub(crate) fn submit_due_replies(&mut self, now: Instant) {
        while self.human_board.job.is_none()
            && self
                .human_board
                .pending_submits
                .first()
                .is_some_and(|pending| pending.due <= now)
        {
            let pending = self.human_board.pending_submits.remove(0);
            self.mark_frame_dirty();
            if !self
                .engine
                .providers
                .contains_key(TabIdRef::new(&pending.target.tab_id))
            {
                self.status.clear(BOARD_JOB_STATUS_KEY, None);
                self.set_warning(format!(
                    "Your reply on card {} was typed into {}, but its terminal closed before it \
                     could be submitted. The card stays open.",
                    pending.card_label, pending.target.label
                ));
                continue;
            }
            if !self.write_into_agent_tab(&pending.target.tab_id, b"\r") {
                self.status.clear(BOARD_JOB_STATUS_KEY, None);
                self.set_warning(format!(
                    "Your reply on card {} is typed into {} but was not submitted: another device \
                     took over its terminal. Press Enter there to send it; the card stays open.",
                    pending.card_label, pending.target.label
                ));
                continue;
            }
            let job = match pending.after {
                AfterSubmit::Record { done } => BoardJob::Reply {
                    id: pending.card_id,
                    label: pending.card_label,
                    message: NewMessage {
                        from: self.board_writer(),
                        side: self
                            .human_board
                            .settings
                            .as_ref()
                            .and_then(|settings| settings.me.clone()),
                        text: pending.reply,
                        done,
                    },
                    sent_to: Some(pending.target.label),
                    for_person: None,
                },
                AfterSubmit::Relayed { keys } => BoardJob::MarkRelayed {
                    id: pending.card_id,
                    label: pending.card_label,
                    keys,
                    to: pending.target.label,
                },
            };
            self.dispatch_board_job(job);
        }
    }

    /// Start a mark-done or reopen on a worker. One at a time: a second
    /// request while one runs is refused out loud.
    pub(crate) fn dispatch_board_job(&mut self, job: BoardJob) -> bool {
        if self.human_board.job.is_some() {
            self.set_warning("A board change is still being saved; try again in a moment.");
            return false;
        }
        let busy = match &job {
            BoardJob::Resolve {
                label,
                sent_to: Some(agent),
                ..
            } => format!("Sent your reply to {agent}; marking card {label} done\u{2026}"),
            BoardJob::Resolve { label, .. } => format!("Marking card {label} done\u{2026}"),
            BoardJob::Reopen { label, .. } => format!("Reopening card {label}\u{2026}"),
            BoardJob::Reply {
                label,
                sent_to: Some(agent),
                ..
            } => format!("Sent your reply to {agent}; keeping it on card {label}\u{2026}"),
            BoardJob::Reply {
                label, for_person, ..
            } => match for_person {
                Some(person) => format!("Adding your reply for {person} to card {label}\u{2026}"),
                None => format!("Adding your reply to card {label}\u{2026}"),
            },
            BoardJob::Assign { label, person, .. } => {
                format!("Assigning card {label} to {person}\u{2026}")
            }
            BoardJob::MarkRelayed { label, to, .. } => {
                format!("Passed the replies on card {label} to {to}; recording it\u{2026}")
            }
            BoardJob::CloseStaleNews { hours, .. } => {
                format!("Closing news older than {hours}h that nobody marked done\u{2026}")
            }
        };
        self.status.set(
            Instant::now(),
            Some(BOARD_JOB_STATUS_KEY.to_string()),
            StatusTone::Busy,
            busy,
        );
        let (tx, rx) = mpsc::channel();
        let store = self.human_board_store();
        let worker_job = job.clone();
        let spawned = std::thread::Builder::new()
            .name("yaran-human-board-job".into())
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    run_board_job(&store, &worker_job)
                }))
                .unwrap_or_else(|_| Err("the board worker panicked".to_string()));
                let _ = tx.send(BoardJobAnswer {
                    job: worker_job,
                    result,
                });
            });
        match spawned {
            Ok(_) => {
                self.human_board.job = Some(rx);
                true
            }
            Err(err) => {
                self.status.clear(BOARD_JOB_STATUS_KEY, None);
                self.set_error(format!(
                    "Could not start the worker that saves the board: {err}"
                ));
                false
            }
        }
    }

    fn drain_human_board_job(&mut self) {
        let Some(rx) = self.human_board.job.as_ref() else {
            return;
        };
        let answer = match rx.try_recv() {
            Ok(answer) => answer,
            Err(mpsc::TryRecvError::Empty) => return,
            Err(mpsc::TryRecvError::Disconnected) => {
                self.human_board.job = None;
                self.status.clear(BOARD_JOB_STATUS_KEY, None);
                self.set_error("The board worker exited without saying whether the card changed.");
                return;
            }
        };
        self.human_board.job = None;
        self.apply_board_job_answer(answer);
    }

    pub(crate) fn apply_board_job_answer(&mut self, answer: BoardJobAnswer) {
        self.status.clear(BOARD_JOB_STATUS_KEY, None);
        self.mark_frame_dirty();
        match (&answer.job, answer.result) {
            (
                BoardJob::Resolve {
                    label,
                    sent_to: Some(agent),
                    ..
                },
                Ok(changed),
            ) => self.set_info(if changed {
                format!(
                    "Sent your reply to {agent} and marked card {label} done; the reply is kept \
                     as the card's note."
                )
            } else {
                format!("Sent your reply to {agent}; card {label} was already done.")
            }),
            (
                BoardJob::Resolve {
                    label,
                    sent_to: Some(agent),
                    ..
                },
                Err(err),
            ) => self.set_error(format!(
                "Sent your reply to {agent}, but could not mark card {label} done: {err}"
            )),
            (BoardJob::Resolve { label, .. }, Ok(true)) => self.set_info(format!(
                "Marked card {label} done. It moves under Done on the board, and the agent \
                 that posted it sees it resolved by {RESOLVED_BY} in `yaran board list --all`."
            )),
            (BoardJob::Resolve { label, .. }, Ok(false)) => {
                self.set_info(format!("Card {label} was already done; nothing changed."))
            }
            (BoardJob::Reopen { label, .. }, Ok(true)) => {
                self.set_info(format!("Reopened card {label}; it is back on the board."))
            }
            (BoardJob::Reopen { label, .. }, Ok(false)) => {
                self.set_info(format!("Card {label} was already open; nothing changed."))
            }
            (BoardJob::Resolve { label, .. }, Err(err)) => {
                self.set_error(format!("Could not mark card {label} done: {err}"))
            }
            (BoardJob::Reopen { label, .. }, Err(err)) => {
                self.set_error(format!("Could not reopen card {label}: {err}"))
            }
            (
                BoardJob::Reply {
                    label,
                    sent_to: Some(agent),
                    message,
                    ..
                },
                Ok(closed),
            ) => self.set_info(if message.done && closed {
                format!(
                    "Sent your reply to {agent} and marked card {label} done; the reply is kept \
                     as the card's note and in its conversation."
                )
            } else if message.done {
                format!(
                    "Sent your reply to {agent}; card {label} was already done. The reply is kept \
                     in its conversation."
                )
            } else {
                format!(
                    "Sent your reply to {agent}; it is kept in card {label}'s conversation and the \
                     card stays open."
                )
            }),
            (
                BoardJob::Reply {
                    label,
                    sent_to: Some(agent),
                    ..
                },
                Err(err),
            ) => self.set_error(format!(
                "Sent your reply to {agent}, but could not keep it on card {label}: {err}"
            )),
            (
                BoardJob::Reply {
                    label,
                    for_person,
                    message,
                    ..
                },
                Ok(closed),
            ) => {
                let person = for_person
                    .clone()
                    .unwrap_or_else(|| "the other side".to_string());
                let shared = self
                    .human_board
                    .settings
                    .as_ref()
                    .is_some_and(|settings| settings.store.is_folder());
                let reach = if shared {
                    format!("it reaches {person} with the board's next sync")
                } else {
                    format!(
                        "{person} sees it on this board (it is not shared: set [board] dir to \
                         share it)"
                    )
                };
                self.set_info(if message.done && closed {
                    format!("Added your reply to card {label} and marked it done; {reach}.")
                } else {
                    format!("Added your reply to card {label}; {reach}. The card stays open.")
                })
            }
            (BoardJob::Reply { label, .. }, Err(err)) => {
                self.set_error(format!("Could not add your reply to card {label}: {err}"))
            }
            (BoardJob::Assign { label, person, .. }, Ok(true)) => self.set_info(format!(
                "Card {label} is now in {person}'s queue; it shows on their tab and reaches \
                 them with the board."
            )),
            (BoardJob::Assign { label, person, .. }, Ok(false)) => self.set_info(format!(
                "Card {label} was already in {person}'s queue; nothing changed."
            )),
            (BoardJob::Assign { label, person, .. }, Err(err)) => {
                self.set_error(format!("Could not assign card {label} to {person}: {err}"))
            }
            (BoardJob::CloseStaleNews { hours, .. }, Ok(true)) => self.set_info(format!(
                "Closed the news cards older than {hours}h that nobody had marked done; they are \
                 under Done ([board] news_close_hours sets when news closes)."
            )),
            (BoardJob::CloseStaleNews { .. }, Ok(false)) => {}
            (BoardJob::CloseStaleNews { .. }, Err(err)) => {
                self.set_warning(format!("Could not close old news on the board: {err}"))
            }
            (BoardJob::MarkRelayed { label, to, .. }, Ok(_)) => self.set_info(format!(
                "Passed the other side's replies on card {label} to {to}; the card shows they \
                 were passed."
            )),
            (BoardJob::MarkRelayed { label, to, .. }, Err(err)) => self.set_error(format!(
                "Passed the replies on card {label} to {to}, but could not record that on the \
                 card: {err}"
            )),
        }
    }

    /// Focus the board section, as a click on it does.
    pub(crate) fn focus_human_board(&mut self) {
        self.focus = FocusPane::Files;
        self.right_section = RightSection::Board;
        self.input_target = InputTarget::None;
    }

    /// Test helper: block until the in-flight job answers, then fold it in.
    #[cfg(test)]
    pub(crate) fn finish_board_job(&mut self) {
        if let Some(rx) = self.human_board.job.take() {
            let answer = rx
                .recv_timeout(Duration::from_secs(20))
                .expect("board job answered");
            self.apply_board_job_answer(answer);
        }
    }

    /// Test helper: read the board file now, as the watcher would.
    #[cfg(test)]
    pub(crate) fn load_human_board_now(&mut self) -> Vec<Card> {
        let board = self
            .human_board_store()
            .load()
            .map_err(|err| format!("{err:#}"));
        self.human_board.apply_snapshot(board)
    }
}

#[cfg(test)]
#[path = "human_board_tests.rs"]
mod tests;
