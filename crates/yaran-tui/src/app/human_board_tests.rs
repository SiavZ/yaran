//! The human board pane: its row model, its selection, the announcements, and
//! the pane in the real right column (keys, clicks, the card dialog, and the
//! file it writes).

use chrono::{Duration as ChronoDuration, TimeZone, Utc};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use yaran_core::human_board::{Board, BoardStore, CardKind, NewCard};

use super::*;
use crate::app::test_support::{default_bindings, test_app};
use crate::app::{FocusPane, PromptState, RightLower, RightSection};

fn at(minute: i64) -> chrono::DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 11, 12, 0, 0).unwrap() + ChronoDuration::minutes(minute)
}

fn new_card(kind: CardKind, ticket: Option<&str>, title: &str) -> NewCard {
    NewCard {
        kind: Some(kind),
        ticket: ticket.map(str::to_string),
        title: title.to_string(),
        detail: None,
        from: Some("orchestrator".to_string()),
    }
}

/// A board with one card of every kind, plus one resolved card.
fn sample_board() -> Board {
    let mut board = Board::default();
    board
        .post(
            new_card(CardKind::Info, Some("3101"), "Deployed to dev"),
            at(0),
        )
        .unwrap();
    board
        .post(
            new_card(CardKind::Validate, Some("4812"), "Check signup"),
            at(1),
        )
        .unwrap();
    board
        .post(
            new_card(CardKind::Task, None, "Pick the launch date"),
            at(2),
        )
        .unwrap();
    board
        .post(
            new_card(CardKind::Confirm, Some("3770"), "Merge the auth fix?"),
            at(3),
        )
        .unwrap();
    board
        .post(
            new_card(CardKind::Task, Some("1205"), "Old question"),
            at(4),
        )
        .unwrap();
    board.resolve(5, Some("human"), None, at(5)).unwrap();
    board
}

fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}

fn screen(app: &mut App) -> String {
    let mut terminal = Terminal::new(TestBackend::new(220, 44)).expect("terminal");
    terminal.draw(|frame| app.render(frame)).expect("render");
    let buffer = terminal.backend().buffer().clone();
    let width = usize::from(buffer.area.width);
    buffer
        .content()
        .iter()
        .map(|cell| cell.symbol().to_string())
        .collect::<Vec<_>>()
        .chunks(width)
        .map(|row| row.concat())
        .collect::<Vec<_>>()
        .join("\n")
}

fn staged_file(path: &str) -> yaran_core::model::ChangedFile {
    yaran_core::model::ChangedFile {
        path: path.to_string(),
        status: "M".to_string(),
        additions: 1,
        deletions: 0,
        binary: false,
        diff_excluded: false,
        renamed_from: None,
    }
}

/// An app with the board on and `board` written to its yaran home and read.
fn board_app(board: Option<Board>) -> App {
    let mut app = test_app(default_bindings());
    app.engine.config.ui.human_board = true;
    app.right_hidden = false;
    if let Some(board) = board {
        let store = BoardStore::new(&app.engine.paths.root);
        store
            .update(|current| {
                *current = board;
                Ok(())
            })
            .unwrap();
    }
    app.load_human_board_now();
    app
}

// ── The row model ──────────────────────────────────────────────────────────

#[test]
fn rows_group_open_cards_by_kind_then_show_recent_done() {
    let board = sample_board();
    let (rows, slots) = board_rows(&board);
    let headings: Vec<Option<CardKind>> = rows
        .iter()
        .filter_map(|row| match row {
            BoardRow::Heading { kind, .. } => Some(*kind),
            BoardRow::Card { .. } => None,
        })
        .collect();
    assert_eq!(
        headings,
        [
            Some(CardKind::Task),
            Some(CardKind::Validate),
            Some(CardKind::Confirm),
            Some(CardKind::Info),
            None
        ]
    );
    // Open cards in board order, newest first within a kind; Done last.
    assert_eq!(slots, [3, 2, 4, 1, 5]);
    assert_eq!(
        rows[0],
        BoardRow::Heading {
            kind: Some(CardKind::Task),
            count: 1
        }
    );
}

