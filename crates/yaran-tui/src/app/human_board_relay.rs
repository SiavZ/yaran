//! The board as a conversation between people: what this machine's person has
//! not read yet, the announcement when another side writes, and passing what
//! another side wrote to the agents of this machine (`[board] relay`).
//!
//! What has been read lives in the yaran home (see
//! `yaran_core::human_board::seen`); it is loaded and saved on short worker
//! threads, so the run loop never touches the disk. Until it has loaded,
//! nothing counts as unread.
//!
//! Relays run one at a time on a worker: the send goes through
//! `yaran peer send` (never typed into a terminal), and only a send that went
//! through is recorded on the card, so a failed one is planned again after a
//! pause. A relay that finished is not planned again before the board has
//! been re-read with its record on it.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use yaran_core::human_board::relay::{self, RelayJob};
use yaran_core::human_board::seen::{SeenState, message_key};
use yaran_core::human_board::{Audience, Board, Card, CardId, same_person};

use super::App;
use super::human_board::RESOLVED_BY;
use crate::logger;

/// How long a relay that failed waits before it is tried again.
const RELAY_RETRY: Duration = Duration::from_secs(60);
/// Longest piece of a reply quoted on the status line.
const ANNOUNCED_REPLY_CHARS: usize = 90;

/// A finished relay.
pub(crate) struct RelayAnswer {
    job: RelayJob,
    result: Result<(), String>,
}

/// The conversation side of the board pane.
#[derive(Default)]
pub(crate) struct BoardTalk {
    /// What this machine's person has read. `None` until loaded.
    pub(crate) seen: Option<SeenState>,
    seen_load: Option<mpsc::Receiver<SeenState>>,
    seen_save: Option<mpsc::Receiver<Result<(), String>>>,
    seen_dirty: bool,
    /// The messages from other sides already seen in a snapshot, so only new
    /// ones are announced. `None` until the first snapshot.
    known_messages: Option<HashSet<(CardId, String)>>,
    relay: Option<mpsc::Receiver<RelayAnswer>>,
    /// Relays done, by key, until the board shows them recorded.
    delivered: HashSet<String>,
    /// Relays that failed, by key, and when they may be tried again.
    retry_after: HashMap<String, Instant>,
    /// Failures already said on the status line, by key.
    warned: HashSet<String>,
    /// Plan relays on the next tick.
    replan: bool,
    /// The yaran binary relays send with. `None`: this program's own.
    pub(crate) relay_exe: Option<PathBuf>,
}

impl super::human_board::HumanBoardState {
    /// Test helper: no relay is in flight.
    #[cfg(test)]
    pub(crate) fn talk_relay_idle(&self) -> bool {
        self.talk.relay.is_none()
    }
}

impl BoardTalk {
    /// Start over for another board (the store moved), keeping only how
    /// relays are sent.
    pub(crate) fn reset(&mut self) {
        let relay_exe = self.relay_exe.take();
        *self = BoardTalk {
            relay_exe,
            ..Default::default()
        };
    }
}

impl App {
    /// Once per tick: fold in what the talk workers finished, keep the read
    /// state saved, and start the next relay when one is due.
    pub(crate) fn drain_board_talk(&mut self) {
        self.drain_seen_workers();
        self.drain_relay();
        self.start_due_relay();
    }

    /// After a new snapshot of the board: forget cards that left, announce
    /// what other sides wrote since the last one, and plan relays.
    pub(crate) fn after_board_snapshot(&mut self) {
        let Some(board) = self.human_board.readable().cloned() else {
            return;
        };
        let talk = &mut self.human_board.talk;
        if talk.seen.is_none() && talk.seen_load.is_none() {
            self.load_seen_state(&board);
        }
        if let Some(seen) = self.human_board.talk.seen.as_mut()
            && seen.prune(&board)
        {
            self.human_board.talk.seen_dirty = true;
        }
        self.announce_new_replies(&board);
        self.human_board.talk.replan = true;
    }

