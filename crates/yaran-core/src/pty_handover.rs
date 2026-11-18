//! Who holds a row's size next, and what that does to its children's grids:
//! the shared-input half of [`crate::pty_owners`].
//!
//! Every participant may type into a row; the participant that last typed
//! holds its size. Each participant's desired grid is recorded with every
//! resize, so a typing transfer ([`PtySizeOwners::note_write`]) and a holder
//! leaving ([`PtySizeOwners::leave_seat`], [`PtySizeOwners::release_all`])
//! can stamp the new holder's grids in the one apply order every surface
//! shares.

use crate::pty_owners::{OwnersState, PtySizeOwners, RowKey};

/// A participant that recorded a desired grid on a row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Participant {
    /// [`OwnersState::activity`] at its last resize or keystroke on the row.
    pub active: u64,
    /// The device it presented, recorded with the holder when it is promoted.
    pub device: Option<String>,
}

/// A grid stamped for one pty of a row whose size holder just changed, in the
/// apply order every surface shares.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StampedGrid {
    /// The pty to resize.
    pub pty_id: String,
    /// The new height, in rows.
    pub rows: u16,
    /// The new width, in columns.
    pub cols: u16,
    /// The resize sequence stamped under the owners lock.
    pub seq: u64,
}

/// What a holder letting go of a row did to it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HolderChange {
    /// Nobody else was seated with a grid, so nobody holds the row now.
    Cleared {
        /// The release's epoch.
        epoch: u64,
    },
    /// The most recently active participant still seated holds it now, and
    /// its desired grids were stamped for applying.
    Promoted {
        /// The handover's epoch.
        epoch: u64,
        /// The new holder.
        conn_id: u64,
        /// The device it presented.
        device: Option<String>,
        /// Its desired grids, stamped in apply order.
        grids: Vec<StampedGrid>,
    },
}

/// What [`PtySizeOwners::note_write`] decided about one write.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct WriteVerdict {
    /// Whether the bytes go to the child.
    pub forward: bool,
    /// The epoch of the size handover this write caused, if it caused one.
    pub epoch: Option<u64>,
    /// The writer's desired grids stamped by that handover, in apply order.
    pub grids: Vec<StampedGrid>,
}

impl OwnersState {
    /// Stamp `conn_id`'s desired grid for every pty of `row` it recorded one
    /// for, handing each to `apply` under this lock so seq order is apply order.
    pub(crate) fn stamp_desired(
        &mut self,
        row: &RowKey,
        conn_id: u64,
        apply: &mut impl FnMut(&StampedGrid),
    ) -> Vec<StampedGrid> {
        let mut grids = Vec::new();
        for pty_id in self.members_of(row) {
            let Some(&(rows, cols)) = self.desired.get(&(pty_id.clone(), conn_id)) else {
                continue;
            };
            let seq = self.grid_seq.entry(pty_id.clone()).or_insert(0);
            *seq += 1;
            let grid = StampedGrid {
                pty_id,
                rows,
                cols,
                seq: *seq,
            };
            apply(&grid);
            grids.push(grid);
        }
        grids
    }

    /// Forget everything `conn_id` recorded on `row`: it is no longer seated.
    pub(crate) fn forget_participant(&mut self, row: &RowKey, conn_id: u64) {
        self.participants.remove(&(row.clone(), conn_id));
        for pty_id in self.members_of(row) {
            self.desired.remove(&(pty_id, conn_id));
        }
    }

    /// After `row` was let go of, hand it to the most recently active
    /// participant still seated on it, or leave it free when there is none.
    pub(crate) fn promote_after_release(
        &mut self,
        row: &RowKey,
        released_epoch: u64,
        apply: &mut impl FnMut(&StampedGrid),
    ) -> HolderChange {
        let next = self
            .participants
            .iter()
            .filter(|((seated_row, _), _)| seated_row == row)
            .max_by_key(|((_, conn_id), participant)| (participant.active, *conn_id))
            .map(|((_, conn_id), participant)| (*conn_id, participant.device.clone()));
        let Some((conn_id, device)) = next else {
            return HolderChange::Cleared {
                epoch: released_epoch,
            };
        };
        let epoch = self.record_owner(row.clone(), conn_id, device.as_deref());
        let grids = self.stamp_desired(row, conn_id, apply);
        HolderChange::Promoted {
            epoch,
            conn_id,
            device,
            grids,
        }
    }
}