#[test]
fn an_empty_board_has_no_rows() {
    let (rows, slots) = board_rows(&Board::default());
    assert!(rows.is_empty());
    assert!(slots.is_empty());
}

#[test]
fn done_shows_only_the_most_recent_few() {
    let mut board = Board::default();
    for n in 0..(RECENT_DONE as i64 + 3) {
        board
            .post(new_card(CardKind::Info, None, &format!("n{n}")), at(n))
            .unwrap();
        let id = board.cards.last().unwrap().id;
        board.resolve(id, None, None, at(n)).unwrap();
    }
    let (rows, slots) = board_rows(&board);
    assert_eq!(slots.len(), RECENT_DONE);
    assert_eq!(rows.len(), RECENT_DONE + 1);
}

#[test]
fn fit_width_cuts_on_display_columns() {
    assert_eq!(fit_width("short", 10), "short");
    assert_eq!(fit_width("abcdefghij", 5), "abcd\u{2026}");
    // Wide glyphs count two columns each.
    assert_eq!(fit_width("日本語のテキスト", 7), "日本語\u{2026}");
    assert_eq!(fit_width("anything", 0), "");
}

// ── Selection and announcements ────────────────────────────────────────────

#[test]
fn the_first_snapshot_announces_nothing_and_later_cards_are_announced() {
    let mut state = HumanBoardState::default();
    let board = sample_board();
    assert!(state.apply_snapshot(Ok(board.clone())).is_empty());
    assert_eq!(state.selected, Some(3), "the first card is selected");

    let mut next = board.clone();
    next.post(new_card(CardKind::Confirm, Some("7"), "Roll it?"), at(10))
        .unwrap();
    let fresh = state.apply_snapshot(Ok(next));
    assert_eq!(fresh.len(), 1);
    assert_eq!(fresh[0].title, "Roll it?");

    let message = announcement(&fresh).unwrap();
    assert!(
        message.starts_with("New on the board for you: #6 [7] Roll it?"),
        "{message}"
    );
    assert!(
        message.contains("Confirmation needed from orchestrator"),
        "{message}"
    );
    assert!(message.contains("Tasks for Human"), "{message}");
}

#[test]
fn news_only_announcements_do_not_claim_to_wait_on_you() {
    let mut board = Board::default();
    board
        .post(new_card(CardKind::Info, None, "a"), at(0))
        .unwrap();
    board
        .post(new_card(CardKind::Info, None, "b"), at(1))
        .unwrap();
    let fresh: Vec<_> = board.cards.clone();
    let message = announcement(&fresh).unwrap();
    assert!(
        message.starts_with("2 new cards on the board; newest: #2 b"),
        "{message}"
    );
    assert!(announcement(&[]).is_none());
}

#[test]
fn the_selection_follows_its_card_when_a_new_one_lands_above_it() {
    let mut state = HumanBoardState::default();
    let board = sample_board();
    state.apply_snapshot(Ok(board.clone()));
    state.move_selection(1);
    assert_eq!(state.selected, Some(2), "on the validate card");

    // A new task card sorts above it; the selection stays on card 2.
    let mut next = board;
    next.post(new_card(CardKind::Task, None, "New decision"), at(20))
        .unwrap();
    state.apply_snapshot(Ok(next));
    assert_eq!(state.selected, Some(2));
    assert_eq!(state.selected_slot(), Some(2));
}

#[test]
fn a_selected_card_that_leaves_hands_the_selection_to_its_neighbour() {
    let mut state = HumanBoardState::default();
    let board = sample_board();
    state.apply_snapshot(Ok(board.clone()));
    state.move_selection(1);
    let mut next = board;
    next.cards.retain(|c| c.id != 2);
    state.apply_snapshot(Ok(next));
    assert_eq!(state.selected, Some(4), "the card now at its old position");
}

#[test]
fn moving_the_selection_stops_at_both_ends() {
    let mut state = HumanBoardState::default();
    state.apply_snapshot(Ok(sample_board()));
    state.move_selection(-5);
    assert_eq!(state.selected_slot(), Some(0));
    state.move_selection(50);
    assert_eq!(state.selected_slot(), Some(4));
}

