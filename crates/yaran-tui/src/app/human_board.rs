//! The human board pane ("Tasks for Human"): the cards agents post with
//! `yaran board post`, shown in the right column in place of the staged list
//! and the commit box while `[ui] human_board` is on.
//!
//! The board is one file in the yaran home (see `yaran_core::human_board`).
//! A background watcher reads it whenever it changes and the run loop only
//! folds the newest snapshot in, so the pane is current within a second of an
//! agent posting without the run loop ever touching the disk. Marking a card
//! done (or reopening one) is a write, so it runs on a worker too, and its
//! result reaches the pane through the same watcher.
//!
//! The selection is held as a card NUMBER, not a row: cards arrive while the
//! person is looking, and a row index would quietly slide onto another card
//! between reading one and pressing the key that resolves it.

use std::collections::HashSet;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use yaran_core::human_board::{Board, BoardStore, BoardWatcher, Card, CardKind};
use yaran_core::statusline::StatusTone;

use super::{App, ConfirmFocus, FocusPane, InputTarget, PromptState, RightSection};
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
/// The heading of the resolved group.
pub(crate) const DONE_HEADING: &str = "Done";

/// One row of the board pane, top to bottom.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum BoardRow {
    /// A group heading: one per kind with open cards, then "Done".
    Heading {
        kind: Option<CardKind>,
        count: usize,
    },
    /// A card, by number. `slot` is its index among the selectable cards.
    Card { id: u64, slot: usize },
}

/// The board as rows, and the selectable card numbers in the same order. Open
/// cards come grouped by kind in the board's column order; the most recently
/// resolved follow under "Done".
pub(crate) fn board_rows(board: &Board) -> (Vec<BoardRow>, Vec<u64>) {
    let open = board.open_cards();
    let done = board.recently_resolved(RECENT_DONE);
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
                id: card.id,
                slot: slots.len(),
            });
            slots.push(card.id);
        }
    }
    if !done.is_empty() {
        rows.push(BoardRow::Heading {
            kind: None,
            count: done.len(),
        });
        for card in done {
            rows.push(BoardRow::Card {
                id: card.id,
                slot: slots.len(),
            });
            slots.push(card.id);
        }
    }
    (rows, slots)
}

/// What a mark-done or reopen worker was asked to do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum BoardJob {
    Resolve { id: u64, label: String },
    Reopen { id: u64, label: String },
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
    watcher: Option<BoardWatcher>,
    /// The board as last read, or why it could not be read. `None` until the
    /// watcher's first snapshot.
    pub(crate) board: Option<Result<Board, String>>,
    /// The selected card's number.
    pub(crate) selected: Option<u64>,
    /// The open card numbers already seen, so only genuinely new cards are
    /// announced. `None` until the first snapshot: the cards already on the
    /// board at startup are not news.
    known_open: Option<HashSet<u64>>,
    job: Option<mpsc::Receiver<BoardJobAnswer>>,
}

impl HumanBoardState {
    /// The board when it was read successfully.
    pub(crate) fn readable(&self) -> Option<&Board> {
        self.board.as_ref().and_then(|board| board.as_ref().ok())
    }

    /// The selectable card numbers, in row order.
    pub(crate) fn slots(&self) -> Vec<u64> {
        self.readable()
            .map(|board| board_rows(board).1)
            .unwrap_or_default()
    }

    /// The selected card's position among the selectable cards.
    pub(crate) fn selected_slot(&self) -> Option<usize> {
        self.selected_slot_in(self.readable()?)
    }

    /// The selected card's position among `board`'s selectable cards.
    pub(crate) fn selected_slot_in(&self, board: &Board) -> Option<usize> {
        let id = self.selected?;
        board_rows(board).1.iter().position(|slot| *slot == id)
    }

    /// The selected card.
    pub(crate) fn selected_card(&self) -> Option<&Card> {
        let id = self.selected?;
        self.readable()?.card(id)
    }

    /// Keep the selection on a card that is still on the board. A card that
    /// left (pruned, or the file was replaced) hands the selection to the card
    /// now at its old position, or the last one.
    fn reconcile_selection(&mut self, previous_slot: Option<usize>) {
        let slots = self.slots();
        if self.selected.is_some_and(|id| slots.contains(&id)) {
            return;
        }
        self.selected = match previous_slot {
            Some(slot) => slots.get(slot).or(slots.last()).copied(),
            None => slots.first().copied(),
        };
    }

