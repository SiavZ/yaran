use super::super::test_support::{default_bindings, test_app};
use super::*;
use ratatui::crossterm::event::{KeyCode, KeyModifiers};

fn seed_running_jcodes(app: &mut App, root: &std::path::Path) {
    let mut second = app.engine.sessions[0].clone();
    second.id = "bulk-second".into();
    second.slot_tab_id = "bulk-second-tab".into();
    app.engine.sessions.push(second);
    for session in app.engine.sessions.iter_mut().take(2) {
        session.provider = yaran_core::model::ProviderKind::new("jcode");
        let client =
            yaran_core::pty::PtyClient::spawn_with_env("cat", &[], root, 24, 80, 1000, &[])
                .unwrap();
        app.engine.providers.insert(
            yaran_core::ids::TabId::new(session.slot_tab_id().as_str()),
            client,
        );
    }
}

#[test]
fn selection_supports_individual_and_all_jcodes_and_movement_changes_only_focus() {
    let mut app = test_app(default_bindings());
    let tmp = tempfile::tempdir().unwrap();
    seed_running_jcodes(&mut app, tmp.path());
    app.open_jcode_models();
    app.handle_jcode_models_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
    app.handle_jcode_models_key(KeyEvent::new(KeyCode::Char(' '), KeyModifiers::NONE));
    let PromptState::JcodeModels(prompt) = &app.prompt else {
        panic!("models form");
    };
    let count = prompt.targets.len();
    assert_eq!(count, 2);
    assert_eq!(prompt.selected.len(), count);
    app.handle_jcode_models_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    let PromptState::JcodeModels(prompt) = &app.prompt else {
        panic!("models form");
    };
    assert_eq!(
        prompt.selected.len(),
        count,
        "movement never toggles a target"
    );
    app.handle_jcode_models_key(KeyEvent::new(KeyCode::Char(' '), KeyModifiers::NONE));
    let PromptState::JcodeModels(prompt) = &app.prompt else {
        panic!("models form");
    };
    assert_eq!(prompt.selected.len(), count - 1);
}

#[test]
fn rendered_targets_and_cancel_are_clickable() {
    use ratatui::{
        Terminal,
        backend::TestBackend,
        crossterm::event::{MouseButton, MouseEvent, MouseEventKind},
    };
    let mut app = test_app(default_bindings());
    let tmp = tempfile::tempdir().unwrap();
    seed_running_jcodes(&mut app, tmp.path());
    app.open_jcode_models();
    let mut terminal = Terminal::new(TestBackend::new(80, 24)).unwrap();
    terminal.draw(|frame| app.render(frame)).unwrap();
    let OverlayMouseLayout::JcodeModels { list, cancel, .. } = app.overlay_layout.active else {
        panic!("models layout");
    };
    let click = |kind, area: ratatui::layout::Rect| MouseEvent {
        kind,
        column: area.x + 1,
        row: area.y,
        modifiers: KeyModifiers::NONE,
    };
    app.handle_prompt_mouse(click(MouseEventKind::Down(MouseButton::Left), list));
    let PromptState::JcodeModels(prompt) = &app.prompt else {
        panic!("models form");
    };
    assert_eq!(prompt.selected.len(), 1);
    app.handle_prompt_mouse(click(MouseEventKind::Down(MouseButton::Left), cancel));
    assert!(
        matches!(app.prompt, PromptState::JcodeModels(_)),
        "buttons act on release"
    );
    app.handle_prompt_mouse(click(MouseEventKind::Up(MouseButton::Left), cancel));
    assert!(matches!(app.prompt, PromptState::None));
}

#[test]
fn model_entry_and_escape_do_not_change_agents() {
    let mut app = test_app(default_bindings());
    app.execute_command("change-jcode-models").unwrap();
    app.handle_jcode_models_key(KeyEvent::new(KeyCode::Char('x'), KeyModifiers::NONE));
    let PromptState::JcodeModels(prompt) = &app.prompt else {
        panic!("models form");
    };
    assert_eq!(prompt.model.text, "x");
    app.handle_jcode_models_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    assert!(
        matches!(app.prompt, PromptState::JcodeModels(_)),
        "no targets means no work"
    );
    app.handle_jcode_models_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(matches!(app.prompt, PromptState::None));
}
