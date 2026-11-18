//! This surface's seat in the PTY size registry.
//!
//! ## What the registry decides here
//!
//! Every device attached to a row types into it, this terminal included: a
//! keystroke from here always reaches the PTY. What one device holds is the
//! row's SIZE (one PTY, one grid), and the device that last typed into a row
//! holds it. While a background web server is serving, a browser and this
//! terminal are both participants of
//! [`yaran_core::pty_owners::PtySizeOwners`], through the seat the
//! background-serve seam hands this surface.
//!
//! Typing into a row another device holds moves the size here: this pane's
//! recorded grid is applied, then the bytes are written. Every resize this
//! surface would send records this pane's grid as its desired one, so that
//! transfer (or a promotion when the holder leaves) can apply it; it reaches
//! the child at once only while this surface holds the row. A PTY drawn at
//! another device's grid is clipped or padded inside the pane.
//!
//! ## Nothing serving, nothing to ask
//!
//! With no background server up there is no registry and no seat: every helper
//! here short-circuits before it touches anything, and this surface writes and
//! resizes exactly as it did before any of this existed.
//!
//! ## Drawing a pane claims nothing
//!
//! Not even a pty nobody holds: this surface draws every agent the workspace
//! grows, including one a browser just created and is about to attach to. The
//! first claim of a free row comes from a deliberate act: typing into it, a
//! launch started here ([`launch_claims_its_pty`]), or switching serving on
//! from here, which claims every agent tab and terminal running at that moment
//! before the serve accepts a connection (see
//! [`yaran_core::background_serve::BackgroundServeCompanion::start`]). A
//! startup with the setting already on claims nothing, and neither does the
//! auto-reopen sweep. Which start is which is [`BackgroundServerStart`],
//! carried from the command to the pre-flight's landing with the start's
//! status op.

use yaran_core::background_serve::{PtyOwnershipEvent, TUI_DEVICE_LABEL, TuiOwnership};
use yaran_core::pty_owners::{HolderChange, StampedGrid};

use crate::pty::PtyClient;
use yaran_core::ids::TabIdRef;

use super::{App, CenterPart};

/// Who holds a pty's size, from this surface's point of view.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PtyDriver {
    /// Nobody holds it, or nothing is serving so the question does not arise.
    Free,
    /// This surface holds it.
    Mine,
    /// Another device holds it; this pane draws the PTY at that device's grid.
    Elsewhere,
}

/// Whether a launch of this kind claims the child it produces for this surface:
/// it does when somebody at this keyboard asked for it, and only then. Matched
/// exhaustively rather than by a `matches!` at the call site, so a new launch
/// kind does not compile until somebody has said which it is.
pub(crate) fn launch_claims_its_pty(kind: &yaran_core::worker::AgentLaunchKind) -> bool {
    use yaran_core::worker::AgentLaunchKind;
    match kind {
        // The startup sweep reopens what was running last time, before the user
        // has touched anything. Claiming here would size every auto-reopened
        // agent in the workspace for this terminal at once.
        AgentLaunchKind::StartupAutoReopen => false,
        // A person at this keyboard asked for each of these.
        AgentLaunchKind::Create { .. }
        | AgentLaunchKind::Reconnect { .. }
        | AgentLaunchKind::ForceReconnect { .. }
        | AgentLaunchKind::Tab { .. }
        // The tail of a launch somebody did ask for: the provider refused to
        // resume, so yaran relaunches it fresh. yaran-core dispatches this one
        // directly, so it never reaches this surface's dispatch.
        | AgentLaunchKind::ResumeFallback { .. } => true,
    }
}

impl App {
    /// This surface's seat in the registry, or `None` when nothing is serving.
    pub(super) fn pty_ownership(&self) -> Option<TuiOwnership> {
        self.companion
            .as_ref()
            .and_then(|companion| companion.ownership())
    }

    /// This surface's seat, with `pty_id` placed in its row first, so every
    /// answer about it is its row's.
    fn pty_ownership_for(&self, pty_id: &str) -> Option<TuiOwnership> {
        let seat = self.pty_ownership()?;
        seat.owners.join_row(pty_id, self.engine.pty_row(pty_id));
        Some(seat)
    }

    /// This surface's id in the registry, or `None` when nothing is serving.
    pub(super) fn pty_ownership_conn_id(&self) -> Option<u64> {
        self.pty_ownership().map(|seat| seat.conn_id)
    }

    /// Who holds `pty_id`'s size right now. A live read every time it is asked,
    /// never a latched flag: the size moves between devices while nothing on
    /// this surface happens.
    pub(crate) fn pty_driver(&self, pty_id: &str) -> PtyDriver {
        let Some(seat) = self.pty_ownership_for(pty_id) else {
            return PtyDriver::Free;
        };
        match seat.owners.current_owner(pty_id).0 {
            None => PtyDriver::Free,
            Some(conn) if conn == seat.conn_id => PtyDriver::Mine,
            Some(_) => PtyDriver::Elsewhere,
        }
    }

    /// Write `bytes` into the focused terminal surface's PTY and report whether
    /// they reached the child's queue.
    ///
    /// Every write is allowed. While something is serving, typing into a row
    /// another device holds (or nobody does) moves its size here first: this
    /// pane's recorded grid is applied, the handover announced, and then the
    /// bytes are written. A focus report into a row another device holds is
    /// dropped (see
    /// [`yaran_core::pty_owners::PtySizeOwners::note_write`]).
    ///
    /// A write that reaches the child marks its run as used
    /// ([`yaran_core::engine::Engine::note_pty_used`]), so a macro sent from the
    /// bar exempts a brief run from the rapid-exit failure just as typing does.
    pub(crate) fn write_into_focused_pty(&mut self, bytes: &[u8]) -> bool {
        let Some(pty_id) = self.selected_terminal_surface_id() else {
            return false;
        };
        let serving = self.pty_ownership().is_some();
        if self.selected_terminal_surface_client().is_none()
            || !self.take_size_for_write(&pty_id, bytes)
        {
            return false;
        }
        let Some(provider) = self.selected_terminal_surface_client() else {
            return false;
        };
        if !serving {
            // Exactly the write this surface made before anything served.
            let _ = provider.write_bytes(bytes);
        } else if !provider.enqueue_bytes(bytes) {
            yaran_core::pty::log_dropped_pty_write();
        }
        self.engine.note_pty_used(&pty_id, bytes);
        true
    }

    /// [`Self::write_into_focused_pty`] for an agent tab named explicitly,
    /// whichever pane has focus: the board's reply is typed into the agent it
    /// is for, not into whatever happens to be on screen. True means queue
    /// acceptance, not acknowledgment from the asynchronous writer or the agent.
    pub(crate) fn write_into_agent_tab(&mut self, tab_id: &str, bytes: &[u8]) -> bool {
        if !self.engine.providers.contains_key(TabIdRef::new(tab_id))
            || !self.take_size_for_write(tab_id, bytes)
        {
            return false;
        }
        let Some(provider) = self.engine.providers.get(TabIdRef::new(tab_id)) else {
            return false;
        };
        let queued = provider.enqueue_bytes(bytes);
        if !queued {
            yaran_core::pty::log_dropped_pty_write();
        }
        queued
    }

