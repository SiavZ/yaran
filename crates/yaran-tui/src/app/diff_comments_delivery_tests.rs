//! A saturated PTY must leave comments queued, and an empty editor must not claim a deletion.

use std::time::{Duration, Instant};

use yaran_core::ids::TabId;

use super::tests::{diff_app, last_status, queue_two};
use crate::app::background_server::tests::FakeCompanion;
use crate::statusline::StatusTone;

fn blocked_terminal() -> crate::pty::PtyClient {
    let client = crate::pty::PtyClient::spawn(
        "sh",
        &[
            "-c".to_string(),
            "stty raw -echo; printf ready; exec sleep 30".to_string(),
        ],
        std::path::Path::new("."),
        10,
        80,
        100,
    )
    .expect("spawn a child that keeps its input open without reading");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let text: String = client
            .snapshot()
            .cells
            .iter()
            .map(|c| c.symbol.as_str())
            .collect();
        if text.contains("ready") {
            return client;
        }
        assert!(Instant::now() < deadline, "child never entered raw mode");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn a_full_input_queue_keeps_comments_with_and_without_a_serving_seat() {
    for serving in [false, true] {
        let mut app = diff_app();
        queue_two(&mut app);
        let tab = app.focused_tab_id("session-1");
        let terminal = blocked_terminal();
        let chunk = [b'x'; 8192];
        assert!(
            (0..2048).any(|_| !terminal.enqueue_bytes(&chunk)),
            "queue must fill"
        );
        app.engine
            .providers
            .insert(TabId::new(tab.clone()), terminal);
        if serving {
            let (companion, _recorded, seat) = FakeCompanion::serving_with_ownership();
            seat.owners
                .claim(&tab, seat.conn_id)
                .expect("TUI owns the tab");
            app.companion = Some(companion);
        }
        app.send_diff_comments();
        let (tone, message) = last_status(&app);
        assert_eq!(tone, StatusTone::Warning, "{message}");
        assert!(message.contains("terminal refused"), "{message}");
        assert_eq!(app.selected_diff_comments().len(), 2);
        assert_eq!(
            app.engine.session_store.load_diff_comments().unwrap().len(),
            2
        );
        assert!(!app.engine.pty_run_was_used(&tab));
    }
}

#[test]
fn saving_an_empty_new_comment_reports_that_nothing_was_queued() {
    let mut app = diff_app();
    app.open_diff_comment_editor();
    app.apply_diff_comment_prompt();
    assert_eq!(
        app.engine.session_store.load_diff_comments().unwrap(),
        Vec::new()
    );
    let (_, message) = last_status(&app);
    assert!(message.contains("No comment was queued"), "{message}");
}