    /// Fold a new snapshot in and return the cards that are new on the board.
    pub(crate) fn apply_snapshot(&mut self, board: Result<Board, String>) -> Vec<Card> {
        let previous_slot = self.selected_slot();
        let mut fresh = Vec::new();
        if let Ok(board) = &board {
            let open: HashSet<u64> = board.open_cards().iter().map(|c| c.id).collect();
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
        self.selected = Some(slots[next]);
    }

    /// Select the card in `slot`, if there is one.
    pub(crate) fn select_slot(&mut self, slot: usize) {
        if let Some(id) = self.slots().get(slot) {
            self.selected = Some(*id);
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

/// The sentence announcing new cards on the status line.
pub(crate) fn announcement(fresh: &[Card]) -> Option<String> {
    let newest = fresh.iter().max_by_key(|c| (c.created_at, c.id))?;
    let from = newest
        .from
        .as_deref()
        .map(|from| format!(" from {from}"))
        .unwrap_or_default();
    let what = format!(
        "{} {} ({}{from})",
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
            BoardJob::Resolve { id, .. } => board.resolve(*id, Some(RESOLVED_BY), None, now),
            BoardJob::Reopen { id, .. } => board.reopen(*id, now),
        })
        .map_err(|err| format!("{err:#}"))
}

impl App {
    pub(crate) fn human_board_enabled(&self) -> bool {
        self.engine.config.ui.human_board
    }

    fn human_board_store(&self) -> BoardStore {
        BoardStore::new(&self.engine.paths.root)
    }

    /// Once per run-loop tick: start or stop the watcher to match the setting,
    /// fold in the newest snapshot and any finished job, and keep the right
    /// column's cursor on a section that is on screen.
    pub(crate) fn drain_human_board(&mut self) {
        self.sync_human_board_watcher();
        self.normalize_right_section_for_board();
        self.drain_human_board_job();
        let Some(snapshot) = self
            .human_board
            .watcher
            .as_ref()
            .and_then(BoardWatcher::latest)
        else {
            return;
        };
        let fresh = self.human_board.apply_snapshot(snapshot.board);
        self.mark_frame_dirty();
        if let Some(message) = announcement(&fresh) {
            self.set_info(message);
        }
    }

    fn sync_human_board_watcher(&mut self) {
        let enabled = self.human_board_enabled();
        if enabled && self.human_board.watcher.is_none() {
            match BoardWatcher::spawn(self.human_board_store(), WATCH_EVERY) {
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
            // Dropping the watcher stops its thread.
            self.human_board = super::human_board::HumanBoardState::default();
            self.mark_frame_dirty();
        }
    }

    /// The board takes the staged and commit sections' place, so the cursor
    /// cannot be left on one of those while it is on, nor on the board while
    /// it is off.
    pub(crate) fn normalize_right_section_for_board(&mut self) {
        let board = self.human_board_enabled();
        match self.right_section {
            RightSection::Staged | RightSection::CommitInput if board => {
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
        if next {
            self.set_ui_hint(format!(
                "The right column now shows Tasks for Human in place of the staged list and \
                 the commit box. Agents post to it with `yaran board post`. Run \
                 toggle-human-board from the palette ({palette_key}) to switch back."
            ));
        } else {
            self.set_ui_hint(format!(
                "The right column shows the staged list and the commit box again; cards stay \
                 on the board. Run toggle-human-board from the palette ({palette_key}) to show \
                 it."
            ));
        }
    }

    /// Open the selected card in its own dialog.
    pub(crate) fn open_selected_board_card(&mut self) {
        let Some(card) = self.human_board.selected_card().cloned() else {
            self.set_info("There is no card to open: the board is empty.");
            return;
        };
        self.prompt = PromptState::HumanBoardCard {
            card: Box::new(card),
            focus: ConfirmFocus::Cancel,
            scroll: 0,
        };
    }

    /// Mark the selected card done, or reopen it when it already is.
    pub(crate) fn toggle_selected_board_card(&mut self) {
        let Some(card) = self.human_board.selected_card() else {
            self.set_info("There is no card to mark done: the board is empty.");
            return;
        };
        let job = if card.is_open() {
            BoardJob::Resolve {
                id: card.id,
                label: card.label(),
            }
        } else {
            BoardJob::Reopen {
                id: card.id,
                label: card.label(),
            }
        };
        self.dispatch_board_job(job);
    }

    /// Resolve the card dialog: close it, and act when its action was chosen.
    pub(crate) fn resolve_human_board_card(&mut self, act: bool) {
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
                id: card.id,
                label: card.label(),
            }
        } else {
            BoardJob::Reopen {
                id: card.id,
                label: card.label(),
            }
        };
        self.dispatch_board_job(job);
    }

    /// Start a mark-done or reopen on a worker. One at a time: a second
    /// request while one runs is refused out loud.
    pub(crate) fn dispatch_board_job(&mut self, job: BoardJob) -> bool {
        if self.human_board.job.is_some() {
            self.set_warning("A board change is still being saved; try again in a moment.");
            return false;
        }
        let busy = match &job {
            BoardJob::Resolve { label, .. } => format!("Marking card {label} done\u{2026}"),
            BoardJob::Reopen { label, .. } => format!("Reopening card {label}\u{2026}"),
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
