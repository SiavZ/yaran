//! The human board pane: its row model, its selection, the announcements, and
//! the pane in the real right column (keys, clicks, the card dialog, and the
//! file it writes).

use chrono::{Duration as ChronoDuration, TimeZone, Utc};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use yaran_core::human_board::{Audience, Board, BoardStore, CardId, CardKind, NewCard, Priority};

use super::*;
use crate::app::test_support::{default_bindings, test_app};
use crate::app::{
    FocusPane, PromptState, RightLower, RightSection, TermGridPos, TerminalSelection,
};

fn at(minute: i64) -> chrono::DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 11, 12, 0, 0).unwrap() + ChronoDuration::minutes(minute)
}

fn new_card(kind: CardKind, ticket: Option<&str>, title: &str) -> NewCard {
    NewCard {
        kind: Some(kind),
        assignee: None,
        priority: None,
        ticket: ticket.map(str::to_string),
        title: title.to_string(),
        detail: None,
        from: Some("orchestrator".to_string()),
        ..NewCard::default()
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
    let (rows, slots) = board_rows(&board, &Audience::Everyone);
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
    let (rows, slots) = board_rows(&Board::default(), &Audience::Everyone);
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
        let id = board.cards.last().unwrap().id.clone();
        board.resolve(id, None, None, at(n)).unwrap();
    }
    let (rows, slots) = board_rows(&board, &Audience::Everyone);
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
    assert_eq!(
        state.selected,
        Some(CardId::plain(3)),
        "the first card is selected"
    );

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
    assert_eq!(
        state.selected,
        Some(CardId::plain(2)),
        "on the validate card"
    );

    // A new task card sorts above it; the selection stays on card 2.
    let mut next = board;
    next.post(new_card(CardKind::Task, None, "New decision"), at(20))
        .unwrap();
    state.apply_snapshot(Ok(next));
    assert_eq!(state.selected, Some(CardId::plain(2)));
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
    assert_eq!(
        state.selected,
        Some(CardId::plain(4)),
        "the card now at its old position"
    );
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
fn the_board_fills_the_column_and_changes_is_a_tab_beside_it() {
    let mut app = board_app(Some(sample_board()));
    app.engine.staged_files = vec![staged_file("a.rs"), staged_file("b.rs")];
    assert_eq!(app.right_lower(), RightLower::Board);
    let text = screen(&mut app);
    assert!(
        text.contains("Tasks for Human 3 waiting, 1 update"),
        "{text}"
    );
    assert!(
        text.contains("Board 3 \u{2502} Changes 2"),
        "the tab strip: {text}"
    );
    assert!(!text.contains("Staged Changes"), "{text}");
    assert!(!text.contains("Commit Message"), "{text}");
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

    // The Changes tab is the column as it is without the board.
    app.cycle_right_tab(1);
    assert_eq!(app.right_lower(), RightLower::StagedAndCommit);
    let text = screen(&mut app);
    assert!(text.contains("Staged Changes"), "{text}");
    assert!(text.contains("Commit Message"), "{text}");
    assert!(!text.contains("Tasks for Human"), "{text}");
    assert!(text.contains("Board 3"), "the strip stays: {text}");
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
fn on_a_queue_tab_the_board_is_the_pane_s_only_section() {
    let mut app = board_app(Some(sample_board()));
    app.engine.staged_files = vec![staged_file("a.rs")];
    assert_eq!(RightSection::first(app.right_lower()), RightSection::Board);
    assert_eq!(RightSection::Board.next(RightLower::Board), None);
    assert_eq!(RightSection::Board.previous(), None);
    assert_eq!(RightSection::last(RightLower::Board), RightSection::Board);

    // On the Changes tab the old order is back.
    app.cycle_right_tab(1);
    let lower = app.right_lower();
    assert_eq!(RightSection::first(lower), RightSection::Unstaged);
    assert_eq!(
        RightSection::Unstaged.next(lower),
        Some(RightSection::Staged)
    );
    assert_eq!(RightSection::last(lower), RightSection::CommitInput);
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
    assert_eq!(app.human_board.selected, Some(CardId::plain(2)));

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
    assert_eq!(app.human_board.selected, Some(CardId::plain(2)));
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
    app.human_board.selected = Some(CardId::plain(2));
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
    app.human_board.selected = Some(CardId::plain(3));
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
    app.human_board.selected = Some(CardId::plain(5));
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
    assert_eq!(
        app.human_board.selected,
        Some(CardId::plain(4)),
        "slot 2 is card 4"
    );
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

// ── Replying from the card dialog ──────────────────────────────────────────

/// A terminal that echoes what it is sent in caret notation (`^M` for the
/// Enter), standing in for the agent the reply is typed into.
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
    // Let the shell reach raw mode before anything is written.
    std::thread::sleep(std::time::Duration::from_millis(250));
    client
}

fn terminal_text(app: &App, tab_id: &str) -> String {
    let provider = app
        .engine
        .providers
        .get(yaran_core::ids::TabIdRef::new(tab_id))
        .expect("terminal");
    provider
        .snapshot()
        .cells
        .iter()
        .map(|cell| cell.symbol.as_str())
        .collect()
}

/// The board app with one open card posted by the test session's own handle,
/// and that session's tab running an echo terminal.
fn reply_app() -> (App, String) {
    let mut board = Board::default();
    let mut card = new_card(CardKind::Confirm, Some("mvp-7"), "Merge the auth fix?");
    card.from = Some("session-1".to_string());
    board.post(card, at(0)).unwrap();
    let mut app = board_app(Some(board));
    let tab = app.focused_tab_id("session-1");
    app.engine
        .providers
        .insert(yaran_core::ids::TabId::new(tab.clone()), echo_terminal());
    app.focus = FocusPane::Files;
    app.right_section = RightSection::Board;
    app.human_board.selected = Some(CardId::plain(1));
    (app, tab)
}

fn type_text(app: &mut App, text: &str) {
    for c in text.chars() {
        app.handle_key(key(KeyCode::Char(c))).unwrap();
    }
}

#[test]
fn focus_rings_include_the_reply_field_only_when_there_is_one() {
    use super::{CardStops, HumanBoardCardFocus as F};
    let reply = CardStops {
        reply: true,
        ..CardStops::default()
    };
    assert_eq!(F::Reply.step(true, reply), F::Close);
    assert_eq!(F::Close.step(true, reply), F::Send);
    assert_eq!(F::Send.step(true, reply), F::Action);
    assert_eq!(F::Action.step(true, reply), F::Reply);
    assert_eq!(F::Reply.step(false, reply), F::Action);
    let bare = CardStops::default();
    assert_eq!(F::Close.step(true, bare), F::Action);
    assert_eq!(F::Action.step(true, bare), F::Close);
    // A choice of recipients and another person add their stops in drawing
    // order: the recipient after the field, Assign after the action.
    let all = CardStops {
        reply: true,
        recipient: true,
        assign: true,
    };
    let mut at = F::Reply;
    let mut ring = vec![at];
    for _ in 0..5 {
        at = at.step(true, all);
        ring.push(at);
    }
    assert_eq!(
        ring,
        [
            F::Reply,
            F::Recipient,
            F::Close,
            F::Send,
            F::Action,
            F::Assign
        ]
    );
    assert_eq!(F::Assign.step(true, all), F::Reply);
}

#[test]
fn a_reply_goes_to_the_poster_when_it_runs_and_else_to_the_selected_agent() {
    let (mut app, tab) = reply_app();
    let card = app.human_board.selected_card().unwrap().clone();
    let target = app.reply_target_for(&card).expect("the poster is running");
    assert!(target.is_poster);
    assert_eq!(target.tab_id, tab);

    // A poster this yaran does not know: the selected agent takes it.
    let mut stranger = card.clone();
    stranger.from = Some("someone-else".to_string());
    let target = app
        .reply_target_for(&stranger)
        .expect("selected agent runs");
    assert!(!target.is_poster);

    // Nobody running: no reply field at all.
    app.engine.providers.clear();
    assert!(app.reply_target_for(&card).is_none());
}

#[test]
fn enter_types_the_reply_then_submits_it_and_marks_the_card_done() {
    let (mut app, tab) = reply_app();
    app.handle_key(key(KeyCode::Enter)).unwrap();
    assert!(
        matches!(
            app.prompt,
            PromptState::HumanBoardCard {
                reply: Some(_),
                focus: super::HumanBoardCardFocus::Reply,
                ..
            }
        ),
        "the dialog opens on the reply field: {:?}",
        app.prompt
    );
    type_text(&mut app, "yes, merge it");
    app.handle_key(key(KeyCode::Enter)).unwrap();
    assert!(
        matches!(app.prompt, PromptState::None),
        "the dialog closes on send"
    );

    std::thread::sleep(std::time::Duration::from_millis(200));
    let typed = terminal_text(&app, &tab);
    assert!(
        typed.contains("Reply to board card #1 [mvp-7] (Merge the auth fix?): yes, merge it"),
        "the reply is typed with its card: {typed:?}"
    );
    assert!(
        !typed.contains("^M"),
        "the Enter waits for its delay: {typed:?}"
    );
    assert!(
        BoardStore::new(&app.engine.paths.root)
            .load()
            .unwrap()
            .card(1)
            .unwrap()
            .is_open(),
        "nothing is marked done before the reply is submitted"
    );

    app.submit_due_replies(
        std::time::Instant::now()
            + std::time::Duration::from_millis(yaran_core::macros::COMPOSE_SUBMIT_DELAY_MS),
    );
    std::thread::sleep(std::time::Duration::from_millis(200));
    assert!(
        terminal_text(&app, &tab).contains("^M"),
        "then the Enter alone"
    );

    app.finish_board_job();
    let card = BoardStore::new(&app.engine.paths.root)
        .load()
        .unwrap()
        .card(1)
        .unwrap()
        .clone();
    assert!(!card.is_open());
    assert_eq!(card.resolved_by.as_deref(), Some(RESOLVED_BY));
    assert_eq!(card.resolution.as_deref(), Some("yes, merge it"));
    let latest = app.status.most_recent_tui();
    assert!(
        latest
            .as_ref()
            .is_some_and(|(_, m)| m.contains("Sent your reply to")
                && m.contains("marked card #1 [mvp-7] done")),
        "{latest:?}"
    );
}

#[test]
fn an_empty_reply_sends_nothing_and_keeps_the_dialog() {
    let (mut app, tab) = reply_app();
    app.open_selected_board_card();
    app.handle_key(key(KeyCode::Enter)).unwrap();
    assert!(matches!(app.prompt, PromptState::HumanBoardCard { .. }));
    assert!(app.human_board.pending_submits.is_empty());
    std::thread::sleep(std::time::Duration::from_millis(150));
    assert!(!terminal_text(&app, &tab).contains("Reply to"));
}

#[test]
fn a_reply_to_an_agent_that_stopped_keeps_the_text_and_says_why() {
    let (mut app, _tab) = reply_app();
    app.open_selected_board_card();
    type_text(&mut app, "still there?");
    app.engine.providers.clear();
    app.handle_key(key(KeyCode::Enter)).unwrap();
    let PromptState::HumanBoardCard {
        reply: Some(reply), ..
    } = &app.prompt
    else {
        panic!("the dialog stays open: {:?}", app.prompt);
    };
    assert_eq!(reply.input.text, "still there?");
    let latest = app.status.most_recent_tui();
    assert!(
        latest
            .as_ref()
            .is_some_and(|(_, m)| m.contains("no longer running")),
        "{latest:?}"
    );
}

#[test]
fn mark_done_without_a_reply_still_works_from_the_button() {
    let (mut app, _tab) = reply_app();
    app.open_selected_board_card();
    app.handle_key(key(KeyCode::Tab)).unwrap();
    app.handle_key(key(KeyCode::Tab)).unwrap();
    app.handle_key(key(KeyCode::Tab)).unwrap();
    assert!(matches!(
        app.prompt,
        PromptState::HumanBoardCard {
            focus: super::HumanBoardCardFocus::Action,
            ..
        }
    ));
    app.handle_key(key(KeyCode::Enter)).unwrap();
    app.finish_board_job();
    let card = BoardStore::new(&app.engine.paths.root)
        .load()
        .unwrap()
        .card(1)
        .unwrap()
        .clone();
    assert!(!card.is_open());
    assert_eq!(card.resolution, None);
}

#[test]
fn letters_in_the_reply_field_type_rather_than_scroll_or_move_focus() {
    let (mut app, _tab) = reply_app();
    app.open_selected_board_card();
    type_text(&mut app, "jk hl");
    let PromptState::HumanBoardCard {
        reply: Some(reply),
        focus,
        scroll,
        ..
    } = &app.prompt
    else {
        panic!("{:?}", app.prompt);
    };
    assert_eq!(reply.input.text, "jk hl");
    assert_eq!(*focus, super::HumanBoardCardFocus::Reply);
    assert_eq!(*scroll, 0);
}

#[test]
fn an_outside_click_never_drops_a_typed_reply() {
    let (mut app, _tab) = reply_app();
    app.open_selected_board_card();
    assert_eq!(
        crate::app::overlay_dismiss::outside_click_policy(&app.prompt),
        crate::app::overlay_dismiss::OutsideClickPolicy::Cancel
    );
    type_text(&mut app, "draft");
    assert_eq!(
        crate::app::overlay_dismiss::outside_click_policy(&app.prompt),
        crate::app::overlay_dismiss::OutsideClickPolicy::Blink
    );
}

#[test]
fn the_dialog_names_where_the_reply_goes_and_what_the_button_does() {
    let (mut app, _tab) = reply_app();
    app.open_selected_board_card();
    let text = screen(&mut app);
    assert!(text.contains("Reply to"), "{text}");
    assert!(
        text.contains("(posted this card), then mark done:"),
        "{text}"
    );
    assert!(text.contains("Mark done"), "{text}");
    assert!(!text.contains("Send & mark done"), "{text}");
    type_text(&mut app, "ok");
    let text = screen(&mut app);
    assert!(text.contains("Send & mark done"), "{text}");
    assert!(
        text.contains("send & mark done"),
        "the key line says it too: {text}"
    );
}

#[test]
fn a_done_card_has_no_reply_field() {
    let (mut app, _tab) = reply_app();
    BoardStore::new(&app.engine.paths.root)
        .update(|board| board.resolve(1, Some("human"), None, at(1)))
        .unwrap();
    app.load_human_board_now();
    app.human_board.selected = Some(CardId::plain(1));
    app.open_selected_board_card();
    assert!(matches!(
        app.prompt,
        PromptState::HumanBoardCard {
            reply: None,
            focus: super::HumanBoardCardFocus::Close,
            ..
        }
    ));
    let text = screen(&mut app);
    assert!(text.contains("Reopen"), "{text}");
    assert!(!text.contains("Reply to"), "{text}");
}

#[test]
fn the_selected_card_row_uses_the_agent_lists_soft_tint() {
    let mut app = board_app(Some(sample_board()));
    app.focus = FocusPane::Files;
    app.right_section = RightSection::Board;
    app.human_board.selected = Some(CardId::plain(2));
    let mut terminal = Terminal::new(TestBackend::new(220, 44)).expect("terminal");
    terminal.draw(|frame| app.render(frame)).expect("render");
    let buffer = terminal.backend().buffer().clone();
    let list = app.mouse_layout.board_list.expect("board drawn");
    let row = app
        .mouse_layout
        .board_row_to_slot
        .iter()
        .position(|slot| *slot == Some(1))
        .expect("slot 1 drawn") as u16;
    let cell = &buffer[(list.x + 3, list.y + row)];
    assert_eq!(cell.bg, app.theme.selection_bar_tint());
    assert_ne!(
        cell.bg, app.theme.selection_bg,
        "not the loud selection bar"
    );
}

#[test]
fn the_config_documents_the_reply_template() {
    let rendered = crate::config::render_default_config();
    assert!(
        rendered.contains(
            "human_board_reply_template = \"Reply to board card {card} ({title}): {reply}\""
        ),
        "{rendered}"
    );
    assert!(rendered.contains("Placeholders: {reply}"), "{rendered}");
}

// ── Priority ───────────────────────────────────────────────────────────────

fn prioritized_board() -> Board {
    let mut board = Board::default();
    let mut post = |priority, title| {
        let mut c = new_card(CardKind::Task, None, title);
        c.priority = priority;
        board.post(c, at(0)).unwrap();
    };
    post(None, "ordinary");
    post(Some(Priority::Low), "someday");
    post(Some(Priority::High), "soon");
    post(Some(Priority::Critical), "now");
    board
}

#[test]
fn urgent_cards_lead_their_group_and_wear_a_marker() {
    let mut app = board_app(Some(prioritized_board()));
    let text = screen(&mut app);
    let rows: Vec<&str> = text
        .lines()
        .filter(|l| {
            l.contains("ordinary")
                || l.contains("someday")
                || l.contains("soon")
                || l.contains("now")
        })
        .collect();
    let order: Vec<&str> = rows
        .iter()
        .map(|r| {
            ["now", "soon", "ordinary", "someday"]
                .into_iter()
                .find(|t| r.contains(t))
                .unwrap()
        })
        .collect();
    assert_eq!(order, ["now", "soon", "ordinary", "someday"], "{text}");
    assert!(rows[0].contains("!! #4 now"), "{}", rows[0]);
    assert!(rows[1].contains(" ! #3 soon"), "{}", rows[1]);
    assert!(rows[3].contains("\u{2193} #2 someday"), "{}", rows[3]);
    assert!(
        text.contains("Tasks for Human 4 waiting (2 urgent)"),
        "{text}"
    );
}

#[test]
fn the_card_view_names_the_priority() {
    let mut app = board_app(Some(prioritized_board()));
    app.human_board.selected = Some(CardId::plain(3));
    app.open_selected_board_card();
    let text = screen(&mut app);
    assert!(text.contains("Priority: High"), "{text}");
}

#[test]
fn a_new_urgent_card_is_announced_as_such() {
    let mut board = Board::default();
    let mut c = new_card(CardKind::Confirm, Some("4"), "Roll now?");
    c.priority = Some(Priority::Critical);
    board.post(c, at(0)).unwrap();
    let message = announcement(&board.cards).unwrap();
    assert!(
        message.contains("(Critical priority, Confirmation needed"),
        "{message}"
    );
}

// ── Scrolling the card view ────────────────────────────────────────────────

/// A card whose detail does not fit a short terminal, opened with the reply
/// field focused.
fn long_card_app() -> App {
    let mut board = Board::default();
    let mut c = new_card(CardKind::Task, None, "A long one");
    c.detail = Some(
        (1..=60)
            .map(|n| format!("line {n}"))
            .collect::<Vec<_>>()
            .join("\n"),
    );
    c.from = Some("session-1".to_string());
    board.post(c, at(0)).unwrap();
    let mut app = board_app(Some(board));
    // The poster runs, so the dialog opens with its reply field focused.
    let tab = app.focused_tab_id("session-1");
    app.engine
        .providers
        .insert(yaran_core::ids::TabId::new(tab), echo_terminal());
    app.human_board.selected = Some(CardId::plain(1));
    app.open_selected_board_card();
    assert!(
        matches!(
            app.prompt,
            PromptState::HumanBoardCard { reply: Some(_), .. }
        ),
        "the fixture needs a reply field"
    );
    app
}

fn card_scroll(app: &App) -> u16 {
    match &app.prompt {
        PromptState::HumanBoardCard { scroll, .. } => *scroll,
        other => panic!("{other:?}"),
    }
}

fn draw_short(app: &mut App) {
    let mut terminal = Terminal::new(TestBackend::new(160, 24)).expect("terminal");
    terminal.draw(|frame| app.render(frame)).expect("render");
}

#[test]
fn the_wheel_scrolls_the_card_text_wherever_the_pointer_is() {
    let mut app = long_card_app();
    draw_short(&mut app);
    assert!(
        app.last_error_dialog_lines > app.last_error_dialog_height,
        "the body overflows"
    );
    let wheel = |kind| MouseEvent {
        kind,
        column: 5,
        row: 5,
        modifiers: KeyModifiers::NONE,
    };
    app.handle_mouse(wheel(MouseEventKind::ScrollDown));
    assert_eq!(card_scroll(&app), 3);
    app.handle_mouse(wheel(MouseEventKind::ScrollDown));
    app.handle_mouse(wheel(MouseEventKind::ScrollUp));
    assert_eq!(card_scroll(&app), 3);
    assert!(
        matches!(app.prompt, PromptState::HumanBoardCard { .. }),
        "the dialog stays open"
    );
}

#[test]
fn arrow_keys_scroll_the_text_while_the_reply_field_is_focused_and_letters_type() {
    let mut app = long_card_app();
    draw_short(&mut app);
    app.handle_key(key(KeyCode::Down)).unwrap();
    app.handle_key(key(KeyCode::Down)).unwrap();
    assert_eq!(card_scroll(&app), 2);
    app.handle_key(key(KeyCode::Up)).unwrap();
    assert_eq!(card_scroll(&app), 1);
    type_text(&mut app, "jk");
    let PromptState::HumanBoardCard {
        reply: Some(reply),
        scroll,
        ..
    } = &app.prompt
    else {
        panic!("{:?}", app.prompt);
    };
    assert_eq!(reply.input.text, "jk", "letters are typing, not scrolling");
    assert_eq!(*scroll, 1);
}

// ── People's queues and the tab strip ──────────────────────────────────────

/// A board for two people, Sam and Alex, run by Alex: one card each, one for
/// anyone.
fn team_app() -> App {
    let mut app = test_app(default_bindings());
    app.engine.config.ui.human_board = true;
    app.engine.config.board.people = vec!["Sam".to_string(), "Alex".to_string()];
    app.engine.config.board.me = "alex".to_string();
    app.right_hidden = false;
    let mut board = Board::default();
    let mut for_sam = new_card(CardKind::Task, None, "Sign the contract");
    for_sam.assignee = Some("Sam".to_string());
    board.post(for_sam, at(0)).unwrap();
    let mut for_alex = new_card(CardKind::Validate, None, "Check the release");
    for_alex.assignee = Some("Alex".to_string());
    board.post(for_alex, at(1)).unwrap();
    board
        .post(new_card(CardKind::Info, None, "Deployed"), at(2))
        .unwrap();
    BoardStore::new(&app.engine.paths.root)
        .update(|current| {
            *current = board;
            Ok(())
        })
        .unwrap();
    app.load_human_board_now();
    app
}

#[test]
fn each_person_has_a_tab_and_the_column_opens_on_mine() {
    let mut app = team_app();
    let tabs = app.right_column_tabs();
    assert_eq!(
        tabs,
        [
            RightTab::Queue(Some("Sam".to_string())),
            RightTab::Queue(Some("Alex".to_string())),
            RightTab::Queue(None),
            RightTab::Changes,
        ]
    );
    assert_eq!(
        app.human_board.tab,
        Some(RightTab::Queue(Some("Alex".to_string()))),
        "me is Alex"
    );
    let text = screen(&mut app);
    assert!(
        text.contains("Sam 1 \u{2502} Alex 1 \u{2502} All 2"),
        "{text}"
    );
    assert!(
        text.contains("Tasks for Alex 1 waiting, 1 update"),
        "{text}"
    );
    assert!(text.contains("Check the release"), "{text}");
    assert!(
        text.contains("Deployed"),
        "a card for anyone is in every queue: {text}"
    );
    assert!(!text.contains("Sign the contract"), "{text}");
}

#[test]
fn the_tab_keys_walk_the_strip_and_wrap() {
    let mut app = team_app();
    app.focus = FocusPane::Files;
    app.right_section = RightSection::Board;
    app.handle_key(key(KeyCode::Right)).unwrap();
    assert_eq!(app.human_board.tab, Some(RightTab::Queue(None)));
    assert_eq!(app.right_section, RightSection::Board);
    app.handle_key(key(KeyCode::Char('l'))).unwrap();
    assert_eq!(app.human_board.tab, Some(RightTab::Changes));
    assert_eq!(app.right_section, RightSection::Unstaged, "off the board");
    app.handle_key(key(KeyCode::Right)).unwrap();
    assert_eq!(
        app.human_board.tab,
        Some(RightTab::Queue(Some("Sam".to_string()))),
        "wraps to the first tab"
    );
    assert_eq!(app.right_section, RightSection::Board);
    let text = screen(&mut app);
    assert!(text.contains("Tasks for Sam"), "{text}");
    assert!(text.contains("Sign the contract"), "{text}");
    app.handle_key(key(KeyCode::Left)).unwrap();
    assert_eq!(app.human_board.tab, Some(RightTab::Changes), "and back");
}

#[test]
fn the_all_tab_names_whose_each_card_is() {
    let mut app = team_app();
    app.show_right_tab(RightTab::Queue(None));
    let text = screen(&mut app);
    assert!(text.contains("Sign the contract"), "{text}");
    assert!(text.contains("Check the release"), "{text}");
    let row = text
        .lines()
        .find(|line| line.contains("Sign the contract"))
        .unwrap();
    assert!(row.contains("Sam"), "{row}");
}

#[test]
fn clicking_a_tab_shows_it() {
    let mut app = team_app();
    app.focus = FocusPane::Center;
    screen(&mut app);
    let (rect, _) = app
        .mouse_layout
        .right_tabs
        .iter()
        .find(|(_, tab)| *tab == RightTab::Queue(Some("Sam".to_string())))
        .cloned()
        .expect("Sam's tab is on screen");
    app.handle_mouse(MouseEvent {
        kind: MouseEventKind::Down(MouseButton::Left),
        column: rect.x,
        row: rect.y,
        modifiers: KeyModifiers::NONE,
    });
    assert_eq!(
        app.human_board.tab,
        Some(RightTab::Queue(Some("Sam".to_string())))
    );
    assert_eq!(app.focus, FocusPane::Files);
    assert_eq!(app.right_section, RightSection::Board);
}

#[test]
fn only_cards_for_me_are_announced() {
    let mut app = team_app();
    let store = BoardStore::new(&app.engine.paths.root);
    store
        .update(|board| {
            let mut c = new_card(CardKind::Task, None, "For Sam only");
            c.assignee = Some("Sam".to_string());
            board.post(c, at(5))?;
            board.post(new_card(CardKind::Task, None, "For anyone"), at(6))
        })
        .unwrap();
    let fresh = app.load_human_board_now();
    assert_eq!(fresh.len(), 2);
    let mine = cards_for_me(fresh.clone(), Some("alex"));
    let titles: Vec<&str> = mine.iter().map(|card| card.title.as_str()).collect();
    assert_eq!(titles, ["For anyone"]);
    assert_eq!(cards_for_me(fresh, None).len(), 2, "no me: every card");
}

#[test]
fn the_card_view_names_whose_card_it_is() {
    let mut app = team_app();
    app.show_right_tab(RightTab::Queue(Some("Sam".to_string())));
    app.open_selected_board_card();
    let text = screen(&mut app);
    assert!(text.contains("For:"), "{text}");
    assert!(text.contains(" Sam "), "{text}");
}

#[test]
fn a_shared_board_shows_how_its_last_sync_went() {
    let mut app = board_app(Some(sample_board()));
    app.human_board.last_sync = Some(yaran_core::human_board::sync::SyncOutcome {
        at: Utc::now(),
        result: Ok(Default::default()),
    });
    let text = screen(&mut app);
    assert!(text.contains("synced "), "{text}");
    app.human_board.last_sync = Some(yaran_core::human_board::sync::SyncOutcome {
        at: Utc::now(),
        result: Err("offline".to_string()),
    });
    let text = screen(&mut app);
    assert!(text.contains("sync failed "), "{text}");
}

#[test]
fn a_folder_board_reads_its_notes() {
    let mut app = test_app(default_bindings());
    app.engine.config.ui.human_board = true;
    app.right_hidden = false;
    let folder = app.engine.paths.root.join("shared-board");
    app.engine.config.board.dir = folder.to_string_lossy().into_owned();
    app.engine.config.board.me = "Kim".to_string();
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(
        folder.join("K-1.md"),
        "---\nkind: task\ntitle: Written in a notes app\n---\nSome detail.\n",
    )
    .unwrap();
    std::fs::write(
        folder.join("K-2.md"),
        "---\nkind: nonsense\ntitle: x\n---\n",
    )
    .unwrap();
    app.load_human_board_now();
    let text = screen(&mut app);
    assert!(text.contains("Written in a notes app"), "{text}");
    assert!(text.contains("1 note unreadable"), "{text}");
    // A card resolved here lands in its note.
    app.human_board.selected = Some(CardId::new("K", 1));
    app.toggle_selected_board_card();
    app.finish_board_job();
    let note = std::fs::read_to_string(folder.join("K-1.md")).unwrap();
    assert!(note.contains("status: done"), "{note}");
}

// ── A conversation between two people's boards ────────────────────────────

/// A board shared by Sam and Alex, run by `me`, holding one card that Sam's
/// agent `session-1` posted on Sam's board for Alex. The agent runs here only
/// when `me` is Sam.
fn two_sided_app(me: &str, blocking: bool) -> (App, String) {
    let mut app = test_app(default_bindings());
    app.engine.config.ui.human_board = true;
    app.engine.config.board.people = vec!["Sam".to_string(), "Alex".to_string()];
    app.engine.config.board.me = me.to_string();
    app.right_hidden = false;
    let mut board = Board::default();
    board.prefix = "S".to_string();
    let mut card = new_card(CardKind::Confirm, Some("db-9"), "Drop the old audit table?");
    card.from = Some("session-1".to_string());
    card.assignee = Some("Alex".to_string());
    card.origin = Some("Sam".to_string());
    card.blocking = Some(blocking);
    board.post(card, at(0)).unwrap();
    BoardStore::new(&app.engine.paths.root)
        .update(|current| {
            *current = board;
            Ok(())
        })
        .unwrap();
    let tab = app.focused_tab_id("session-1");
    if me == "Sam" {
        app.engine
            .providers
            .insert(yaran_core::ids::TabId::new(tab.clone()), echo_terminal());
    }
    app.load_human_board_now();
    app.after_board_snapshot();
    app.finish_board_seen_load();
    // Every card, whoever's queue it is in.
    app.show_right_tab(RightTab::Queue(None));
    app.focus = FocusPane::Files;
    app.right_section = RightSection::Board;
    app.human_board.selected = Some(CardId::new("S", 1));
    (app, tab)
}

fn card_s1(app: &App) -> Card {
    BoardStore::new(&app.engine.paths.root)
        .load()
        .unwrap()
        .card(CardId::new("S", 1))
        .unwrap()
        .clone()
}

/// Something written on the other side's machine lands on the board.
fn other_side_says(app: &mut App, from: &str, text: &str, done: bool) {
    BoardStore::new(&app.engine.paths.root)
        .update(|board| {
            board.reply(
                CardId::new("S", 1),
                yaran_core::human_board::NewMessage {
                    from: from.to_string(),
                    side: Some(from.to_string()),
                    text: text.to_string(),
                    done,
                },
                Utc::now(),
            )
        })
        .unwrap();
    app.load_human_board_now();
    app.after_board_snapshot();
}

/// Every status open on the line, the queued ones too, one per line.
fn latest_status(app: &App) -> String {
    app.status
        .snapshot()
        .into_iter()
        .map(|status| status.message)
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn a_card_from_the_other_side_answers_its_person_through_the_board() {
    let (mut app, _tab) = two_sided_app("Alex", false);
    app.open_selected_board_card();
    let PromptState::HumanBoardCard {
        reply: Some(reply), ..
    } = &app.prompt
    else {
        panic!("the card has a reply field: {:?}", app.prompt);
    };
    assert_eq!(
        reply.recipient(),
        &super::Recipient::Person {
            name: "Sam".to_string(),
            poster: Some("session-1".to_string()),
        }
    );
    assert!(
        !reply.enter_marks_done(),
        "Enter goes on with the conversation"
    );
    let text = screen(&mut app);
    assert!(text.contains("Reply to"), "{text}");
    assert!(text.contains(" Sam "), "{text}");
    assert!(
        text.contains("(their session-1 posted this card):"),
        "{text}"
    );
    assert!(text.contains("Send"), "{text}");
    assert!(
        !text.contains("Assign"),
        "a confirmation stays with whoever it was posted for: {text}"
    );

    type_text(&mut app, "Which table exactly?");
    app.handle_key(key(KeyCode::Enter)).unwrap();
    assert!(
        matches!(app.prompt, PromptState::None),
        "the dialog closes on send"
    );
    app.finish_board_job();
    let card = card_s1(&app);
    assert!(card.is_open(), "a question keeps the card open");
    assert_eq!(card.thread.len(), 1);
    assert_eq!(card.thread[0].from, "Alex");
    assert_eq!(card.thread[0].side.as_deref(), Some("Alex"));
    assert_eq!(card.thread[0].text, "Which table exactly?");
    assert!(
        latest_status(&app).contains("Added your reply to card #S-1 [db-9]"),
        "{}",
        latest_status(&app)
    );
}

#[test]
fn send_and_mark_done_answers_the_other_side_and_closes_the_card() {
    let (mut app, _tab) = two_sided_app("Alex", false);
    app.open_selected_board_card();
    type_text(&mut app, "Yes, drop it.");
    // The action button with text in the field: send it and mark done.
    app.resolve_human_board_card(true);
    app.finish_board_job();
    let card = card_s1(&app);
    assert!(!card.is_open());
    assert_eq!(card.resolved_by.as_deref(), Some("Alex"));
    assert_eq!(card.resolution.as_deref(), Some("Yes, drop it."));
    assert!(card.thread[0].done);
}

#[test]
fn on_your_own_card_you_can_ask_the_other_person_instead_of_the_agent() {
    let (mut app, tab) = two_sided_app("Sam", false);
    app.open_selected_board_card();
    let PromptState::HumanBoardCard {
        reply: Some(reply), ..
    } = &app.prompt
    else {
        panic!("{:?}", app.prompt);
    };
    assert_eq!(reply.recipients.len(), 2);
    // The card is in Alex's queue, so asking Alex comes first.
    let text = screen(&mut app);
    assert!(text.contains("Ask"), "{text}");
    assert!(text.contains(" Alex "), "{text}");
    // Tab reaches the recipient, Enter moves to the next one (the agent that
    // posted it), Enter again comes back round, Shift-Tab goes back to the
    // field.
    app.handle_key(key(KeyCode::Tab)).unwrap();
    app.handle_key(key(KeyCode::Enter)).unwrap();
    assert!(screen(&mut app).contains("(posted this card)"));
    app.handle_key(key(KeyCode::Enter)).unwrap();
    app.handle_key(key(KeyCode::BackTab)).unwrap();
    type_text(&mut app, "Can you confirm before Friday?");
    app.handle_key(key(KeyCode::Enter)).unwrap();
    app.finish_board_job();
    let card = card_s1(&app);
    assert!(card.is_open());
    assert_eq!(card.thread[0].from, "Sam");
    std::thread::sleep(std::time::Duration::from_millis(150));
    assert!(
        !terminal_text(&app, &tab).contains("Friday"),
        "nothing was typed into the agent"
    );
}

#[test]
fn assign_opens_a_picker_of_everyone_and_esc_goes_back_to_the_card() {
    let (mut app, _tab) = two_sided_app("Alex", false);
    // Only a task can be handed to someone else's queue.
    BoardStore::new(&app.engine.paths.root)
        .update(|board| {
            board.cards[0].kind = CardKind::Task;
            Ok(())
        })
        .unwrap();
    app.load_human_board_now();
    app.open_selected_board_card();
    assert!(screen(&mut app).contains("Assign\u{2026}"));
    app.assign_board_card_from_dialog();
    let PromptState::AssignBoardCard(picker) = &app.prompt else {
        panic!("the picker opens: {:?}", app.prompt);
    };
    assert_eq!(picker.people, ["Sam", "Alex"]);
    assert_eq!(
        picker.selected, 0,
        "it starts on someone whose queue the card is not in"
    );
    let text = screen(&mut app);
    assert!(text.contains("Assign card #S-1"), "{text}");
    assert!(text.contains("has it now"), "{text}");
    assert!(text.contains("(you)") || text.contains("you)"), "{text}");

    // Esc: back to the card dialog, exactly as it was.
    app.handle_key(key(KeyCode::Esc)).unwrap();
    assert!(matches!(app.prompt, PromptState::HumanBoardCard { .. }));

    // Pick Sam.
    app.assign_board_card_from_dialog();
    app.handle_key(key(KeyCode::Enter)).unwrap();
    app.finish_board_job();
    assert!(matches!(app.prompt, PromptState::None));
    let card = card_s1(&app);
    assert_eq!(card.assignee.as_deref(), Some("Sam"));
    assert_eq!(card.assigned_by.as_deref(), Some("Alex"));
    assert!(
        latest_status(&app).contains("is now in Sam's queue"),
        "{}",
        latest_status(&app)
    );
}

#[test]
fn news_and_confirmations_cannot_be_assigned() {
    let (app, _tab) = two_sided_app("Alex", false);
    let mut card = card_s1(&app);
    assert!(!app.board_card_assignable(&card), "a confirmation");
    card.kind = CardKind::Info;
    assert!(!app.board_card_assignable(&card), "news");
    card.kind = CardKind::Task;
    assert!(app.board_card_assignable(&card), "a task");
    card.resolved_at = Some(Utc::now());
    assert!(!app.board_card_assignable(&card), "a done task");
}

#[test]
fn the_dots_say_what_waits_and_what_is_unread() {
    let (mut app, _tab) = two_sided_app("Sam", true);
    let alex = yaran_core::human_board::Audience::Person("Alex");
    // The poster is blocked and nobody answered: red. Nothing from Alex yet.
    assert_eq!(app.board_queue_marks(&alex), (true, false));
    let text = screen(&mut app);
    assert!(text.contains("\u{25cf}"), "a dot on the tab strip: {text}");

    other_side_says(&mut app, "Alex", "Which table?", false);
    // Alex answered: the poster is no longer waiting on a person, and Sam has
    // something unread.
    assert_eq!(app.board_queue_marks(&alex), (false, true));
    let card = card_s1(&app);
    assert!(app.board_card_unread(&card));
    app.open_selected_board_card();
    assert!(!app.board_card_unread(&card), "opening the card reads it");
    assert_eq!(app.board_queue_marks(&alex), (false, false));

    // What Sam's own side writes is never unread for Sam.
    BoardStore::new(&app.engine.paths.root)
        .update(|board| {
            board.reply(
                CardId::new("S", 1),
                yaran_core::human_board::NewMessage {
                    from: "session-1".to_string(),
                    side: Some("Sam".to_string()),
                    text: "The audit_2019 table.".to_string(),
                    done: false,
                },
                Utc::now(),
            )
        })
        .unwrap();
    app.load_human_board_now();
    app.after_board_snapshot();
    assert_eq!(
        app.board_queue_marks(&alex),
        (true, false),
        "asked again: red, nothing unread"
    );
}

#[test]
fn a_reply_from_the_other_side_is_announced() {
    let (mut app, _tab) = two_sided_app("Sam", false);
    other_side_says(&mut app, "Alex", "Yes, but keep a backup.", true);
    let status = latest_status(&app);
    assert!(
        status.contains("Alex answered and marked done card #S-1 [db-9]")
            && status.contains("keep a backup"),
        "{status}"
    );
}

#[test]
fn a_reply_from_the_other_side_is_relayed_to_the_agent_that_asked() {
    use std::os::unix::fs::PermissionsExt;
    let (mut app, _tab) = two_sided_app("Sam", false);
    app.engine.config.board.relay = true;
    app.engine.config.board.relay_transport = "amq".to_string();
    let log = app.engine.paths.root.join("relayed.txt");
    let fake = app.engine.paths.root.join("fake-yaran");
    std::fs::write(
        &fake,
        format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > {}\n", log.display()),
    )
    .unwrap();
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
    app.human_board.talk.relay_exe = Some(fake);
    app.drain_human_board();

    other_side_says(&mut app, "Alex", "Yes, drop it.", false);
    app.drain_board_talk();
    app.finish_board_relay();
    let sent = std::fs::read_to_string(&log).expect("the relay ran");
    let args: Vec<&str> = sent.lines().collect();
    assert_eq!(
        &args[..7],
        [
            "peer",
            "send",
            "--transport",
            "amq",
            "--from",
            "alex",
            "session-1"
        ]
    );
    assert!(sent.contains("Alex answered on card #S-1 [db-9]"), "{sent}");
    assert!(sent.contains("yaran board reply S-1"), "{sent}");
    assert!(
        card_s1(&app).thread[0].relayed_at.is_some(),
        "the card shows it was passed"
    );
    assert!(
        latest_status(&app).contains("Passed Alex's reply on card S-1 to session-1"),
        "{}",
        latest_status(&app)
    );

    // Read back with its record, nothing is planned again.
    app.load_human_board_now();
    app.after_board_snapshot();
    app.drain_board_talk();
    assert!(app.human_board.talk_relay_idle(), "nothing is sent twice");
}

#[test]
fn with_relaying_off_send_forwards_the_other_sides_reply_by_hand() {
    let (mut app, tab) = two_sided_app("Sam", false);
    other_side_says(&mut app, "Alex", "Yes, drop it.", false);
    app.open_selected_board_card();
    // The card is Alex's; choose the agent that posted it as the recipient.
    app.handle_key(key(KeyCode::Tab)).unwrap();
    app.handle_key(key(KeyCode::Enter)).unwrap();
    let text = screen(&mut app);
    assert!(
        text.contains("Forward"),
        "an empty field offers to pass the reply on: {text}"
    );
    // From the recipient: Close, then Send.
    app.handle_key(key(KeyCode::Tab)).unwrap();
    app.handle_key(key(KeyCode::Tab)).unwrap();
    assert!(matches!(
        app.prompt,
        PromptState::HumanBoardCard {
            focus: super::HumanBoardCardFocus::Send,
            ..
        }
    ));
    app.handle_key(key(KeyCode::Enter)).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(200));
    assert!(
        terminal_text(&app, &tab).contains("Alex wrote: Yes, drop it."),
        "{}",
        terminal_text(&app, &tab)
    );
    app.submit_due_replies(
        std::time::Instant::now()
            + std::time::Duration::from_millis(yaran_core::macros::COMPOSE_SUBMIT_DELAY_MS),
    );
    app.finish_board_job();
    let card = card_s1(&app);
    assert!(card.thread[0].relayed_at.is_some());
    assert!(card.is_open(), "forwarding does not close the card");
}

#[test]
fn a_card_with_a_very_long_title_can_be_read_to_its_last_word() {
    let mut board = Board::default();
    let question = format!(
        "Retention table - one line from Alex please: {} THE-LAST-WORDS",
        "the draft policy says 30/14/7 days and the plan records the same resolution. ".repeat(60)
    );
    board
        .post(new_card(CardKind::Task, Some("6001"), &question), at(0))
        .unwrap();
    let mut app = board_app(Some(board));
    app.focus = FocusPane::Files;
    app.right_section = RightSection::Board;
    app.human_board.selected = Some(CardId::plain(1));
    app.open_selected_board_card();
    let text = screen(&mut app);
    assert!(
        text.contains("Retention table - one line from Alex please"),
        "a short headline leads the card: {text}"
    );
    assert!(
        text.contains("scroll"),
        "a long card says it scrolls: {text}"
    );
    for _ in 0..40 {
        if screen(&mut app).contains("THE-LAST-WORDS") {
            break;
        }
        app.handle_key(key(KeyCode::PageDown)).unwrap();
    }
    assert!(
        screen(&mut app).contains("THE-LAST-WORDS"),
        "the whole question is in the card"
    );
}

/// Screen rows of `text`, and the column where `needle` starts on the first
/// row holding it.
fn find_on_screen(text: &str, needle: &str) -> Option<(usize, usize)> {
    text.lines().enumerate().find_map(|(row, line)| {
        line.find(needle)
            .map(|byte| (row, line[..byte].chars().count()))
    })
}

#[test]
fn typing_a_long_reply_grows_the_field_downward_and_moves_nothing_else() {
    let (mut app, _tab) = two_sided_app("Alex", false);
    app.open_selected_board_card();
    let before = screen(&mut app);
    let top = find_on_screen(&before, "Card S-1").expect("the dialog title");
    let close = find_on_screen(&before, "Close").expect("Close");
    let mark_done = find_on_screen(&before, "Mark done").expect("Mark done");
    let reply_label = find_on_screen(&before, "Reply to").expect("the reply label");

    type_text(&mut app, &"word ".repeat(120));
    let after = screen(&mut app);
    assert_eq!(
        find_on_screen(&after, "Card S-1"),
        Some(top),
        "the dialog's top edge stays where it was"
    );
    assert_eq!(find_on_screen(&after, "Reply to"), Some(reply_label));
    let close_after = find_on_screen(&after, "Close").unwrap();
    assert_eq!(close_after.1, close.1, "Close keeps its column");
    let action_after = find_on_screen(&after, "Send & mark done").unwrap();
    assert!(
        close_after.0 > close.0,
        "the buttons moved down, the field grew"
    );
    assert_eq!(close_after.0, action_after.0);
    // The action's label changed width, but its button did not move: the
    // label is centred in the same box, so its start shifts by at most the
    // difference in label length, never by a whole button.
    assert!(action_after.1.abs_diff(mark_done.1) <= "Send & ".len());
    // Five rows of reply at most.
    let field_rows = after
        .lines()
        .filter(|line| line.contains("word word word"))
        .count();
    assert_eq!(
        field_rows,
        super::super::human_board_dialog::REPLY_MAX_ROWS as usize
    );
}

#[test]
fn every_element_of_the_card_dialog_shares_one_left_edge() {
    let (mut app, _tab) = two_sided_app("Alex", false);
    app.open_selected_board_card();
    let text = screen(&mut app);
    // Only the dialog: the board's own row shows the same title elsewhere.
    let top = find_on_screen(&text, "Card S-1").unwrap().0;
    let dialog: String = text.lines().skip(top + 1).collect::<Vec<_>>().join("\n");
    let title = find_on_screen(&dialog, "Drop the old audit table?")
        .unwrap()
        .1;
    let kind = find_on_screen(&dialog, "Kind:").unwrap().1;
    let reply = find_on_screen(&text, "Reply to").unwrap().1;
    let lines: Vec<&str> = text.lines().collect();
    let field_row = find_on_screen(&text, "Reply to").unwrap().0 + 1;
    let field_left = lines[field_row]
        .chars()
        .position(|c| c == '\u{256d}')
        .expect("the field's top-left corner");
    let close_row = find_on_screen(&text, "Close").unwrap().0;
    let button_left = lines[close_row - 1]
        .chars()
        .position(|c| c == '\u{256d}')
        .expect("the first button's top-left corner");
    assert_eq!(title, kind, "the title and the fields start together");
    assert_eq!(kind, reply, "and the reply label");
    assert_eq!(field_left, reply, "and the reply field");
    assert_eq!(button_left, reply, "and the buttons");
}

#[test]
fn a_drag_over_the_card_text_selects_it_and_copies_it() {
    let (mut app, _tab) = two_sided_app("Alex", false);
    app.open_selected_board_card();
    screen(&mut app);
    let body = app.human_board.card_view.body;
    let at = |column: u16, row: u16, kind| MouseEvent {
        kind,
        column,
        row,
        modifiers: KeyModifiers::NONE,
    };
    // From the title's first cell to the fifth cell of its first row.
    app.handle_mouse(at(body.x, body.y, MouseEventKind::Down(MouseButton::Left)));
    app.handle_mouse(at(
        body.x + 4,
        body.y,
        MouseEventKind::Drag(MouseButton::Left),
    ));
    let selection = app.human_board.card_view.selection.clone().unwrap();
    assert!(selection.dragging);
    let text = super::super::human_board_dialog::selected_card_text(
        &app.human_board.card_view.rows,
        &app.human_board.card_view.continues,
        &selection,
    );
    assert_eq!(text, "Drop", "trailing blanks are not copied");
    app.handle_mouse(at(
        body.x + 4,
        body.y,
        MouseEventKind::Up(MouseButton::Left),
    ));
    assert!(
        app.human_board
            .card_view
            .selection
            .as_ref()
            .is_some_and(|s| !s.dragging),
        "the selection stays highlighted after the copy"
    );
    // A press on a control drops it.
    app.handle_mouse(at(0, 0, MouseEventKind::Down(MouseButton::Left)));
    assert!(app.human_board.card_view.selection.is_none());
}

#[test]
fn a_copy_joins_soft_wrapped_rows_with_a_space_and_keeps_real_breaks() {
    use super::super::human_board_dialog::selected_card_text;
    let rows = vec![
        "The first line wraps".to_string(),
        "onto this row.".to_string(),
        "A second line.".to_string(),
    ];
    let continues = vec![false, true, false];
    let all = TerminalSelection {
        anchor: TermGridPos { row: 0, col: 0 },
        end: TermGridPos { row: 2, col: 40 },
        dragging: false,
        origin: Default::default(),
    };
    assert_eq!(
        selected_card_text(&rows, &continues, &all),
        "The first line wraps onto this row.\nA second line."
    );
}

#[test]
fn news_closes_by_itself_after_the_configured_hours() {
    let mut app = board_app(Some({
        let mut board = Board::default();
        board
            .post(
                new_card(CardKind::Info, None, "Deployed"),
                Utc::now() - chrono::Duration::hours(5),
            )
            .unwrap();
        board
            .post(
                new_card(CardKind::Info, None, "Rolled"),
                Utc::now() - chrono::Duration::hours(1),
            )
            .unwrap();
        board
            .post(
                new_card(CardKind::Task, None, "Decide"),
                Utc::now() - chrono::Duration::hours(9),
            )
            .unwrap();
        board
    }));
    app.engine.config.board.news_close_hours = 4;
    app.drain_human_board();
    app.finish_board_job();
    let board = BoardStore::new(&app.engine.paths.root).load().unwrap();
    assert!(
        !board.card(1).unwrap().is_open(),
        "five-hour-old news closed"
    );
    assert_eq!(board.card(1).unwrap().resolved_by.as_deref(), Some("board"));
    assert!(board.card(2).unwrap().is_open(), "fresh news stays");
    assert!(
        board.card(3).unwrap().is_open(),
        "a task never closes by itself"
    );
}

#[test]
fn a_card_in_someone_elses_queue_asks_them_first() {
    // Sam's own agent posted the card for Alex; Sam opens it on Sam's board.
    let (mut app, _tab) = two_sided_app("Sam", false);
    app.open_selected_board_card();
    let PromptState::HumanBoardCard {
        reply: Some(reply), ..
    } = &app.prompt
    else {
        panic!("{:?}", app.prompt);
    };
    assert_eq!(
        reply.recipient(),
        &super::Recipient::Person {
            name: "Alex".to_string(),
            poster: None,
        },
        "the card is Alex's to answer"
    );
    assert!(
        matches!(&reply.recipients[1], super::Recipient::Agent(target) if target.is_poster),
        "answering the agent for Alex is the second choice"
    );
    assert_eq!(reply.recipients.len(), 2, "Alex is offered once");
    assert!(
        !reply.enter_marks_done(),
        "asking a person goes on with the card"
    );
}