#[test]
fn an_unreadable_board_keeps_no_selection_and_announces_nothing() {
    let mut state = HumanBoardState::default();
    assert!(state.apply_snapshot(Err("broken".to_string())).is_empty());
    assert_eq!(state.selected, None);
    assert!(state.readable().is_none());
}

// ── The pane in the right column ───────────────────────────────────────────

#[test]
fn the_board_takes_the_staged_list_and_commit_box_place() {
    let mut app = board_app(Some(sample_board()));
    app.engine.staged_files = vec![staged_file("a.rs"), staged_file("b.rs")];
    assert_eq!(app.right_lower(), RightLower::Board);
    let text = screen(&mut app);
    assert!(
        text.contains("Tasks for Human 3 waiting, 1 update"),
        "{text}"
    );
    assert!(!text.contains("Staged Changes"), "{text}");
    assert!(!text.contains("Commit Message"), "{text}");
    assert!(
        text.contains("2 staged"),
        "staged files are named, not hidden: {text}"
    );
    for line in [
        "Tasks for you 1",
        "Validation 1",
        "Confirmation needed 1",
        "What happened 1",
        "Done 1",
        "Pick the launch date",
        "4812 Check signup",
        "3770 Merge the auth fix?",
    ] {
        assert!(text.contains(line), "missing {line:?}:\n{text}");
    }
    assert!(text.contains("\u{2713} 1205 Old question"), "{text}");
}

#[test]
fn with_the_board_off_the_right_column_is_unchanged() {
    let mut app = test_app(default_bindings());
    app.right_hidden = false;
    app.engine.staged_files = vec![staged_file("a.rs")];
    assert!(!app.engine.config.ui.human_board, "off by default");
    assert_eq!(app.right_lower(), RightLower::StagedAndCommit);
    let text = screen(&mut app);
    assert!(text.contains("Staged Changes"), "{text}");
    assert!(text.contains("Commit Message"), "{text}");
    assert!(!text.contains("Tasks for Human"), "{text}");
    app.drain_human_board();
    assert!(
        app.human_board.board.is_none(),
        "an off board reads nothing"
    );
}

#[test]
fn an_empty_board_says_so_and_how_cards_arrive() {
    let mut app = board_app(None);
    let text = screen(&mut app);
    assert!(text.contains("Tasks for Human"), "{text}");
    assert!(text.contains("Nothing needs you right now."), "{text}");
    assert!(text.contains("yaran board post"), "{text}");
}

#[test]
fn an_unreadable_board_says_why_in_the_pane() {
    let mut app = test_app(default_bindings());
    app.engine.config.ui.human_board = true;
    app.right_hidden = false;
    std::fs::write(app.engine.paths.root.join("human_board.json"), "{ nope").unwrap();
    app.load_human_board_now();
    let text = screen(&mut app);
    assert!(text.contains("The board could not be read:"), "{text}");
}

#[test]
fn focus_moves_from_changes_to_the_board_and_out_of_the_pane() {
    let mut app = board_app(Some(sample_board()));
    app.engine.staged_files = vec![staged_file("a.rs")];
    app.focus = FocusPane::Files;
    app.right_section = RightSection::Unstaged;
    assert_eq!(
        app.right_section.next(app.right_lower()),
        Some(RightSection::Board)
    );
    assert_eq!(RightSection::Board.next(RightLower::Board), None);
    assert_eq!(RightSection::Board.previous(), Some(RightSection::Unstaged));
    assert_eq!(RightSection::last(RightLower::Board), RightSection::Board);
}

#[test]
fn the_cursor_never_rests_on_a_section_that_is_not_drawn() {
    let mut app = board_app(None);
    app.right_section = RightSection::CommitInput;
    app.input_target = InputTarget::CommitMessage;
    app.normalize_right_section_for_board();
    assert_eq!(app.right_section, RightSection::Board);
    assert_eq!(app.input_target, InputTarget::None);

    app.engine.config.ui.human_board = false;
    app.normalize_right_section_for_board();
    assert_eq!(app.right_section, RightSection::Unstaged);
}