    fn me(&self) -> Option<String> {
        self.human_board
            .settings
            .as_ref()
            .and_then(|settings| settings.me.clone())
    }

    fn load_seen_state(&mut self, board: &Board) {
        let path = SeenState::path(self.human_board_store_home());
        let board = board.clone();
        let (tx, rx) = mpsc::channel();
        let spawned = std::thread::Builder::new()
            .name("yaran-board-seen-load".into())
            .spawn(move || {
                let state = match SeenState::load(&path) {
                    Ok(Some(state)) => state,
                    Ok(None) => SeenState::baseline(&board),
                    Err(err) => {
                        logger::warn(&format!(
                            "the board's read state could not be read ({err:#}); starting from \
                             what is on the board now"
                        ));
                        SeenState::baseline(&board)
                    }
                };
                let _ = tx.send(state);
            });
        match spawned {
            Ok(_) => self.human_board.talk.seen_load = Some(rx),
            Err(err) => logger::warn(&format!(
                "could not start the board read-state loader: {err}"
            )),
        }
    }

    fn human_board_store_home(&self) -> &std::path::Path {
        self.human_board
            .settings
            .as_ref()
            .map(|settings| settings.store.home())
            .unwrap_or(self.engine.paths.root.as_path())
    }

    fn drain_seen_workers(&mut self) {
        if let Some(rx) = self.human_board.talk.seen_load.as_ref() {
            match rx.try_recv() {
                Ok(state) => {
                    let first = self.human_board.talk.seen.is_none();
                    self.human_board.talk.seen = Some(state);
                    self.human_board.talk.seen_load = None;
                    self.human_board.talk.seen_dirty |= first;
                    self.mark_frame_dirty();
                }
                Err(mpsc::TryRecvError::Empty) => {}
                Err(mpsc::TryRecvError::Disconnected) => self.human_board.talk.seen_load = None,
            }
        }
        if let Some(rx) = self.human_board.talk.seen_save.as_ref() {
            match rx.try_recv() {
                Ok(result) => {
                    self.human_board.talk.seen_save = None;
                    if let Err(err) = result {
                        logger::warn(&format!("could not save the board's read state: {err}"));
                    }
                }
                Err(mpsc::TryRecvError::Empty) => {}
                Err(mpsc::TryRecvError::Disconnected) => self.human_board.talk.seen_save = None,
            }
        }
        let talk = &self.human_board.talk;
        if talk.seen_dirty
            && talk.seen_save.is_none()
            && let Some(state) = talk.seen.clone()
        {
            let path = SeenState::path(self.human_board_store_home());
            let (tx, rx) = mpsc::channel();
            let spawned = std::thread::Builder::new()
                .name("yaran-board-seen-save".into())
                .spawn(move || {
                    let _ = tx.send(state.save(&path).map_err(|err| format!("{err:#}")));
                });
            match spawned {
                Ok(_) => {
                    self.human_board.talk.seen_save = Some(rx);
                    self.human_board.talk.seen_dirty = false;
                }
                Err(err) => logger::warn(&format!(
                    "could not start the board read-state saver: {err}"
                )),
            }
        }
    }

    /// Count `card` and its conversation as read by this machine's person.
    pub(crate) fn mark_board_card_read(&mut self, card: &Card) {
        if let Some(seen) = self.human_board.talk.seen.as_mut()
            && seen.mark_read(card)
        {
            self.human_board.talk.seen_dirty = true;
            self.mark_frame_dirty();
        }
    }

    /// Whether `card` holds something from another side this machine's person
    /// has not opened yet. Never before the read state has loaded, and never
    /// without `[board] me`.
    pub(crate) fn board_card_unread(&self, card: &Card) -> bool {
        let (Some(seen), Some(settings)) = (
            self.human_board.talk.seen.as_ref(),
            self.human_board.settings.as_ref(),
        ) else {
            return false;
        };
        let Some(me) = settings.me.as_deref() else {
            return false;
        };
        seen.is_unread(card, me, settings.origin_of(card).as_deref())
    }

