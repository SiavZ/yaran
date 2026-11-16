//! The diff-comment journey on the terminal UI: the cursor, the Form-family
//! editor reached from the diff view's key, persistence, stale pruning, and
//! the send through the ownership gate.

use std::sync::Arc;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::text::Line;
use yaran_core::diff_comments::{DiffAnchor, DiffComment, DiffSide};
use yaran_core::ids::TabId;
use yaran_core::model::SessionSurface;

use crate::app::background_server::tests::FakeCompanion;
use crate::app::modal::{ModalFamily, modal_spec};
use crate::app::test_support::{default_bindings, test_app};
use crate::app::{App, CenterMode, FocusPane, InputTarget, PromptState};
use crate::statusline::StatusTone;

fn anchor(line: usize, text: &str) -> DiffAnchor {
    DiffAnchor {
        rel_path: "README.md".to_string(),
        side: DiffSide::New,
        line_number: line,
        line_content: text.to_string(),
    }
}

/// The newest status set, which the line may still be queueing behind an
/// earlier confirmation.
pub(super) fn last_status(app: &App) -> (StatusTone, String) {
    let newest = app.status.snapshot().pop().expect("a status was set");
    (StatusTone::from_wire(&newest.tone), newest.message)
}

fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}

/// The test app with its agent stored (comments reference it) and a diff of
/// README.md on screen whose rows 2 and 3 are commentable.
pub(super) fn diff_app() -> App {
    let mut app = test_app(default_bindings());
    let session = app.engine.sessions[0].clone();
    app.engine.session_store.create_session(&session).unwrap();
    open_diff(
        &mut app,
        vec![anchor(45, "## title"), anchor(46, "**sub**")],
    );
    app
}

fn open_diff(app: &mut App, anchors: Vec<DiffAnchor>) {
    let mut lines = vec![Line::from("--- a/README.md"), Line::from("@@ -1 +1 @@")];
    let mut slots: Vec<Option<DiffAnchor>> = vec![None, None];
    for a in anchors {
        lines.push(Line::from(format!("+{}", a.line_content)));
        slots.push(Some(a));
    }
    let lines = Arc::new(lines);
    app.center_mode = CenterMode::Diff {
        lines: Arc::clone(&lines),
        scroll: 0,
        gutter_width: 0,
        worktree_path: String::new(),
        rel_path: "README.md".to_string(),
    };
    app.focus = FocusPane::Center;
    app.adopt_diff_anchors(&lines, Some(slots), "README.md");
}

fn type_text(app: &mut App, text: &str) {
    for c in text.chars() {
        app.handle_key(key(KeyCode::Char(c))).unwrap();
    }
}

/// Comment on the cursor's line through the keys a person presses: the diff
/// view's comment key, engage, type, leave the field, focus Save, press it.
fn comment_through_keys(app: &mut App, text: &str) {
    app.handle_key(key(KeyCode::Char('c'))).unwrap();
    assert!(matches!(app.prompt, PromptState::CommentDiffLine { .. }));
    app.handle_key(key(KeyCode::Enter)).unwrap();
    assert_eq!(
        app.input_target,
        InputTarget::StartupCommand,
        "Enter engages"
    );
    type_text(app, text);
    app.handle_key(key(KeyCode::Esc)).unwrap();
    assert!(
        matches!(app.prompt, PromptState::CommentDiffLine { .. }),
        "Escape inside the engaged field only leaves edit mode"
    );
    app.handle_key(key(KeyCode::Tab)).unwrap();
    app.handle_key(key(KeyCode::Tab)).unwrap();
    app.handle_key(key(KeyCode::Enter)).unwrap();
}

#[test]
fn the_editor_is_a_form_with_a_full_text_field_and_a_save_button() {
    let mut app = diff_app();
    app.open_diff_comment_editor();
    let spec = modal_spec(&app.prompt).expect("a modal is open");
    assert_eq!(spec.family, ModalFamily::Form);
    assert!(spec.multiline_field && spec.confirm_button);
    assert!(spec.satisfies_dual_mode_rule());
    // Unengaged: a typed letter goes nowhere, so the diff keys cannot leak in.
    app.handle_key(key(KeyCode::Char('x'))).unwrap();
    let PromptState::CommentDiffLine { input, anchor, .. } = &app.prompt else {
        panic!("still open");
    };
    assert_eq!(input.text, "");
    assert_eq!(anchor, &self::anchor(45, "## title"));
}