#[test]
fn keys_move_open_and_resolve_the_selected_card() {
    let mut app = board_app(Some(sample_board()));
    app.focus = FocusPane::Files;
    app.right_section = RightSection::Board;

    app.handle_key(key(KeyCode::Down)).unwrap();
    assert_eq!(app.human_board.selected, Some(2));

    // The stage key marks the card done, on a worker, by number.
    app.handle_key(key(KeyCode::Char(' '))).unwrap();
    app.finish_board_job();
    let store = BoardStore::new(&app.engine.paths.root);
    let card = store.load().unwrap().card(2).unwrap().clone();
    assert!(!card.is_open());
    assert_eq!(card.resolved_by.as_deref(), Some(RESOLVED_BY));
    let latest = app.status.most_recent_tui();
    assert!(
        latest
            .as_ref()
            .is_some_and(|(_, m)| m.contains("Marked card #2 [4812] done")),
        "{latest:?}"
    );

    // Once read back it sits under Done, still selected; the same key reopens.
    app.load_human_board_now();
    assert_eq!(app.human_board.selected, Some(2));
    app.handle_key(key(KeyCode::Char(' '))).unwrap();
    app.finish_board_job();
    assert!(store.load().unwrap().card(2).unwrap().is_open());

    // Enter opens the card dialog.
    app.load_human_board_now();
    app.handle_key(key(KeyCode::Enter)).unwrap();
    let PromptState::HumanBoardCard { card, .. } = &app.prompt else {
        panic!("expected the card dialog, got {:?}", app.prompt);
    };
    assert_eq!(card.id, 2);
}

#[test]
fn the_card_dialog_shows_the_whole_card_and_its_action_resolves_it() {
    let mut board = sample_board();
    board.cards[1].detail = Some("PR 417 is merged.\nCheck on a phone.".to_string());
    let mut app = board_app(Some(board));
    app.focus = FocusPane::Files;
    app.right_section = RightSection::Board;
    app.human_board.selected = Some(2);
    app.open_selected_board_card();

    let text = screen(&mut app);
    for needle in [
        "Card 2 \u{b7} 4812",
        "Check signup",
        "Validation",
        "orchestrator",
        "PR 417 is merged.",
        "Check on a phone.",
        "Close",
        "Mark done",
    ] {
        assert!(text.contains(needle), "missing {needle:?}:\n{text}");
    }

    // Movement moves focus to the action; the confirm key acts on it.
    app.handle_key(key(KeyCode::Right)).unwrap();
    app.handle_key(key(KeyCode::Enter)).unwrap();
    assert!(matches!(app.prompt, PromptState::None));
    app.finish_board_job();
    let store = BoardStore::new(&app.engine.paths.root);
    assert!(!store.load().unwrap().card(2).unwrap().is_open());
}

#[test]
fn closing_the_card_dialog_changes_nothing() {
    let mut app = board_app(Some(sample_board()));
    app.human_board.selected = Some(3);
    app.open_selected_board_card();
    app.handle_key(key(KeyCode::Esc)).unwrap();
    assert!(matches!(app.prompt, PromptState::None));
    assert!(app.human_board.job.is_none(), "no write was started");
    let store = BoardStore::new(&app.engine.paths.root);
    assert!(store.load().unwrap().card(3).unwrap().is_open());
}

#[test]
fn a_resolved_card_offers_reopen() {
    let mut app = board_app(Some(sample_board()));
    app.human_board.selected = Some(5);
    app.open_selected_board_card();
    let text = screen(&mut app);
    assert!(text.contains("Reopen"), "{text}");
    assert!(text.contains("by human"), "{text}");
}