    /// Whether `card` holds its poster up waiting on a person.
    pub(crate) fn board_card_waits(&self, card: &Card) -> bool {
        let mut people: Vec<String> = self
            .human_board
            .settings
            .as_ref()
            .map(|settings| settings.people.clone())
            .unwrap_or_default();
        people.push(RESOLVED_BY.to_string());
        if let Some(me) = self.me() {
            people.push(me);
        }
        card.waits_for_answer(&people)
    }

    /// For the queue `view` shows: whether any card in it waits on a person
    /// (the red mark), and whether any holds something unread from another
    /// side (the green one).
    pub(crate) fn board_queue_marks(&self, view: &Audience<'_>) -> (bool, bool) {
        let Some(board) = self.human_board.readable() else {
            return (false, false);
        };
        let cards = board.cards.iter().filter(|card| card.is_in(view));
        let mut waits = false;
        let mut unread = false;
        for card in cards {
            waits |= self.board_card_waits(card);
            unread |= self.board_card_unread(card);
            if waits && unread {
                break;
            }
        }
        (waits, unread)
    }

    /// Say on the status line what another side wrote since the last
    /// snapshot, on the cards that concern this machine's person.
    fn announce_new_replies(&mut self, board: &Board) {
        let Some(me) = self.me() else {
            return;
        };
        let settings = self.human_board.settings.clone();
        let mut current: HashSet<(CardId, String)> = HashSet::new();
        let mut fresh: Vec<(&Card, &yaran_core::human_board::Message)> = Vec::new();
        let known = self.human_board.talk.known_messages.take();
        for card in &board.cards {
            let concerns_me = card.is_for(&me)
                || settings
                    .as_ref()
                    .and_then(|settings| settings.origin_of(card))
                    .is_some_and(|origin| same_person(&origin, &me));
            for message in &card.thread {
                if message.is_from_side(&me) {
                    continue;
                }
                let key = (card.id.clone(), message_key(message));
                if concerns_me && known.as_ref().is_some_and(|known| !known.contains(&key)) {
                    fresh.push((card, message));
                }
                current.insert(key);
            }
        }
        self.human_board.talk.known_messages = Some(current);
        let Some((card, message)) = fresh.iter().max_by_key(|(_, message)| message.at) else {
            return;
        };
        let quoted =
            super::human_board::fit_width(&message.text.replace('\n', " "), ANNOUNCED_REPLY_CHARS);
        let what = if message.done {
            "answered and marked done"
        } else {
            "wrote on"
        };
        let more = match fresh.len() {
            1 => String::new(),
            n => format!(" ({n} new messages on the board)"),
        };
        self.set_info(format!(
            "{} {what} card {}: \u{201c}{quoted}\u{201d}{more}. Open it in Tasks for Human to read \
             the conversation.",
            message.from,
            card.label()
        ));
    }

    fn drain_relay(&mut self) {
        let Some(rx) = self.human_board.talk.relay.as_ref() else {
            return;
        };
        let answer = match rx.try_recv() {
            Ok(answer) => answer,
            Err(mpsc::TryRecvError::Empty) => return,
            Err(mpsc::TryRecvError::Disconnected) => {
                self.human_board.talk.relay = None;
                self.human_board.talk.replan = true;
                return;
            }
        };
        self.human_board.talk.relay = None;
        self.human_board.talk.replan = true;
        let key = answer.job.key();
        let job = &answer.job;
        let what = if job.card_itself {
            format!("card {} from {}", job.card, job.person)
        } else {
            format!("{}'s reply on card {}", job.person, job.card)
        };
        match answer.result {
            Ok(()) => {
                self.human_board.talk.delivered.insert(key.clone());
                self.human_board.talk.retry_after.remove(&key);
                self.human_board.talk.warned.remove(&key);
                self.set_info(format!(
                    "Passed {what} to {}; it answers on the card, and the card shows it was \
                     passed.",
                    job.to
                ));
            }
            Err(err) => {
                logger::warn(&format!("board relay to {} failed: {err}", job.to));
                self.human_board
                    .talk
                    .retry_after
                    .insert(key.clone(), Instant::now() + RELAY_RETRY);
                if self.human_board.talk.warned.insert(key) {
                    self.set_warning(format!(
                        "Could not pass {what} to {}: {err}. yaran tries again every {}s; the \
                         card dialog's Send passes it by hand.",
                        job.to,
                        RELAY_RETRY.as_secs()
                    ));
                }
            }
        }
    }