#[test]
fn a_comment_written_through_the_keys_is_queued_persisted_and_editable() {
    let mut app = diff_app();
    comment_through_keys(&mut app, "Use an h4");
    assert!(matches!(app.prompt, PromptState::None));
    let stored = app.engine.session_store.load_diff_comments().unwrap();
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].text, "Use an h4");
    assert_eq!(stored[0].anchor, anchor(45, "## title"));
    assert_eq!(app.diff_comment_count_for_path("README.md"), 1);

    // Reopening holds the queued text; clearing it and saving removes it.
    app.open_diff_comment_editor();
    let PromptState::CommentDiffLine { input, .. } = &mut app.prompt else {
        panic!("open");
    };
    assert_eq!(input.text, "Use an h4");
    input.clear();
    app.apply_diff_comment_prompt();
    assert_eq!(
        app.engine.session_store.load_diff_comments().unwrap(),
        Vec::new()
    );
    let (_, message) = last_status(&app);
    assert!(
        message.contains("Removed the comment on README.md line 45"),
        "{message}"
    );
}

#[test]
fn escape_abandons_the_editor_without_saving() {
    let mut app = diff_app();
    app.open_diff_comment_editor();
    app.handle_key(key(KeyCode::Enter)).unwrap();
    type_text(&mut app, "draft");
    app.handle_key(key(KeyCode::Esc)).unwrap();
    app.handle_key(key(KeyCode::Esc)).unwrap();
    assert!(matches!(app.prompt, PromptState::None));
    assert_eq!(
        app.engine.session_store.load_diff_comments().unwrap(),
        Vec::new()
    );
}

#[test]
fn the_line_keys_move_the_cursor_over_commentable_lines_only() {
    let mut app = diff_app();
    assert_eq!(app.diff_comments.cursor, Some(2), "starts on the first one");
    app.handle_key(key(KeyCode::Down)).unwrap();
    assert_eq!(app.diff_comments.cursor, Some(3));
    app.handle_key(key(KeyCode::Down)).unwrap();
    assert_eq!(app.diff_comments.cursor, Some(3), "stops at the last");
    app.handle_key(key(KeyCode::Up)).unwrap();
    assert_eq!(app.diff_comments.cursor, Some(2));
    let CenterMode::Diff { scroll, .. } = app.center_mode else {
        panic!("diff");
    };
    assert_eq!(scroll, 0, "a cursor already in view does not scroll");
}

#[test]
fn a_diff_with_no_anchors_keeps_its_scroll_keys_and_refuses_a_comment() {
    let mut app = diff_app();
    let lines = match &app.center_mode {
        CenterMode::Diff { lines, .. } => Arc::clone(lines),
        CenterMode::Agent => unreachable!(),
    };
    app.adopt_diff_anchors(&lines, None, "README.md");
    assert!(!app.move_diff_cursor(1), "the caller scrolls instead");
    app.handle_key(key(KeyCode::Char('c'))).unwrap();
    assert!(matches!(app.prompt, PromptState::None));
    let (tone, _) = last_status(&app);
    assert_eq!(tone, StatusTone::Warning);
}

#[test]
fn a_comment_whose_line_changed_is_dropped_when_the_diff_lands_again() {
    let mut app = diff_app();
    for (line, text) in [(45, "kept"), (46, "stale")] {
        let comment = DiffComment {
            session_id: "session-1".to_string(),
            anchor: anchor(line, if line == 45 { "## title" } else { "**sub**" }),
            text: text.to_string(),
        };
        app.engine
            .session_store
            .upsert_diff_comment(&comment)
            .unwrap();
        app.diff_comments.queued.push(comment);
    }
    // Line 46's text changed in the recomputed diff.
    open_diff(
        &mut app,
        vec![anchor(45, "## title"), anchor(46, "**SUB**")],
    );
    let stored = app.engine.session_store.load_diff_comments().unwrap();
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].text, "kept");
    assert_eq!(app.selected_diff_comments().len(), 1);
}

pub(super) fn queue_two(app: &mut App) {
    comment_through_keys(app, "Use an h4");
    app.handle_key(key(KeyCode::Down)).unwrap();
    comment_through_keys(app, "No bold");
}

fn echo_terminal() -> crate::pty::PtyClient {
    let client = crate::pty::PtyClient::spawn(
        "sh",
        &["-c".to_string(), "stty raw -echo; exec cat -v".to_string()],
        std::path::Path::new("."),
        10,
        200,
        100,
    )
    .expect("spawn pty");
    std::thread::sleep(std::time::Duration::from_millis(250));
    client
}