#[test]
fn clicking_a_card_row_focuses_the_board_and_selects_it() {
    let mut app = board_app(Some(sample_board()));
    app.focus = FocusPane::Center;
    screen(&mut app);
    let list = app
        .mouse_layout
        .board_list
        .expect("the board publishes its rows");
    let row = app
        .mouse_layout
        .board_row_to_slot
        .iter()
        .position(|slot| *slot == Some(2))
        .expect("slot 2 is on screen");
    let click = MouseEvent {
        kind: MouseEventKind::Down(MouseButton::Left),
        column: list.x + 3,
        row: list.y + row as u16,
        modifiers: KeyModifiers::NONE,
    };
    app.handle_mouse(click);
    assert_eq!(app.focus, FocusPane::Files);
    assert_eq!(app.right_section, RightSection::Board);
    assert_eq!(app.human_board.selected, Some(4), "slot 2 is card 4");
}

#[test]
fn the_toggle_flips_the_setting_and_moves_the_cursor_off_a_hidden_section() {
    let mut app = test_app(default_bindings());
    app.engine.staged_files = vec![staged_file("a.rs")];
    app.focus = FocusPane::Files;
    app.right_section = RightSection::Staged;
    app.toggle_human_board();
    assert!(app.engine.config.ui.human_board);
    assert_eq!(app.right_section, RightSection::Board);
    app.toggle_human_board();
    assert!(!app.engine.config.ui.human_board);
    assert_eq!(app.right_section, RightSection::Unstaged);
}

#[test]
fn the_palette_runs_the_toggle() {
    let mut app = test_app(default_bindings());
    app.execute_command("toggle-human-board".to_string())
        .unwrap();
    assert!(app.engine.config.ui.human_board);
}

#[test]
fn the_config_documents_human_board() {
    let rendered = crate::config::render_default_config();
    assert!(rendered.contains("human_board = false"), "{rendered}");
    assert!(rendered.contains("yaran board post"), "{rendered}");
    assert!(rendered.contains("toggle-human-board"), "{rendered}");
}

#[test]
fn the_watcher_starts_with_the_setting_and_stops_without_it() {
    let mut app = test_app(default_bindings());
    app.engine.config.ui.human_board = true;
    let store = BoardStore::new(&app.engine.paths.root);
    store
        .update(|board| board.post(new_card(CardKind::Task, None, "x"), at(0)))
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while app.human_board.readable().is_none() && std::time::Instant::now() < deadline {
        app.drain_human_board();
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert_eq!(app.human_board.readable().unwrap().cards.len(), 1);

    app.engine.config.ui.human_board = false;
    app.drain_human_board();
    assert!(
        app.human_board.board.is_none(),
        "turning it off drops the board"
    );
}

#[test]
fn the_footer_names_the_board_keys_while_the_board_has_focus() {
    let mut app = board_app(Some(sample_board()));
    app.focus = FocusPane::Files;
    app.right_section = RightSection::Board;
    let text = screen(&mut app);
    let footer = text
        .lines()
        .find(|line| line.contains("Open card"))
        .unwrap_or_else(|| panic!("no board footer:\n{text}"));
    assert!(footer.contains("Done/Reopen"), "{footer}");
    assert!(!footer.contains("Stage/Unstage"), "{footer}");
    assert!(!footer.contains("Commit msg"), "{footer}");

    app.right_section = RightSection::Unstaged;
    let text = screen(&mut app);
    assert!(
        text.contains("Stage/Unstage"),
        "the Changes list keeps its own"
    );
}

#[test]
fn a_narrow_column_keeps_the_waiting_count_and_drops_the_updates() {
    let mut app = board_app(Some(sample_board()));
    let mut terminal = Terminal::new(TestBackend::new(100, 40)).expect("terminal");
    terminal.draw(|frame| app.render(frame)).expect("render");
    let buffer = terminal.backend().buffer().clone();
    let width = usize::from(buffer.area.width);
    let text: String = buffer
        .content()
        .iter()
        .map(|cell| cell.symbol().to_string())
        .collect::<Vec<_>>()
        .chunks(width)
        .map(|row| row.concat())
        .collect::<Vec<_>>()
        .join("\n");
    let title = text
        .lines()
        .find(|line| line.contains("Tasks for Human"))
        .unwrap_or_else(|| panic!("no board:\n{text}"));
    assert!(title.contains("Tasks for Human (3)"), "{title}");
    assert!(!title.contains("wai"), "no half-cut word: {title}");
}