impl PtySizeOwners {
    /// Record `rows` x `cols` as the grid `conn_id` would size `pty_id` to, its
    /// natural fitted viewport, and mark it active on the pty's row. Called with
    /// EVERY resize a participant sends, holder or not: the grid is applied the
    /// moment the participant becomes holder, by typing ([`Self::note_write`])
    /// or by promotion when the holder leaves ([`Self::leave_seat`],
    /// [`Self::release_all`]). Stored bounded, as the child would get it.
    ///
    /// # Panics
    ///
    /// Panics when the owners lock is poisoned by an earlier panic while it was held.
    pub fn note_desired_grid(
        &self,
        pty_id: &str,
        conn_id: u64,
        rows: u16,
        cols: u16,
        device: Option<&str>,
    ) {
        let mut owners = self
            .owners
            .lock()
            .expect("the pty owners lock is not poisoned");
        let row = owners.row_noting(pty_id);
        owners.desired.insert(
            (pty_id.to_string(), conn_id),
            crate::pty::bounded_grid(rows, cols),
        );
        owners.activity += 1;
        let active = owners.activity;
        owners.participants.insert(
            (row, conn_id),
            Participant {
                active,
                device: device.map(str::to_owned),
            },
        );
    }

    /// `conn_id` now shows no row but those of `shown`: forget its desired
    /// grids everywhere else, so a holder leaving never promotes it to a row it
    /// is not showing. A row it holds stays held. Reports the ptys of every row
    /// it was forgotten on.
    ///
    /// # Panics
    ///
    /// Panics when the owners lock is poisoned by an earlier panic while it was held.
    pub fn forget_participation_except(&self, conn_id: u64, shown: &[&str]) -> Vec<String> {
        let mut owners = self
            .owners
            .lock()
            .expect("the pty owners lock is not poisoned");
        let shown: std::collections::HashSet<RowKey> =
            shown.iter().map(|pty_id| owners.row_for(pty_id)).collect();
        let rows: Vec<RowKey> = owners
            .participants
            .keys()
            .filter(|(row, conn)| *conn == conn_id && !shown.contains(row))
            .map(|(row, _)| row.clone())
            .collect();
        let mut forgotten = Vec::new();
        for row in rows {
            owners.forget_participant(&row, conn_id);
            forgotten.extend(owners.members_of(&row));
        }
        forgotten.sort_unstable();
        forgotten
    }
}

#[cfg(test)]
mod tests {
    use crate::pty_owners::*;

    /// Run `claim_for_resize` and report whether its resize effect ran.
    fn claim_resize(
        owners: &PtySizeOwners,
        pty: &str,
        conn: u64,
        intent: ResizeIntent,
    ) -> (ResizeClaim, bool) {
        let applied = std::cell::Cell::new(false);
        let outcome = owners.claim_for_resize(pty, conn, intent, None, |_| {
            applied.set(true);
        });
        (outcome, applied.get())
    }

    /// An agent's row: its first tab, a second tab and a companion terminal.
    fn agent_row(owners: &PtySizeOwners) {
        let row = RowKey::Agent("s1".to_string());
        for pty in ["s1-slot", "s1-tab2", "term-1"] {
            owners.join_row(pty, row.clone());
        }
    }

    fn page(raw: &str) -> PageId {
        PageId::parse(raw).expect("a well-formed page id")
    }

    const PAGE_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const PAGE_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    /// A write of `kind` from `conn`, recording every grid the verdict
    /// stamped through the apply callback.
    fn write(
        owners: &PtySizeOwners,
        pty: &str,
        conn: u64,
        kind: crate::pty::PtyWriteKind,
    ) -> (WriteVerdict, Vec<StampedGrid>) {
        let mut applied = Vec::new();
        let verdict = owners.note_write(pty, conn, kind, Some("ua"), |grid| {
            applied.push(grid.clone());
        });
        (verdict, applied)
    }

    /// A non-holder's TYPING is accepted and makes it the size holder of the
    /// whole row, and every grid it recorded for the row's ptys is stamped
    /// and applied under the lock before the bytes are written.
    #[test]
    fn a_non_holders_typing_transfers_the_row_and_applies_its_grids() {
        let owners = PtySizeOwners::default();
        agent_row(&owners);
        let holder = owners.next_conn_id();
        let typist = owners.next_conn_id();
        assert!(owners.claim("s1-slot", holder).is_some());
        owners.note_desired_grid("s1-slot", typist, 30, 100, Some("phone"));
        owners.note_desired_grid("term-1", typist, 12, 100, Some("phone"));

        let (verdict, applied) =
            write(&owners, "s1-slot", typist, crate::pty::PtyWriteKind::Typing);
        assert!(verdict.forward, "everybody may type");
        let epoch = verdict.epoch.expect("typing moves the size");
        assert_eq!(
            owners.current_owner("term-1"),
            (Some(typist), epoch, Some("ua".to_string()))
        );
        assert_eq!(
            applied, verdict.grids,
            "every stamped grid was handed to apply"
        );
        let grids: Vec<(&str, u16, u16)> = verdict
            .grids
            .iter()
            .map(|g| (g.pty_id.as_str(), g.rows, g.cols))
            .collect();
        assert_eq!(grids, vec![("s1-slot", 30, 100), ("term-1", 12, 100)]);
        assert_eq!(owners.grid_seq("s1-slot"), verdict.grids[0].seq);

        let (again, applied) = write(&owners, "s1-slot", typist, crate::pty::PtyWriteKind::Typing);
        assert!(
            again.forward && again.epoch.is_none() && applied.is_empty(),
            "the holder just types"
        );
    }