#[test]
fn send_types_the_queue_into_the_agent_without_submitting_and_clears_it() {
    let mut app = diff_app();
    app.engine.config.defaults.diff_comment_prompt_template =
        "{line_number}: {message} {filename} {line_content}".into();
    app.engine.config.defaults.diff_comment_prompt_separator = "--".into();
    queue_two(&mut app);
    for comment in &mut app.diff_comments.queued {
        comment.anchor.rel_path.push_str("\x1b[13u");
        comment.anchor.line_content.push_str("\x1bOM\x03");
        comment.text.push('\x1a');
    }
    app.session_surface = SessionSurface::Terminal;
    let tab = app.focused_tab_id("session-1");
    app.engine
        .providers
        .insert(TabId::new(tab.clone()), echo_terminal());

    app.handle_key(key(KeyCode::Char('s'))).unwrap();

    let (tone, message) = last_status(&app);
    assert_eq!(tone, StatusTone::Info, "{message}");
    assert!(message.contains("Typed 2 diff comments"), "{message}");
    assert_eq!(
        app.engine.session_store.load_diff_comments().unwrap(),
        Vec::new()
    );
    assert!(
        matches!(app.center_mode, CenterMode::Agent),
        "back to the agent"
    );
    assert_eq!(app.session_surface, SessionSurface::Agent);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let mut seen = String::new();
    while std::time::Instant::now() < deadline {
        let provider = app
            .engine
            .providers
            .get(TabId::new(tab.clone()).as_ref())
            .unwrap();
        seen = provider
            .snapshot()
            .cells
            .iter()
            .map(|c| c.symbol.as_str())
            .collect();
        if seen.contains(r"**sub**\x1bOM\x03") {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    // Line breaks travel as Alt-Enter (ESC CR, shown as ^[^M), and no bare
    // Enter follows: the person submits after reviewing.
    assert!(
        seen.contains(concat!(
            r"45: Use an h4\x1a README.md\x1b[13u ## title\x1bOM\x03",
            "^[^M--^[^M^[^M",
            r"46: No bold\x1a README.md\x1b[13u **sub**\x1bOM\x03"
        )),
        "{seen}"
    );
    assert!(!seen.contains(r"\x03^M"), "nothing submitted: {seen}");
    assert!(!seen.contains("^C") && !seen.contains("^Z"), "{seen}");
    assert!(!seen.contains("^[[") && !seen.contains("^[O"), "{seen}");
}

#[test]
fn send_is_refused_and_keeps_the_queue_when_another_device_drives_the_agent() {
    let mut app = diff_app();
    queue_two(&mut app);
    let tab = app.focused_tab_id("session-1");
    app.engine
        .providers
        .insert(TabId::new(tab.clone()), echo_terminal());
    let (companion, _recorded, seat) = FakeCompanion::serving_with_ownership();
    app.companion = Some(companion);
    let browser = seat.owners.next_conn_id();
    seat.owners
        .claim(&tab, browser)
        .expect("the browser drives it");

    app.send_diff_comments();

    let (tone, message) = last_status(&app);
    assert_eq!(tone, StatusTone::Warning);
    assert!(
        message.contains("Did not send the 2 diff comments"),
        "{message}"
    );
    assert_eq!(
        app.engine.session_store.load_diff_comments().unwrap().len(),
        2
    );
    assert!(
        !app.engine.pty_run_was_used(&tab),
        "nothing reached the child"
    );
}

#[test]
fn send_with_nothing_running_or_nothing_queued_says_so() {
    let mut app = diff_app();
    app.send_diff_comments();
    let (_, message) = last_status(&app);
    assert!(message.contains("No diff comments are queued"), "{message}");
    queue_two(&mut app);
    app.send_diff_comments();
    let (tone, message) = last_status(&app);
    assert_eq!(tone, StatusTone::Warning);
    assert!(message.contains("is not running"), "{message}");
    assert_eq!(app.selected_diff_comments().len(), 2, "still queued");
}

#[test]
fn the_diff_pane_flags_the_line_draws_its_comment_and_names_the_keys() {
    use ratatui::{Terminal, backend::TestBackend};
    let mut app = diff_app();
    comment_through_keys(&mut app, "Use an h4");
    app.engine.unstaged_files = vec![yaran_core::model::ChangedFile {
        status: "M".into(),
        path: "README.md".into(),
        additions: 2,
        deletions: 0,
        binary: false,
        diff_excluded: false,
        renamed_from: None,
        kind: yaran_core::model::ChangedFileKind::File,
    }];
    let mut terminal = Terminal::new(TestBackend::new(200, 30)).unwrap();
    terminal.draw(|frame| app.render(frame)).unwrap();
    let buffer = terminal.backend().buffer();
    let text: String = buffer
        .content()
        .chunks(usize::from(buffer.area.width))
        .map(|row| {
            row.iter()
                .map(ratatui::buffer::Cell::symbol)
                .collect::<String>()
                + "\n"
        })
        .collect();
    assert!(
        text.contains("⚑ +## title"),
        "the commented line is flagged:\n{text}"
    );
    assert!(text.contains("╭ comment"), "{text}");
    assert!(
        text.contains("│ Use an h4"),
        "the comment is drawn under it:\n{text}"
    );
    assert!(
        text.contains("comment") && text.contains("send 1 diff comment"),
        "{text}"
    );
    assert!(
        text.contains("⚑1 +2"),
        "the changed file counts its comment:\n{text}"
    );
}

/// The diff-comment settings and the startup-warning switch render with
/// their defaults, and a changed value survives both the commented
/// first-creation render and the plain save render.
#[test]
fn diff_comment_settings_render_and_round_trip() {
    let defaults = crate::config::render_config_documented(&yaran_core::config::Config::default());
    assert!(defaults.contains("diff_comment_editor_max_lines = 10"));
    assert!(defaults.contains("disable_startup_warnings = false"));
    assert!(defaults.contains("diff_comment_prompt_separator = \"---\""));
    assert!(defaults.contains("{line_content}") && defaults.contains("{message}"));
    let parsed: yaran_core::config::Config =
        toml::from_str(&defaults).expect("default render parses");
    assert_eq!(
        parsed.defaults.diff_comment_prompt_template,
        yaran_core::diff_comments::DEFAULT_PROMPT_TEMPLATE
    );

    let mut config = yaran_core::config::Config::default();
    config.defaults.diff_comment_prompt_template = "At {filename}:\t{message}\n".into();
    config.defaults.diff_comment_prompt_separator = "### next".into();
    config.ui.diff_comment_editor_max_lines = 4;
    config.ui.disable_startup_warnings = true;
    for rendered in [
        crate::config::render_config_documented(&config),
        yaran_core::config_write::render_config_plain(&config),
    ] {
        let parsed: yaran_core::config::Config = toml::from_str(&rendered).expect("render parses");
        assert_eq!(
            parsed.defaults.diff_comment_prompt_template,
            "At {filename}:\t{message}\n"
        );
        assert_eq!(parsed.defaults.diff_comment_prompt_separator, "### next");
        assert_eq!(parsed.ui.diff_comment_editor_max_lines, 4);
        assert!(parsed.ui.disable_startup_warnings);
    }
}

#[test]
fn a_click_moves_the_cursor_and_a_second_click_on_that_line_opens_the_editor() {
    use crossterm::event::{MouseButton, MouseEvent, MouseEventKind};
    use ratatui::{Terminal, backend::TestBackend};
    let mut app = diff_app();
    let mut terminal = Terminal::new(TestBackend::new(200, 30)).unwrap();
    terminal.draw(|frame| app.render(frame)).unwrap();
    let buffer = terminal.backend().buffer().clone();
    let width = usize::from(buffer.area.width);
    let (row, column) = buffer
        .content()
        .chunks(width)
        .enumerate()
        .find_map(|(y, cells)| {
            let text: String = cells.iter().map(ratatui::buffer::Cell::symbol).collect();
            text.find("+**sub**")
                .map(|x| (y, text[..x].chars().count()))
        })
        .expect("line 46 is drawn");
    let click = MouseEvent {
        kind: MouseEventKind::Down(MouseButton::Left),
        column: u16::try_from(column).unwrap(),
        row: u16::try_from(row).unwrap(),
        modifiers: KeyModifiers::NONE,
    };
    app.handle_mouse(click);
    assert_eq!(
        app.diff_comments.cursor,
        Some(3),
        "the click moved the cursor"
    );
    assert!(matches!(app.prompt, PromptState::None));
    app.handle_mouse(click);
    let PromptState::CommentDiffLine { anchor, .. } = &app.prompt else {
        panic!("a second click on the same line opens its editor");
    };
    assert_eq!(anchor, &self::anchor(46, "**sub**"));
}