    /// Ask the registry what writing `bytes` into `pty_id` does, carry out a
    /// size handover it causes, and report whether the bytes should go. With
    /// nothing serving every write goes and nothing is asked.
    fn take_size_for_write(&mut self, pty_id: &str, bytes: &[u8]) -> bool {
        let Some(seat) = self.pty_ownership_for(pty_id) else {
            return true;
        };
        let verdict = seat.owners.note_write(
            pty_id,
            seat.conn_id,
            // This surface's emulator answers queries itself, so nothing typed
            // here is a terminal's automatic reply, whatever its shape.
            yaran_core::pty_query_reply::classify_keyboard_write(bytes),
            Some(TUI_DEVICE_LABEL),
            |_| {},
        );
        if let Some(epoch) = verdict.epoch {
            let mut events =
                Self::claimed_events(&seat, pty_id, seat.conn_id, epoch, TUI_DEVICE_LABEL);
            events.extend(self.apply_stamped_grids(&seat, &verdict.grids));
            self.publish_ownership(&events);
        }
        verdict.forward
    }

    /// The `pty.owner` handover for every pty of `pty_id`'s row.
    fn claimed_events(
        seat: &TuiOwnership,
        pty_id: &str,
        conn_id: u64,
        epoch: u64,
        device: &str,
    ) -> Vec<PtyOwnershipEvent> {
        seat.owners
            .row_members(pty_id)
            .into_iter()
            .map(|member| PtyOwnershipEvent::Claimed {
                pty_id: member,
                conn_id,
                epoch,
                device: device.to_string(),
            })
            .collect()
    }

    /// Resize each child to its stamped grid through the one apply order every
    /// surface shares, and report the grids that reached a child. This surface
    /// applies at once while a browser's resize waits in the engine actor's
    /// queue, so a resize stamped before one of these can still be sitting there.
    fn apply_stamped_grids(
        &self,
        seat: &TuiOwnership,
        grids: &[StampedGrid],
    ) -> Vec<PtyOwnershipEvent> {
        let mut applied = Vec::new();
        for grid in grids {
            let client = self.pty_client_for(&grid.pty_id);
            let outcome = seat.owners.apply_grid_in_order(
                &grid.pty_id,
                grid.seq,
                grid.rows,
                grid.cols,
                |rows, cols| client.is_some_and(|client| client.resize(rows, cols).is_ok()),
                |rows, cols| {
                    yaran_core::logger::debug(&format!(
                        "resize of pty {} at seq {} was overtaken mid-apply, so the newer \
                         {rows}x{cols} is being re-applied",
                        grid.pty_id, grid.seq
                    ));
                },
            );
            match outcome {
                yaran_core::pty_owners::GridApplyOutcome::Applied { result: true, .. } => {
                    let (rows, cols) = yaran_core::pty::bounded_grid(grid.rows, grid.cols);
                    applied.push(PtyOwnershipEvent::GridApplied {
                        pty_id: grid.pty_id.clone(),
                        rows,
                        cols,
                        seq: grid.seq,
                    });
                }
                yaran_core::pty_owners::GridApplyOutcome::Applied { result: false, .. } => {}
                // Expected traffic under a genuine race, not an error.
                yaran_core::pty_owners::GridApplyOutcome::Dropped => {
                    yaran_core::logger::debug(&format!(
                        "resize of pty {} at seq {} dropped: a newer grid has already reached \
                         the child",
                        grid.pty_id, grid.seq
                    ));
                }
            }
        }
        applied
    }

    /// Claim `pty_id`'s row because this surface just started the child behind
    /// it, so its size follows this window from the start.
    ///
    /// It never moves the size from another device: a row another device holds
    /// keeps that device's grid until somebody types here.
    pub(crate) fn claim_launched_pty(&mut self, pty_id: &str) {
        let Some(seat) = self.pty_ownership_for(pty_id) else {
            return;
        };
        let claimed = seat.claim_if_free(pty_id);
        if claimed.is_empty() {
            return;
        }
        // A claim moves the size here, so forget the geometry last sent: the
        // next frame then sends this pane's size through the apply order.
        self.forget_sent_pty_sizes();
        self.publish_ownership(&claimed);
    }

    /// The sizing chokepoint: record `rows` x `cols` as this pane's grid for
    /// `pty_id`, and apply it when this surface holds the row.
    ///
    /// Returns whether the caller may record its resize dedupe, which is always:
    /// a grid that was only recorded is applied by the registry the moment this
    /// surface types into the row, so asking again every frame would add
    /// nothing. It never claims a free row; see the module docs.
    pub(crate) fn resize_pty_if_permitted(&mut self, pty_id: &str, rows: u16, cols: u16) -> bool {
        // The grid the child will really get, which is the one to announce.
        let (rows, cols) = yaran_core::pty::bounded_grid(rows, cols);
        let Some(seat) = self.pty_ownership_for(pty_id) else {
            // Nothing serving means no registry and no apply order to take part
            // in: resize the child directly, as this surface always did.
            if let Some(client) = self.pty_client_for(pty_id) {
                let _ = client.resize(rows, cols);
            }
            return true;
        };
        seat.owners
            .note_desired_grid(pty_id, seat.conn_id, rows, cols, Some(TUI_DEVICE_LABEL));
        if !seat.owners.is_owner(pty_id, seat.conn_id) {
            return true;
        }
        let outcome = seat.owners.claim_for_resize(
            pty_id,
            seat.conn_id,
            yaran_core::pty_owners::ResizeIntent::Plain,
            Some(TUI_DEVICE_LABEL),
            |_| {},
        );
        // Reachable unset only as a race: another device took the row between
        // the check above and this claim. The grid is recorded either way.
        if let Some(seq) = outcome.seq {
            let grid = StampedGrid {
                pty_id: pty_id.to_string(),
                rows,
                cols,
                seq,
            };
            let events = self.apply_stamped_grids(&seat, std::slice::from_ref(&grid));
            self.publish_ownership(&events);
        }
        true
    }

    /// The PTY behind a pty id, agent tab or companion terminal, in the same
    /// order the web actor's own lookup uses. Resolved from the id rather than
    /// from the selection, because the sizing chokepoint must resize the child it
    /// was given, not whatever the cursor is on by the time it runs.
    fn pty_client_for(&self, pty_id: &str) -> Option<&PtyClient> {
        // A pty id of unknown kind: which map answers is the classification.
        self.engine
            .providers
            .get(TabIdRef::new(pty_id))
            .or_else(|| {
                self.engine
                    .companion_terminals
                    .get(pty_id)
                    .map(|terminal| &terminal.client)
            })
    }