    /// A non-holder with no recorded grid still takes the size by typing; the
    /// child keeps whatever grid it has until that participant resizes.
    #[test]
    fn typing_without_a_recorded_grid_transfers_and_resizes_nothing() {
        let owners = PtySizeOwners::default();
        let holder = owners.next_conn_id();
        let typist = owners.next_conn_id();
        owners.claim("p", holder);
        let (verdict, applied) = write(&owners, "p", typist, crate::pty::PtyWriteKind::Typing);
        assert!(verdict.forward && verdict.epoch.is_some());
        assert!(applied.is_empty() && verdict.grids.is_empty());
        assert!(owners.is_owner("p", typist));
    }

    /// A non-holder's resize is recorded as its desired grid and NOT applied:
    /// it stamps nothing and moves nothing.
    #[test]
    fn a_non_holders_resize_is_recorded_not_applied() {
        let owners = PtySizeOwners::default();
        let holder = owners.next_conn_id();
        let viewer = owners.next_conn_id();
        owners.claim("p", holder);
        let stamped = owners.grid_seq("p");
        owners.note_desired_grid("p", viewer, 50, 200, None);
        let (out, applied) = claim_resize(&owners, "p", viewer, ResizeIntent::Plain);
        assert!(!out.apply && !applied && out.epoch.is_none());
        assert_eq!(owners.grid_seq("p"), stamped, "nothing was stamped");
        assert!(owners.is_owner("p", holder));
        let (verdict, _) = write(&owners, "p", viewer, crate::pty::PtyWriteKind::Typing);
        assert_eq!(
            verdict
                .grids
                .iter()
                .map(|g| (g.rows, g.cols))
                .collect::<Vec<_>>(),
            vec![(50, 200)],
            "the recorded grid is what typing applies"
        );
    }

    /// A pointer report from a non-holder reaches the child but moves nothing:
    /// a viewer renders the true grid, so its cell coordinates are valid.
    #[test]
    fn a_non_holders_pointer_report_passes_without_a_transfer() {
        let owners = PtySizeOwners::default();
        let holder = owners.next_conn_id();
        let viewer = owners.next_conn_id();
        owners.claim("p", holder);
        owners.note_desired_grid("p", viewer, 50, 200, None);
        let (verdict, applied) = write(
            &owners,
            "p",
            viewer,
            crate::pty::PtyWriteKind::Pointer(crate::pty::PointerReport::Button),
        );
        assert!(verdict.forward && verdict.epoch.is_none() && applied.is_empty());
        assert!(owners.is_owner("p", holder));
    }

    /// A non-holder's focus report and its terminal's automatic query replies
    /// are dropped, so the child gets one answer rather than one per attached
    /// terminal; from the holder both pass.
    #[test]
    fn a_non_holders_focus_report_and_query_reply_are_dropped() {
        use crate::pty::PtyWriteKind::{Ignored, QueryReply};
        let owners = PtySizeOwners::default();
        let holder = owners.next_conn_id();
        let viewer = owners.next_conn_id();
        owners.claim("p", holder);
        for kind in [Ignored, QueryReply] {
            let (verdict, _) = write(&owners, "p", viewer, kind);
            assert_eq!(verdict, WriteVerdict::default(), "{kind:?} from a viewer");
            let (verdict, _) = write(&owners, "p", holder, kind);
            assert!(
                verdict.forward && verdict.epoch.is_none(),
                "{kind:?} from the holder"
            );
        }
        assert!(owners.is_owner("p", holder));
    }