    fn start_due_relay(&mut self) {
        let talk = &mut self.human_board.talk;
        if talk.relay.is_some() {
            return;
        }
        let now = Instant::now();
        let retry_due = talk.retry_after.values().any(|at| *at <= now);
        if !talk.replan && !retry_due {
            return;
        }
        talk.replan = false;
        let (Some(settings), Some(board)) = (
            self.human_board.settings.clone(),
            self.human_board.readable(),
        ) else {
            return;
        };
        if !settings.relay {
            return;
        }
        let sessions = &self.engine.sessions;
        let is_local_agent = |handle: &str| {
            let handle = yaran_core::model::normalize_agent_handle(handle);
            sessions
                .iter()
                .any(|session| session.deleted_at.is_none() && session.agent_handle == handle)
        };
        let jobs = relay::plan(board, &settings, &is_local_agent);
        let planned: HashSet<String> = jobs.iter().map(RelayJob::key).collect();
        let talk = &mut self.human_board.talk;
        // A delivered relay stays skipped only until the board shows it
        // recorded, when it stops being planned at all.
        talk.delivered.retain(|key| planned.contains(key));
        talk.retry_after.retain(|key, _| planned.contains(key));
        let Some(job) = jobs.into_iter().find(|job| {
            let key = job.key();
            !talk.delivered.contains(&key) && talk.retry_after.get(&key).is_none_or(|at| *at <= now)
        }) else {
            return;
        };
        // The path yaran was started from, not the OS's answer now: once a newer
        // build replaces the file, that answer names the unlinked old one.
        let Some(exe) = talk
            .relay_exe
            .clone()
            .or_else(yaran_core::reload_policy::reload_exe)
        else {
            logger::warn("cannot relay board replies: yaran cannot tell where it was started from");
            return;
        };
        let store = settings.store.clone();
        let transport = settings.relay_transport.clone();
        let (tx, rx) = mpsc::channel();
        let spawned = std::thread::Builder::new()
            .name("yaran-board-relay".into())
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    relay::deliver(&job, &transport, &exe, &store).map_err(|err| format!("{err:#}"))
                }))
                .unwrap_or_else(|_| Err("the relay worker panicked".to_string()));
                let _ = tx.send(RelayAnswer { job, result });
            });
        match spawned {
            Ok(_) => self.human_board.talk.relay = Some(rx),
            Err(err) => logger::warn(&format!("could not start the board relay worker: {err}")),
        }
    }

    /// Test helper: wait for the relay in flight and fold it in.
    #[cfg(test)]
    pub(crate) fn finish_board_relay(&mut self) {
        if let Some(rx) = self.human_board.talk.relay.take() {
            let answer = rx
                .recv_timeout(Duration::from_secs(20))
                .expect("the relay answered");
            self.human_board.talk.relay = Some({
                let (tx, rx) = mpsc::channel();
                let _ = tx.send(answer);
                rx
            });
            self.drain_relay();
        }
    }

    /// Test helper: wait for the read state to load.
    #[cfg(test)]
    pub(crate) fn finish_board_seen_load(&mut self) {
        if let Some(rx) = self.human_board.talk.seen_load.take() {
            let state = rx
                .recv_timeout(Duration::from_secs(20))
                .expect("the read state loaded");
            self.human_board.talk.seen = Some(state);
        }
    }
}