    /// Stop participating, and say so to the browsers.
    ///
    /// Called when the participation itself ends: the background server stops,
    /// the terminal is handed over to the flip, or yaran quits. Deliberately not
    /// called when the user merely selects a different agent: this surface has no
    /// socket to close, so only a deliberate end is an end. Each row this
    /// surface held goes to the most recently active browser still attached,
    /// whose grid is applied, or is left free.
    ///
    /// Runs before the serve is torn down, because the announcements ride the
    /// serve's own buses.
    pub(crate) fn release_owned_ptys(&mut self) {
        let Some(seat) = self.pty_ownership() else {
            return;
        };
        // Another device may have sized a pane drawn here, and with the seat
        // gone only this surface resizes its children: send every pane again.
        self.forget_sent_pty_sizes();
        let mut events = Vec::new();
        for (members, change) in seat.owners.release_all(seat.conn_id, |_| {}) {
            match change {
                HolderChange::Cleared { epoch } => {
                    events.extend(
                        members
                            .into_iter()
                            .map(|pty_id| PtyOwnershipEvent::Released { pty_id, epoch }),
                    );
                }
                HolderChange::Promoted {
                    epoch,
                    conn_id,
                    device,
                    grids,
                } => {
                    let device = device.unwrap_or_default();
                    events.extend(
                        members
                            .into_iter()
                            .map(|pty_id| PtyOwnershipEvent::Claimed {
                                pty_id,
                                conn_id,
                                epoch,
                                device: device.clone(),
                            }),
                    );
                    events.extend(self.apply_stamped_grids(&seat, &grids));
                }
            }
        }
        self.publish_ownership(&events);
    }

    /// Stop being a participant of every row this frame did not draw, once the
    /// drawn set changed, so a holder leaving never hands this surface a row it
    /// is not showing at a stale pane size. The panes of those rows are sent
    /// again when they are next drawn.
    pub(super) fn forget_rows_no_longer_drawn(&mut self) {
        if self.published_ptys.as_ref().map(|(drawn, _)| drawn) == Some(&self.drawn_ptys) {
            return;
        }
        let Some(seat) = self.pty_ownership() else {
            return;
        };
        let shown: Vec<&str> = self.drawn_ptys.iter().map(|t| t.id.as_str()).collect();
        for pty_id in seat
            .owners
            .forget_participation_except(seat.conn_id, &shown)
        {
            self.pty_sizes.remove(&pty_id);
            for part in [CenterPart::Main, CenterPart::Dock] {
                if self.part_targets.get(part) == Some(pty_id.as_str()) {
                    self.part_targets.set(part, None);
                }
            }
        }
    }