    /// When the holder leaves, the most recently active participant still
    /// seated becomes holder and its grid is applied; when nobody is left the
    /// row is free.
    #[test]
    fn a_leaving_holder_promotes_the_most_recently_active_seated_participant() {
        let owners = PtySizeOwners::default();
        agent_row(&owners);
        let holder = owners.take_seat(Some(&page(PAGE_A)), "s1-slot");
        let older = owners.take_seat(None, "s1-slot");
        let newer = owners.take_seat(Some(&page(PAGE_B)), "term-1");
        owners.note_desired_grid("s1-slot", older.id(), 20, 60, Some("old"));
        owners.note_desired_grid("term-1", newer.id(), 15, 90, Some("new"));
        owners.note_desired_grid("s1-slot", holder.id(), 40, 120, Some("holder"));
        let (verdict, _) = write(
            &owners,
            "s1-slot",
            holder.id(),
            crate::pty::PtyWriteKind::Typing,
        );
        assert!(verdict.epoch.is_some());

        let mut applied = Vec::new();
        let change = owners
            .leave_seat(&holder, |grid| applied.push(grid.clone()))
            .expect("the holder left");
        let HolderChange::Promoted {
            epoch,
            conn_id,
            device,
            grids,
        } = change
        else {
            panic!("someone is still seated: {change:?}");
        };
        assert_eq!(conn_id, newer.id(), "the most recently active wins");
        assert_eq!(device.as_deref(), Some("new"));
        assert_eq!(grids, applied);
        assert_eq!(
            grids
                .iter()
                .map(|g| (g.pty_id.as_str(), g.rows, g.cols))
                .collect::<Vec<_>>(),
            vec![("term-1", 15, 90)]
        );
        assert_eq!(owners.current_owner("s1-slot").0, Some(newer.id()));
        assert_eq!(owners.current_owner("s1-slot").1, epoch);

        assert!(
            owners
                .leave_seat(&newer, |_| {})
                .is_some_and(|change| matches!(
                    change,
                    HolderChange::Promoted { conn_id, .. } if conn_id == older.id()
                ))
        );
        assert!(matches!(
            owners.leave_seat(&older, |_| {}),
            Some(HolderChange::Cleared { .. })
        ));
        assert_eq!(owners.current_owner("s1-slot").0, None);
    }

    /// The terminal UI letting go of everything hands each row it held to the
    /// most recently active participant still seated there.
    #[test]
    fn release_all_promotes_the_next_participant_on_each_row() {
        let owners = PtySizeOwners::default();
        let tui = owners.next_conn_id();
        let browser = owners.take_seat(None, "a");
        owners.claim("a", tui);
        owners.claim("b", tui);
        owners.note_desired_grid("a", tui, 10, 10, None);
        owners.note_desired_grid("a", browser.id(), 33, 99, Some("ua"));
        let released = owners.release_all(tui, |_| {});
        assert_eq!(released.len(), 2);
        assert!(matches!(
            &released[0].1,
            HolderChange::Promoted { conn_id, grids, .. }
                if *conn_id == browser.id() && grids.len() == 1 && grids[0].rows == 33
        ));
        assert!(matches!(released[1].1, HolderChange::Cleared { .. }));
        assert_eq!(owners.release_all(tui, |_| {}), Vec::new());
    }

    /// A participant forgotten on the rows it stopped showing is never
    /// promoted to one, keeps the row it still shows, and keeps a row it holds.
    #[test]
    fn a_participant_is_not_promoted_to_a_row_it_stopped_showing() {
        let owners = PtySizeOwners::default();
        let tui = owners.next_conn_id();
        let browser = owners.take_seat(None, "a");
        owners.note_desired_grid("a", tui, 10, 10, None);
        owners.note_desired_grid("b", tui, 10, 10, None);
        owners.note_desired_grid("a", browser.id(), 33, 99, Some("ua"));
        owners.claim("a", browser.id());
        owners.claim("c", tui);
        owners.note_desired_grid("c", tui, 10, 10, None);

        assert_eq!(
            owners.forget_participation_except(tui, &["b"]),
            vec!["a".to_string(), "c".to_string()]
        );
        assert!(matches!(
            owners.leave_seat(&browser, |_| {}),
            Some(HolderChange::Cleared { .. })
        ));
        assert!(owners.is_owner("c", tui), "a held row stays held");
        assert_eq!(
            owners.forget_participation_except(tui, &["b"]),
            Vec::<String>::new()
        );
    }

    /// A frame from a socket that has left records nothing: its seat can no
    /// longer be held, so no ghost participant or holder is left behind.
    #[test]
    fn a_seat_that_has_left_cannot_be_held() {
        let owners = PtySizeOwners::default();
        let seat = owners.take_seat(Some(&page(PAGE_A)), "p");
        assert!(seat.hold().is_some());
        assert!(owners.leave_seat(&seat, |_| {}).is_none());
        assert!(seat.hold().is_none(), "the leave is final");
        assert!(owners.leave_seat(&seat, |_| {}).is_none(), "and once only");
    }
}
