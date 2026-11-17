//! Watcher snapshots follow complete file changes and eventually reach the newest board.
//!
//! Uses atomic fixture writes and waits for observed readiness rather than scheduler timing.
//! - Test-only child of `human_board::tests`.
//!
//! <module-headers:begin>
//! ```text
//! Uses:
//! human_board/watcher_tests.rs
//! ├── human_board::tests
//! └── private_file
//! External: std, tempfile
//!
//! Used by:
//! human_board/watcher_tests.rs
//! └── human_board::tests
//! ```
//! <module-headers:end>

use super::*;

#[test]
fn the_watcher_reports_at_once_and_again_on_every_change() {
    let dir = tempfile::tempdir().unwrap();
    let store = BoardStore::new(dir.path());
    let watcher = BoardWatcher::spawn(store.clone(), Duration::from_millis(10)).unwrap();
    let wait = Duration::from_secs(5);
    let first = watcher.next_within(wait).unwrap();
    assert_eq!(first.board.unwrap(), Board::default());
    store
        .update(|board| board.post(&card(CardKind::Task, None, "a"), at(0)))
        .unwrap();
    let second = watcher.next_within(wait).unwrap();
    assert_eq!(second.board.unwrap().cards.len(), 1);
    // One logical change must not expose fs::write's truncate and write separately.
    crate::private_file::write_private_atomic(store.path(), b"garbage").unwrap();
    let third = watcher.next_within(wait).unwrap();
    assert!(third.board.is_err());
    assert!(watcher.next_within(Duration::from_millis(100)).is_none());
}

#[test]
fn latest_skips_to_the_newest_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let store = BoardStore::new(dir.path());
    let watcher = BoardWatcher::spawn(store.clone(), Duration::from_millis(5)).unwrap();
    for n in 0..3 {
        store
            .update(|board| board.post(&card(CardKind::Info, None, &format!("{n}")), at(n)))
            .unwrap();
        std::thread::sleep(Duration::from_millis(40));
    }
    // Reuse fix/human-board-watcher-test-race: wait for the last write to be observed.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let latest = loop {
        if let Some(snapshot) = watcher.latest()
            && snapshot
                .board
                .as_ref()
                .is_ok_and(|board| board.cards.len() == 3)
        {
            break snapshot;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the watcher never reported the third card"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    assert_eq!(latest.board.unwrap().cards.len(), 3);
    assert!(watcher.latest().is_none(), "nothing new since");
}