    /// Hand ownership facts to the companion, which is the only thing that can
    /// announce them. A no-op with nothing to say.
    fn publish_ownership(&mut self, events: &[PtyOwnershipEvent]) {
        if events.is_empty() {
            return;
        }
        if let Some(companion) = self.companion.as_mut() {
            companion.publish_ownership_events(events);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::background_server::BackgroundServerStart;
    use crate::app::background_server::tests::{FakeCompanion, Recorded};
    use crate::app::test_support::{default_bindings, test_app};
    use crate::app::{CenterMode, FocusPane, InputTarget};
    use crate::model::SessionSurface;
    use crate::statusline::StatusTone;
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use yaran_core::engine::{AgentLaunchReadyOutcome, AgentLaunchReadyView};
    use yaran_core::ids::TabId;

    /// An app with a serving companion, plus the registry seat the companion
    /// handed it and the record of what it published.
    fn serving_app() -> (
        App,
        std::sync::Arc<std::sync::Mutex<Recorded>>,
        TuiOwnership,
    ) {
        let mut app = test_app(default_bindings());
        let (companion, recorded, ownership) = FakeCompanion::serving_with_ownership();
        app.companion = Some(companion);
        (app, recorded, ownership)
    }

    /// A launch started here claims an unowned pty and announces it once.
    /// Without the announcement a browser watching the agent never learns this
    /// terminal is driving it.
    #[test]
    fn a_launch_claims_an_unowned_pty_and_announces_it_once() {
        let (mut app, recorded, seat) = serving_app();

        app.claim_launched_pty("s1");
        assert!(seat.owners.is_owner("s1", seat.conn_id));
        let published = recorded.lock().expect("not poisoned").published.clone();
        assert_eq!(
            published,
            vec![PtyOwnershipEvent::Claimed {
                pty_id: "s1".to_string(),
                conn_id: seat.conn_id,
                epoch: 1,
                device: TUI_DEVICE_LABEL.to_string(),
            }],
            "the claim must be announced with this surface's device label"
        );

        // Every keystroke after it is an ordinary write by the holder: allowed,
        // and silent, or the bus would carry one handover per character.
        assert!(app.take_size_for_write("s1", b"x"));
        assert_eq!(
            recorded.lock().expect("not poisoned").published.len(),
            1,
            "an owner's later keystrokes announce nothing"
        );

        // And a relaunch of a pty this surface already drives announces nothing
        // either: there is no handover to report.
        app.claim_launched_pty("s1");
        assert_eq!(recorded.lock().expect("not poisoned").published.len(), 1);
    }

    /// A granted resize publishes its grid, which is what a web watcher adopts.
    /// Without this the watcher renders the child's bytes into a differently
    /// sized emulator and records wrapped garbage in its scrollback.
    #[test]
    fn a_granted_resize_publishes_the_grid_for_web_watchers() {
        let (mut app, recorded, seat) = app_with_a_live_pty();
        // The claim is a deliberate act (here, a launch started on this surface);
        // the resize that follows is the ordinary one the render pass sends.
        app.claim_launched_pty("session-1-slot");

        assert!(app.resize_pty_if_permitted("session-1-slot", 24, 80));
        let published = recorded.lock().expect("not poisoned").published.clone();
        assert_eq!(
            published,
            vec![
                PtyOwnershipEvent::Claimed {
                    pty_id: "session-1-slot".to_string(),
                    conn_id: seat.conn_id,
                    epoch: 1,
                    device: TUI_DEVICE_LABEL.to_string(),
                },
                PtyOwnershipEvent::GridApplied {
                    pty_id: "session-1-slot".to_string(),
                    rows: 24,
                    cols: 80,
                    seq: 1,
                },
            ],
            "an unowned pty is claimed and its new grid announced, in that order"
        );
    }

    /// A pane smaller than the smallest grid a PTY takes announces the grid the
    /// child really got, so a watcher adopts that rather than the request.
    #[test]
    fn a_granted_resize_announces_the_grid_the_child_was_given() {
        let (mut app, recorded, _seat) = app_with_a_live_pty();
        app.claim_launched_pty("session-1-slot");

        assert!(app.resize_pty_if_permitted("session-1-slot", 0, 1));
        let published = recorded.lock().expect("not poisoned").published.clone();
        let announced: Vec<(u16, u16)> = published
            .iter()
            .filter_map(|event| match event {
                PtyOwnershipEvent::GridApplied { rows, cols, .. } => Some((*rows, *cols)),
                _ => None,
            })
            .collect();
        assert_eq!(
            announced,
            [(yaran_core::pty::PTY_MIN_ROWS, yaran_core::pty::PTY_MIN_COLS)]
        );
    }

    /// A grid is announced only for a resize that actually reached a child.
    ///
    /// The claim can be granted for a pty whose provider has since gone (an agent
    /// that exited between the claim and the apply). Announcing its geometry
    /// anyway makes every watcher adopt a grid no child is drawing for, and
    /// nothing later corrects it: the announcement is the correction.
    #[test]
    fn a_resize_with_no_child_left_to_apply_it_to_announces_no_grid() {
        let (mut app, recorded, seat) = serving_app();
        app.claim_launched_pty("gone");

        assert!(
            app.resize_pty_if_permitted("gone", 24, 80),
            "the resize itself is still granted: this surface owns this pty"
        );
        assert!(seat.owners.is_owner("gone", seat.conn_id));
        let published = recorded.lock().expect("not poisoned").published.clone();
        assert!(
            published
                .iter()
                .all(|event| !matches!(event, PtyOwnershipEvent::GridApplied { .. })),
            "no child was resized, so no grid may be announced: {published:?}"
        );
    }

    /// Releasing is what the participation's ends do, and it announces every pty
    /// it let go of. Without the announcement a browser's take-over card names a
    /// terminal that has stopped serving, forever.
    #[test]
    fn releasing_lets_go_of_every_owned_pty_and_announces_each_one() {
        let (mut app, recorded, seat) = serving_app();
        app.claim_launched_pty("s1");
        app.claim_launched_pty("s2");
        recorded.lock().expect("not poisoned").published.clear();

        app.release_owned_ptys();

        assert!(!seat.owners.is_owner("s1", seat.conn_id));
        assert!(!seat.owners.is_owner("s2", seat.conn_id));
        let published = recorded.lock().expect("not poisoned").published.clone();
        assert_eq!(published.len(), 2, "both releases announced: {published:?}");
        assert!(
            published
                .iter()
                .all(|event| matches!(event, PtyOwnershipEvent::Released { .. })),
            "a release announces an owner-cleared handover, nothing else: {published:?}"
        );
    }

    /// A release must not take a pty another device has since claimed, and a
    /// second release has nothing to say.
    #[test]
    fn releasing_leaves_another_devices_pty_alone_and_is_quiet_the_second_time() {
        let (mut app, recorded, seat) = serving_app();
        let browser = seat.owners.next_conn_id();
        seat.owners.claim("theirs", browser).expect("claimed");
        app.claim_launched_pty("mine");
        recorded.lock().expect("not poisoned").published.clear();

        app.release_owned_ptys();
        assert!(seat.owners.is_owner("theirs", browser));
        assert_eq!(recorded.lock().expect("not poisoned").published.len(), 1);

        recorded.lock().expect("not poisoned").published.clear();
        app.release_owned_ptys();
        assert!(
            recorded.lock().expect("not poisoned").published.is_empty(),
            "there was nothing left to release, so nothing may be announced"
        );
    }

    /// An app with a real PTY under the cursor in the center pane, so the focused
    /// terminal surface resolves to something ownable and the render pass has a
    /// child to (not) resize.
    fn app_with_a_live_pty() -> (
        App,
        std::sync::Arc<std::sync::Mutex<Recorded>>,
        TuiOwnership,
    ) {
        app_with_a_live_pty_running("printf ready; sleep 5")
    }

    /// The same fixture with the child's script named, so a test that needs real
    /// scrollback to scroll into can ask for a chatty one.
    fn app_with_a_live_pty_running(
        script: &str,
    ) -> (
        App,
        std::sync::Arc<std::sync::Mutex<Recorded>>,
        TuiOwnership,
    ) {
        let (mut app, recorded, seat) = serving_app();
        app.selected_left = 1;
        app.center_mode = CenterMode::Agent;
        app.session_surface = SessionSurface::Agent;
        app.engine.providers.insert(
            TabId::new("session-1-slot"),
            crate::pty::PtyClient::spawn(
                "sh",
                &["-c".to_string(), script.to_string()],
                std::path::Path::new("."),
                10,
                10,
                100,
            )
            .expect("spawn pty"),
        );
        (app, recorded, seat)
    }

    /// Read a drawn frame back as one string per screen row.
    ///
    /// Row by row rather than one flat string, because the card's prose is
    /// centred and wrapped: a flat string welds the end of one row onto the
    /// start of the next and onto whatever the panes beside it are showing.
    fn rows_of(terminal: &ratatui::Terminal<ratatui::backend::TestBackend>) -> Vec<String> {
        let buffer = terminal.backend().buffer();
        (0..buffer.area.height)
            .map(|y| {
                (0..buffer.area.width)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect()
    }

    /// Draw the whole app at `width` x `height` and hand back its rows.
    fn render_rows(app: &mut App, width: u16, height: u16) -> Vec<String> {
        use ratatui::Terminal;
        use ratatui::backend::TestBackend;

        let mut terminal = Terminal::new(TestBackend::new(width, height)).expect("terminal");
        terminal
            .draw(|frame| app.render(frame))
            .expect("render succeeds");
        rows_of(&terminal)
    }

    /// A real `User-Agent`, exactly as a browser presents one and exactly as the
    /// registry records it. Mirrored from the web's own `deviceLabel` fixtures.
    const REAL_CHROME_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
         AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    /// Every end of the participation lets go, and the ONE place that ends it is
    /// the quiet stop: the palette command, a config reload that turns the setting
    /// off, the flip, and quitting all route through it.
    #[test]
    fn stopping_the_background_server_releases_this_surfaces_ptys() {
        let (mut app, recorded, seat) = serving_app();
        app.claim_launched_pty("s1");
        assert!(seat.owners.is_owner("s1", seat.conn_id));
        recorded.lock().expect("not poisoned").published.clear();

        app.stop_background_server_quietly();

        assert!(
            !seat.owners.is_owner("s1", seat.conn_id),
            "the serve is over, so nothing here may still be recorded as driving a pty"
        );
        let published = recorded.lock().expect("not poisoned").published.clone();
        assert!(
            published
                .iter()
                .any(|event| matches!(event, PtyOwnershipEvent::Released { .. })),
            "the release must be announced while the serve's buses are still up: {published:?}"
        );
    }

    /// The `PageUp` key as the host sends it, which is the default `ScrollPageUp`
    /// binding.
    const PAGE_UP_BYTES: &[u8] = b"\x1b[5~";

    /// The same rule for a page key that yaran answers itself by scrolling the
    /// local scrollback. Entering scroll mode is looking, not typing.
    #[test]
    fn a_page_key_that_scrolls_locally_claims_nothing() {
        let (mut app, recorded, seat) = app_with_a_live_pty();
        app.input_target = InputTarget::Agent;
        // The local scroll needs a page height to scroll by.
        app.set_focused_pty_size((10, 10));

        app.process_raw_input_bytes(PAGE_UP_BYTES);

        assert!(
            !seat.owners.is_owner("session-1-slot", seat.conn_id),
            "scrolling back is not driving the terminal"
        );
        assert_eq!(
            recorded.lock().expect("not poisoned").published,
            Vec::<PtyOwnershipEvent>::new()
        );
    }

    /// THE REPORTED BUG, as a test. A browser starts an agent; this surface
    /// merely draws the new pane, and that draw must not make this terminal the
    /// agent's driver. The browser's own attach resize arrives afterwards, and
    /// attaching never steals, so a passive claim here leaves the browser that
    /// started the agent watching a take-over card over its own new terminal.
    #[test]
    fn merely_rendering_a_free_pty_leaves_it_free_for_the_browser_that_started_it() {
        let (mut app, _recorded, seat) = app_with_a_live_pty();

        let _ = render_rows(&mut app, 160, 40);

        assert_eq!(
            app.pty_driver("session-1-slot"),
            PtyDriver::Free,
            "looking at a terminal is not driving it"
        );
        let browser = seat.owners.next_conn_id();
        let claim = seat.owners.claim_for_resize(
            "session-1-slot",
            browser,
            yaran_core::pty_owners::ResizeIntent::Plain,
            Some(REAL_CHROME_UA),
            |_| {},
        );
        assert!(
            claim.apply,
            "the browser that started the agent must be able to attach to it"
        );
        assert!(
            seat.owners.is_owner("session-1-slot", browser),
            "and its plain attach claims the pty nobody was driving"
        );
    }

    /// The other half of the reported bug: once the browser has attached, this
    /// surface keeps drawing the agent every frame, and none of those frames may
    /// hand it the pty back. Losing (or never having) a pty is sticky.
    #[test]
    fn a_browser_launched_agent_stays_browser_driven_however_often_it_is_drawn() {
        let (mut app, _recorded, seat) = app_with_a_live_pty();
        let browser = seat.owners.next_conn_id();
        seat.owners
            .claim_for_resize(
                "session-1-slot",
                browser,
                yaran_core::pty_owners::ResizeIntent::Plain,
                Some(REAL_CHROME_UA),
                |_| {},
            )
            .epoch
            .expect("the browser attached first");

        for _ in 0..3 {
            let _ = render_rows(&mut app, 160, 40);
        }

        assert!(
            seat.owners.is_owner("session-1-slot", browser),
            "repeated frames must not accumulate into a claim"
        );
    }

    /// A launch this surface started IS a claim, and the frame after it sizes the
    /// child. Without this half an agent started here would come up under the
    /// `Running in the background` card, and no window resize would reach its
    /// child until
    /// somebody had pressed the button.
    #[test]
    fn a_launch_started_here_claims_its_pty_and_the_next_frame_sizes_the_child() {
        let (mut app, _recorded, seat) = app_with_a_live_pty();

        app.claim_launched_pty("session-1-slot");
        assert_eq!(app.pty_driver("session-1-slot"), PtyDriver::Mine);

        let _ = render_rows(&mut app, 160, 40);
        let grid = app
            .engine
            .providers
            .get(TabIdRef::new("session-1-slot"))
            .and_then(yaran_core::pty::PtyClient::grid_size);
        assert_ne!(
            grid,
            Some((10, 10)),
            "the render pass sized the child this surface drives"
        );
        assert!(seat.owners.is_owner("session-1-slot", seat.conn_id));
    }

    /// A launch never steals. Starting a tab here while a browser drives that
    /// pty leaves the browser driving it.
    #[test]
    fn a_launch_started_here_never_takes_a_pty_another_device_drives() {
        let (mut app, _recorded, seat) = app_with_a_live_pty();
        let browser = seat.owners.next_conn_id();
        seat.owners
            .claim("session-1-slot", browser)
            .expect("claimed");

        app.claim_launched_pty("session-1-slot");

        assert!(seat.owners.is_owner("session-1-slot", browser));
    }

    /// With nothing serving there is no seat, no registry and no gate, so a
    /// render sizes the child exactly as it did before any of this existed.
    #[test]
    fn with_nothing_serving_a_render_still_sizes_the_child() {
        let (mut app, _recorded, _seat) = app_with_a_live_pty();
        app.companion = None;

        let _ = render_rows(&mut app, 160, 40);

        let grid = app
            .engine
            .providers
            .get(TabIdRef::new("session-1-slot"))
            .and_then(yaran_core::pty::PtyClient::grid_size);
        assert_ne!(
            grid,
            Some((10, 10)),
            "no seat means no gate: the resize goes straight to the child"
        );
    }

    // ── The third card: a pty nobody is driving ─────────────────────────────

    /// A ready view for `session-1`, built for a test that only cares which
    /// launch produced it.
    fn ready_view(app: &App, view: AgentLaunchReadyView) -> AgentLaunchReadyOutcome {
        AgentLaunchReadyOutcome {
            session: app.engine.sessions[0].clone(),
            tab_id: "session-1-slot".to_string(),
            pty_size: (24, 80),
            detached_session_id: None,
            wants_fullscreen: false,
            status_quiet: yaran_core::statusline::QuietSurfaces::LOUD,
            view,
        }
    }

    /// A create THIS surface asked for and the engine REFUSED must not arm a
    /// claim, or the arm sits there waiting and lands on the browser's create
    /// instead: the refusal comes back as an ordinary status rather than an
    /// error, so a claim armed before the dispatch is never taken back.
    #[test]
    fn a_create_refused_here_never_claims_the_agent_the_browser_was_creating() {
        let (mut app, _recorded, _seat) = app_with_a_live_pty();
        // The browser's create is already in flight, which is precisely what
        // makes the engine refuse this surface's.
        assert!(
            app.engine
                .mark_in_flight(yaran_core::engine::InFlightKey::CreateAgent),
            "test setup: no create was in flight yet"
        );
        let provider = app.engine.sessions[0].provider.clone();

        app.dispatch_create_agent_request(
            yaran_core::worker::CreateAgentRequest::Standalone {
                folder: std::path::PathBuf::from("."),
                title: "refused".to_string(),
                provider,
            },
            "Creating an agent...".to_string(),
        )
        .expect("a refused create comes back as a status, not an error");
        assert!(
            !app.notes.create_agent_started_here,
            "a create the engine refused must arm nothing"
        );

        // The browser's create lands. Its child has to stay free for the
        // browser that asked for it to attach to.
        let outcome = ready_view(
            &app,
            AgentLaunchReadyView::CreateCommitted {
                status_message: "Created.".to_string().into(),
                startup_result_error: None,
            },
        );
        app.apply_agent_launch_ready_view(outcome);

        assert_eq!(
            app.pty_driver("session-1-slot"),
            PtyDriver::Free,
            "the browser's own create must not be claimed by this surface"
        );
    }

    /// WHICH LAUNCHES ARE DELIBERATE. Everything a person at this keyboard asks
    /// for claims the child it starts; the startup sweep does not, because
    /// nobody asked for it.
    #[test]
    fn only_a_launch_somebody_asked_for_claims_the_child_it_starts() {
        use yaran_core::worker::AgentLaunchKind;

        assert!(
            !launch_claims_its_pty(&AgentLaunchKind::StartupAutoReopen),
            "reopening at startup is yaran catching up, not a person acting"
        );
        for kind in [
            AgentLaunchKind::Reconnect {
                status_message: String::new().into(),
            },
            AgentLaunchKind::ForceReconnect {
                status_message: String::new().into(),
            },
            AgentLaunchKind::ResumeFallback {
                status_message: String::new().into(),
            },
            AgentLaunchKind::Tab {
                is_fresh: true,
                status_message: String::new().into(),
            },
            AgentLaunchKind::Create {
                birth_identity: None,
                status_message: String::new().into(),
                status_warns: false,
                status_notes: None,
                pull_request_pin: None,
                repo_path: String::new(),
                owns_worktree: false,
                startup_result: None,
                status_op_id: String::new(),
            },
        ] {
            assert!(
                launch_claims_its_pty(&kind),
                "a launch somebody asked for claims its child"
            );
        }
    }

    use crate::app::background_server::tests::finish_a_start;

    /// Every pty a user can have running: the agent's first tab, an extra tab,
    /// and one terminal of each owner kind.
    const EVERYTHING_RUNNING: [&str; 5] = [
        "session-1-slot",
        "session-1-tab-2",
        "term-1",
        "term-2",
        "term-3",
    ];

    fn spawn_sleeper() -> crate::pty::PtyClient {
        crate::pty::PtyClient::spawn(
            "sh",
            &["-c".to_string(), "sleep 5".to_string()],
            std::path::Path::new("."),
            10,
            10,
            100,
        )
        .expect("spawn pty")
    }

    fn insert_terminal(app: &mut App, id: &str, owner: yaran_core::model::TerminalOwner) {
        app.engine.companion_terminals.insert(
            id.to_string(),
            yaran_core::model::CompanionTerminal {
                owner,
                label: id.to_string(),
                foreground_cmd: None,
                client: spawn_sleeper(),
                sort_order: 0,
                created_at: jiff::Timestamp::now(),
                list_after: None,
            },
        );
    }

    /// The state the user is in right before they switch serving on: every kind
    /// of pty running, the agent's first tab in the center pane, and nothing
    /// serving, so no registry and no card anywhere.
    fn app_running_everything_with_nothing_serving() -> (
        App,
        std::sync::Arc<std::sync::Mutex<Recorded>>,
        TuiOwnership,
    ) {
        let (mut app, recorded, seat) = app_with_a_live_pty_running("sleep 5");
        app.engine.agent_tabs.insert(
            TabId::new("session-1-tab-2"),
            yaran_core::model::AgentTab {
                id: "session-1-tab-2".to_string(),
                session_id: "session-1".to_string(),
                provider: yaran_core::model::ProviderKind::new("claude"),
                sort_order: 1,
                created_at: jiff::Timestamp::now(),
            },
        );
        app.engine
            .providers
            .insert(TabId::new("session-1-tab-2"), spawn_sleeper());
        insert_terminal(
            &mut app,
            "term-1",
            yaran_core::model::TerminalOwner::Session("session-1".to_string()),
        );
        insert_terminal(
            &mut app,
            "term-2",
            yaran_core::model::TerminalOwner::Project("project-1".to_string()),
        );
        insert_terminal(
            &mut app,
            "term-3",
            yaran_core::model::TerminalOwner::Standalone,
        );
        app.stop_background_server_quietly();
        assert!(app.pty_ownership().is_none(), "nothing is serving yet");
        recorded.lock().expect("not poisoned").published.clear();
        (app, recorded, seat)
    }

    fn claimed_ids(recorded: &std::sync::Arc<std::sync::Mutex<Recorded>>) -> Vec<String> {
        recorded
            .lock()
            .expect("not poisoned")
            .published
            .iter()
            .filter_map(|event| match event {
                PtyOwnershipEvent::Claimed { pty_id, device, .. } => {
                    assert_eq!(device, TUI_DEVICE_LABEL);
                    Some(pty_id.clone())
                }
                _ => None,
            })
            .collect()
    }

    /// THE REPORTED BUG. The user was typing into their agent a second ago and
    /// no browser exists yet; switching serving on from the palette must not
    /// cover that agent, or any other running tab or terminal, with `Running in
    /// the background`.
    #[test]
    fn switching_serving_on_here_claims_every_running_agent_tab_and_terminal() {
        let (mut app, _recorded, seat) = app_running_everything_with_nothing_serving();

        app.execute_command("start-background-server")
            .expect("the command runs");
        finish_a_start(&mut app, None);

        for pty_id in EVERYTHING_RUNNING {
            assert_eq!(
                app.pty_driver(pty_id),
                PtyDriver::Mine,
                "{pty_id} was running when serving came on, so this terminal keeps it"
            );
            assert!(seat.owners.is_owner(pty_id, seat.conn_id));
        }
    }

    /// Browsers learn about each claim exactly as they learn about a launch's:
    /// one `Claimed` per pty under this surface's device label, and nothing
    /// repeated by the frames that follow.
    #[test]
    fn each_claim_made_by_switching_serving_on_is_announced_once() {
        let (mut app, recorded, seat) = app_running_everything_with_nothing_serving();

        app.start_background_server(BackgroundServerStart::UserRequest);
        finish_a_start(&mut app, None);
        let _ = render_rows(&mut app, 160, 40);
        let _ = render_rows(&mut app, 160, 40);

        assert_eq!(claimed_ids(&recorded), EVERYTHING_RUNNING.to_vec());
        let published = recorded.lock().expect("not poisoned").published.clone();
        for pty_id in EVERYTHING_RUNNING {
            let (_, _, device) = seat.owners.current_owner(pty_id);
            assert_eq!(device.as_deref(), Some(TUI_DEVICE_LABEL), "{published:?}");
        }
    }

    /// UNCHANGED: yaran started with the setting already on, before anybody
    /// touched anything, so nothing is claimed and a browser can pick up any of
    /// it.
    #[test]
    fn a_startup_with_serving_already_on_claims_nothing() {
        let (mut app, recorded, _seat) = app_running_everything_with_nothing_serving();
        app.engine.config.server.serve_while_tui = true;

        app.start_background_server_from_config();
        finish_a_start(&mut app, None);

        for pty_id in EVERYTHING_RUNNING {
            assert_eq!(app.pty_driver(pty_id), PtyDriver::Free, "{pty_id}");
        }
        assert_eq!(claimed_ids(&recorded), Vec::<String>::new());
    }

    /// Editing the file to turn the setting on is an act the user just took at
    /// this machine, so it claims exactly as the palette command does.
    #[test]
    fn a_reload_that_turns_serving_on_claims_like_the_palette_command() {
        let (mut app, recorded, _seat) = app_running_everything_with_nothing_serving();

        app.apply_serve_while_tui_setting(crate::app::background_server::ServeWanted::On);
        finish_a_start(&mut app, None);

        for pty_id in EVERYTHING_RUNNING {
            assert_eq!(app.pty_driver(pty_id), PtyDriver::Mine, "{pty_id}");
        }
        assert_eq!(claimed_ids(&recorded), EVERYTHING_RUNNING.to_vec());
    }

    /// Stopping releases everything; starting again from here claims whatever
    /// is still running, rather than leaving the second serve to cover it all.
    #[test]
    fn stopping_and_starting_again_here_reclaims_what_is_running() {
        let (mut app, recorded, seat) = app_running_everything_with_nothing_serving();
        app.start_background_server(BackgroundServerStart::UserRequest);
        finish_a_start(&mut app, None);

        app.stop_background_server();
        for pty_id in EVERYTHING_RUNNING {
            assert_eq!(seat.owners.current_owner(pty_id).0, None, "{pty_id}");
        }
        recorded.lock().expect("not poisoned").published.clear();

        app.start_background_server(BackgroundServerStart::UserRequest);
        finish_a_start(&mut app, None);

        for pty_id in EVERYTHING_RUNNING {
            assert_eq!(app.pty_driver(pty_id), PtyDriver::Mine, "{pty_id}");
        }
        assert_eq!(claimed_ids(&recorded), EVERYTHING_RUNNING.to_vec());
    }

    /// The claim is refused by the registry, never forced: a pty another
    /// connection somehow already holds stays that connection's.
    #[test]
    fn switching_serving_on_never_takes_a_pty_another_connection_holds() {
        let (mut app, recorded, seat) = app_running_everything_with_nothing_serving();
        let browser = seat.owners.next_conn_id();
        seat.owners
            .may_write("term-2", browser, Some(REAL_CHROME_UA), || {})
            .epoch
            .expect("the browser holds term-2");

        app.start_background_server(BackgroundServerStart::UserRequest);
        finish_a_start(&mut app, None);

        assert!(seat.owners.is_owner("term-2", browser));
        assert!(!claimed_ids(&recorded).contains(&"term-2".to_string()));
        for pty_id in EVERYTHING_RUNNING.iter().filter(|id| **id != "term-2") {
            assert_eq!(app.pty_driver(pty_id), PtyDriver::Mine, "{pty_id}");
        }
    }

    /// A dormant tab has no process, so there is no pty to claim, and its row is
    /// left alone.
    #[test]
    fn switching_serving_on_claims_no_dormant_tab() {
        let (mut app, recorded, seat) = app_running_everything_with_nothing_serving();
        app.engine.providers.remove(TabIdRef::new("session-1-slot"));

        app.start_background_server(BackgroundServerStart::UserRequest);
        finish_a_start(&mut app, None);

        assert_eq!(seat.owners.current_owner("session-1-slot").0, None);
        assert!(!claimed_ids(&recorded).contains(&"session-1-slot".to_string()));
    }

    /// The claim is made where the serve starts, not by this surface, so this
    /// surface still has to forget the geometry it last sent: otherwise a child
    /// something else re-gridded before serving came on keeps that grid, because
    /// the dedupe sees the same pane against the same target and sends nothing.
    #[test]
    fn switching_serving_on_here_lets_the_next_frame_size_the_claimed_child() {
        let (mut app, _recorded, _seat) = app_running_everything_with_nothing_serving();
        let client = |app: &App| {
            app.engine
                .providers
                .get(TabIdRef::new("session-1-slot"))
                .and_then(yaran_core::pty::PtyClient::grid_size)
        };
        // Learn the geometry this pane has while serving.
        app.start_background_server(BackgroundServerStart::UserRequest);
        finish_a_start(&mut app, None);
        let _ = render_rows(&mut app, 160, 40);
        let sized = client(&app).expect("a sized child");
        app.stop_background_server_quietly();

        // Something re-grids the child, while this surface remembers having
        // already sent this pane's geometry to it.
        app.engine
            .providers
            .get(TabIdRef::new("session-1-slot"))
            .expect("live child")
            .resize(10, 10)
            .expect("re-grid the child");
        app.part_targets.main = Some("session-1-slot".to_string());
        app.pty_sizes.insert("session-1-slot".to_string(), sized);

        app.start_background_server(BackgroundServerStart::UserRequest);
        finish_a_start(&mut app, None);
        let _ = render_rows(&mut app, 160, 40);

        assert_eq!(
            client(&app),
            Some(sized),
            "the frame after the claim sized the child"
        );
    }

    /// A live pty with one agent macro defined and the macro bar opened over it
    /// through the default chord, which works whatever covers the pane.
    fn open_the_macro_bar(app: &mut App) {
        app.engine.config.macros.entries.insert(
            "Greet".to_string(),
            crate::config::MacroEntry {
                text: "hello".to_string(),
                surface: crate::config::MacroSurface::Agent,
            },
        );
        app.handle_key(KeyEvent::new(KeyCode::Char('\\'), KeyModifiers::CONTROL))
            .expect("the chord is handled");
        assert!(app.macro_bar.is_some(), "the macro bar opens over the pane");
    }

    fn press_enter(app: &mut App) {
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
            .expect("the key is handled");
    }

    /// The driver's own macro reaches its child and says it was sent.
    #[test]
    fn a_macro_from_the_driving_surface_is_sent() {
        let (mut app, _recorded, seat) = app_with_a_live_pty_running("sleep 5");
        app.focus = FocusPane::Center;
        seat.owners
            .claim("session-1-slot", seat.conn_id)
            .expect("this surface claimed the pty");

        open_the_macro_bar(&mut app);
        press_enter(&mut app);

        let (tone, message) = app.status.most_recent_tui().expect("a status was set");
        assert_eq!(tone, StatusTone::Info);
        assert!(message.contains("Sent macro"), "{message}");
        assert!(
            app.engine.pty_run_was_used("session-1-slot"),
            "the macro reached the child"
        );
    }

    /// Nothing serving: no registry is consulted, and every write and resize
    /// goes to the child exactly as it did before this surface had a seat.
    #[test]
    fn with_nothing_serving_every_write_and_resize_goes_straight_through() {
        let mut app = test_app(default_bindings());
        assert!(app.companion.is_none(), "the fixture installs no companion");
        assert!(app.take_size_for_write("s1", b"x"));
        assert!(app.take_size_for_write("s1", b"\x1b[I"));
        assert!(app.resize_pty_if_permitted("s1", 24, 80));
        assert_eq!(app.pty_driver("s1"), PtyDriver::Free);
    }

    /// Typing here into a row a browser holds reaches the child, and moves the
    /// row's size here first: this pane's recorded grid is applied and both the
    /// handover and the grid are announced to the browsers.
    #[test]
    fn typing_into_a_row_a_browser_holds_moves_its_size_here_and_reaches_the_child() {
        let (mut app, recorded, seat) = app_with_a_live_pty_running("sleep 5");
        app.focus = FocusPane::Center;
        let browser = seat.owners.next_conn_id();
        seat.owners
            .claim("session-1-slot", browser)
            .expect("the browser holds it");
        // Drawing records this pane's grid without applying it.
        let _ = render_rows(&mut app, 160, 40);
        assert!(seat.owners.is_owner("session-1-slot", browser));
        let pane = *app
            .pty_sizes
            .get("session-1-slot")
            .expect("the pane recorded its grid");
        recorded.lock().expect("not poisoned").published.clear();

        assert!(app.write_into_focused_pty(b"a"), "everybody may type");

        assert!(seat.owners.is_owner("session-1-slot", seat.conn_id));
        assert!(app.engine.pty_run_was_used("session-1-slot"));
        let grid = app
            .engine
            .providers
            .get(TabIdRef::new("session-1-slot"))
            .and_then(yaran_core::pty::PtyClient::grid_size);
        assert_eq!(grid, Some(pane), "the child was sized for this pane");
        let published = recorded.lock().expect("not poisoned").published.clone();
        assert!(
            matches!(
                published.first(),
                Some(PtyOwnershipEvent::Claimed { conn_id, device, .. })
                    if *conn_id == seat.conn_id && device == TUI_DEVICE_LABEL
            ),
            "{published:?}"
        );
        assert!(
            published.iter().any(|event| matches!(
                event,
                PtyOwnershipEvent::GridApplied { pty_id, rows, cols, .. }
                    if pty_id == "session-1-slot" && (*rows, *cols) == pane
            )),
            "{published:?}"
        );
    }

    /// A resize while a browser holds the size is recorded as this pane's
    /// grid, applied nothing and announced nothing; typing then applies it.
    #[test]
    fn a_resize_while_a_browser_holds_the_size_is_recorded_not_applied() {
        let (mut app, recorded, seat) = serving_app();
        let browser = seat.owners.next_conn_id();
        seat.owners.claim("s1", browser).expect("claimed");

        assert!(app.resize_pty_if_permitted("s1", 40, 120));
        assert!(seat.owners.is_owner("s1", browser));
        assert_eq!(
            recorded.lock().expect("not poisoned").published,
            Vec::<PtyOwnershipEvent>::new()
        );
        let verdict = seat.owners.note_write(
            "s1",
            seat.conn_id,
            yaran_core::pty::PtyWriteKind::Typing,
            None,
            |_| {},
        );
        assert_eq!(
            verdict
                .grids
                .iter()
                .map(|g| (g.rows, g.cols))
                .collect::<Vec<_>>(),
            vec![(40, 120)]
        );
    }

    /// A pointer report reaches the child without moving the size; a focus
    /// report into a row a browser holds is dropped.
    #[test]
    fn a_pointer_report_keeps_the_browsers_size_and_a_focus_report_is_dropped() {
        let (mut app, _recorded, seat) = serving_app();
        let browser = seat.owners.next_conn_id();
        seat.owners.claim("s1", browser).expect("claimed");

        assert!(app.take_size_for_write("s1", b"\x1b[<0;3;4M"));
        assert!(seat.owners.is_owner("s1", browser));
        assert!(!app.take_size_for_write("s1", b"\x1b[I"));
        assert!(seat.owners.is_owner("s1", browser));
    }

    /// Typing into a pty nobody holds claims it: the first device to type
    /// sizes it.
    #[test]
    fn typing_into_a_free_pty_claims_it_and_reaches_the_child() {
        let (mut app, _recorded, seat) = app_with_a_live_pty();
        app.focus = FocusPane::Center;

        assert!(app.write_into_focused_pty(b"a"));
        assert!(seat.owners.is_owner("session-1-slot", seat.conn_id));
        assert!(app.engine.pty_run_was_used("session-1-slot"));
    }

    /// A PTY sized for another device draws clipped inside a smaller pane and
    /// padded inside a larger one, and never panics either way.
    #[test]
    fn a_pty_at_another_devices_grid_is_clipped_or_padded_in_the_pane() {
        let (mut app, _recorded, seat) = app_with_a_live_pty_running("echo hi; sleep 5");
        let browser = seat.owners.next_conn_id();
        seat.owners
            .claim("session-1-slot", browser)
            .expect("the browser holds it");
        for (rows, cols) in [(200, 500), (3, 12)] {
            let _ = app
                .engine
                .providers
                .get(TabIdRef::new("session-1-slot"))
                .expect("running")
                .resize(rows, cols);
            for (width, height) in [(160, 40), (30, 8)] {
                let drawn = render_rows(&mut app, width, height);
                assert_eq!(drawn.len(), usize::from(height));
            }
        }
        assert!(
            seat.owners.is_owner("session-1-slot", browser),
            "drawing moved nothing"
        );
    }

    /// Stopping here hands each row this surface held to the most recently
    /// active browser still attached, announced with that browser's device.
    #[test]
    fn releasing_hands_a_row_to_the_browser_still_attached() {
        let (mut app, recorded, seat) = serving_app();
        let browser = seat.owners.next_conn_id();
        seat.owners
            .note_desired_grid("s1", browser, 30, 90, Some(REAL_CHROME_UA));
        app.claim_launched_pty("s1");
        recorded.lock().expect("not poisoned").published.clear();

        app.release_owned_ptys();

        assert!(seat.owners.is_owner("s1", browser));
        let published = recorded.lock().expect("not poisoned").published.clone();
        assert_eq!(
            published,
            vec![PtyOwnershipEvent::Claimed {
                pty_id: "s1".to_string(),
                conn_id: browser,
                epoch: seat.owners.current_owner("s1").1,
                device: REAL_CHROME_UA.to_string(),
            }]
        );
    }

    /// A macro sent while a browser holds the size reaches the child and moves
    /// the size here, like any other typing.
    #[test]
    fn a_macro_into_a_row_a_browser_holds_is_sent() {
        let (mut app, _recorded, seat) = app_with_a_live_pty_running("sleep 5");
        app.focus = FocusPane::Center;
        let browser = seat.owners.next_conn_id();
        seat.owners
            .claim("session-1-slot", browser)
            .expect("the browser holds it");

        open_the_macro_bar(&mut app);
        press_enter(&mut app);

        let (tone, message) = app.status.most_recent_tui().expect("a status was set");
        assert_eq!(tone, StatusTone::Info);
        assert!(message.contains("Sent macro"), "{message}");
        assert!(app.engine.pty_run_was_used("session-1-slot"));
        assert!(seat.owners.is_owner("session-1-slot", seat.conn_id));
    }

    /// Stopping the serve after a browser sized a row gives the child back this
    /// pane's grid on the next frame: with no registry left, nothing else would.
    #[test]
    fn stopping_the_serve_resizes_a_row_a_browser_sized_back_to_this_pane() {
        let (mut app, _recorded, seat) = app_with_a_live_pty_running("sleep 5");
        let browser = seat.owners.next_conn_id();
        seat.owners
            .claim("session-1-slot", browser)
            .expect("the browser holds it");
        let grid = |app: &App| {
            app.engine
                .providers
                .get(TabIdRef::new("session-1-slot"))
                .and_then(yaran_core::pty::PtyClient::grid_size)
        };
        let _ = render_rows(&mut app, 160, 40);
        let pane = app.pty_sizes.get("session-1-slot").copied();
        assert_ne!(grid(&app), pane, "drawing applied nothing");

        app.stop_background_server_quietly();
        let _ = render_rows(&mut app, 160, 40);

        assert_eq!(grid(&app), pane);
    }

    /// A row this surface stopped drawing is never handed to it when its
    /// holder leaves: the pane size it recorded there is stale.
    #[test]
    fn a_row_this_surface_stopped_drawing_is_not_promoted_to_it() {
        let (mut app, _recorded, seat) = serving_app();
        let browser = seat.owners.next_conn_id();
        seat.owners.claim("s1", browser).expect("claimed");
        assert!(app.resize_pty_if_permitted("s1", 40, 120));

        let _ = render_rows(&mut app, 160, 40);

        let released = seat.owners.release_all(browser, |_| {});
        assert!(
            matches!(released[..], [(_, HolderChange::Cleared { .. })]),
            "{released:?}"
        );
        assert!(
            !app.pty_sizes.contains_key("s1"),
            "drawing it again records this pane afresh"
        );
    }

    /// Keys typed here never count as a terminal's automatic answer, however
    /// they look: a batch shaped like a reply reaches the child and moves the
    /// size here like any other typing.
    #[test]
    fn reply_shaped_keys_typed_here_are_typing() {
        let (mut app, _recorded, seat) = serving_app();
        let browser = seat.owners.next_conn_id();
        seat.owners.claim("s1", browser).expect("claimed");

        assert!(app.take_size_for_write("s1", b"\x1bPp\x1b\\"));
        assert!(seat.owners.is_owner("s1", seat.conn_id));
    }
}
