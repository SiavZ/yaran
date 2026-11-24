use super::super::OverlayMouseLayout;
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
fn arbitrary_model_text_cannot_be_applied_and_escape_does_not_change_agents() {
    let mut app = test_app(default_bindings());
    app.execute_command("change-jcode-models").unwrap();
    app.handle_jcode_models_key(KeyEvent::new(KeyCode::Char('x'), KeyModifiers::NONE));
    let PromptState::JcodeModels(prompt) = &app.prompt else {
        panic!("models form");
    };
    assert!(prompt.chosen().is_none());
    assert!(!prompt.can_apply());
    assert!(super::super::modal::prompt_text_inputs(&app.prompt).is_empty());
    app.handle_jcode_models_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(matches!(app.prompt, PromptState::None));
}

#[test]
fn native_model_provider_and_reasoning_choices_stay_together() {
    use super::super::jcode_models::{ModelsPicker, ModelsPickerKind};
    let mut app = test_app(default_bindings());
    let tmp = tempfile::tempdir().unwrap();
    seed_running_jcodes(&mut app, tmp.path());
    app.open_jcode_models();
    let PromptState::JcodeModels(prompt) = &mut app.prompt else {
        panic!("models form");
    };
    prompt.selected = prompt
        .targets
        .iter()
        .map(|target| target.tab_id.clone())
        .collect();
    let choice = |id, method, levels: &[&str]| {
        serde_json::from_value(serde_json::json!({
        "id": id, "name": "same model", "provider": "Native provider", "api_method": method, "detail": "native catalog", "available": true,
        "reasoning_effort": levels.last(), "reasoning_levels": levels.iter().map(|level| serde_json::json!({ "value": level, "label": format!("Native {level}") })).collect::<Vec<_>>(), "selection": {} })).unwrap()
    };
    prompt.choices = vec![
        choice("oauth", "openai-oauth", &["low", "high"]),
        choice("api", "openai-api-key", &["custom-low", "custom-max"]),
    ];
    prompt.picking = Some(ModelsPicker {
        kind: ModelsPickerKind::Model,
        filter: TextInput::new(),
        selected: 0,
    });
    for letter in "api-key".chars() {
        app.handle_jcode_models_key(KeyEvent::new(KeyCode::Char(letter), KeyModifiers::NONE));
    }
    app.handle_jcode_models_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    let PromptState::JcodeModels(prompt) = &app.prompt else {
        panic!("models form");
    };
    assert_eq!(prompt.chosen().unwrap().id, "api");
    assert_eq!(prompt.reasoning.as_deref(), Some("custom-max"));
    assert!(prompt.can_apply());
    app.press_jcode_models_focus(ModelsFocus::Reasoning);
    assert_eq!(
        super::super::modal::modal_spec(&app.prompt).unwrap().family,
        super::super::modal::ModalFamily::Picker
    );
    app.handle_jcode_models_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
    app.handle_jcode_models_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    let PromptState::JcodeModels(prompt) = &app.prompt else {
        panic!("models form");
    };
    assert_eq!(prompt.reasoning.as_deref(), Some("custom-low"));
    app.press_jcode_models_focus(ModelsFocus::Target(0));
    let PromptState::JcodeModels(prompt) = &app.prompt else {
        panic!("models form");
    };
    assert!(
        prompt.chosen().is_none(),
        "changing targets requires choosing from their common native catalog again"
    );
    assert!(!prompt.can_apply());
}

#[test]
fn unavailable_picker_rows_never_become_form_target_indices() {
    let mut app = test_app(default_bindings());
    let tmp = tempfile::tempdir().unwrap();
    seed_running_jcodes(&mut app, tmp.path());
    app.open_jcode_models();
    let PromptState::JcodeModels(prompt) = &mut app.prompt else {
        panic!("models form");
    };
    prompt.focus = ModelsFocus::Model;
    prompt.selected = prompt
        .targets
        .iter()
        .map(|target| target.tab_id.clone())
        .collect();
    prompt.choices = (0..3).map(|id| serde_json::from_value(serde_json::json!({
        "id": id.to_string(), "name": "Unavailable model", "provider": "Native", "api_method": "api", "available": false,
        "detail": "Unavailable", "reasoning_effort": null, "reasoning_levels": [], "selection": {}
    })).unwrap()).collect();
    prompt.picking = Some(ModelsPicker {
        kind: ModelsPickerKind::Model,
        filter: TextInput::new(),
        selected: 0,
    });
    app.press_jcode_models_focus(ModelsFocus::Target(2));
    app.handle_jcode_models_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    let PromptState::JcodeModels(prompt) = &app.prompt else {
        panic!("models form");
    };
    assert_eq!(prompt.focus, ModelsFocus::Model);
    assert!(prompt.picking.is_none());
    assert_eq!(prompt.selected.len(), 2);
    app.handle_jcode_models_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
}

#[test]
fn mouse_reaches_hidden_targets_and_results_keep_each_tab_failure_readable() {
    use ratatui::{
        Terminal,
        backend::TestBackend,
        crossterm::event::{MouseEvent, MouseEventKind},
    };
    let mut app = test_app(default_bindings());
    let tmp = tempfile::tempdir().unwrap();
    seed_running_jcodes(&mut app, tmp.path());
    app.open_jcode_models();
    let PromptState::JcodeModels(prompt) = &mut app.prompt else {
        panic!("models form");
    };
    let first = prompt.targets[0].clone();
    prompt.targets = (0..30)
        .map(|i| {
            let mut target = first.clone();
            target.tab_id = format!("tab-{i}");
            target
        })
        .collect();
    let mut terminal = Terminal::new(TestBackend::new(80, 24)).unwrap();
    terminal.draw(|frame| app.render(frame)).unwrap();
    let OverlayMouseLayout::JcodeModels { list, .. } = app.overlay_layout.active else {
        panic!("models layout");
    };
    let wheel = |kind| MouseEvent {
        kind,
        column: list.x + 1,
        row: list.y,
        modifiers: KeyModifiers::NONE,
    };
    for _ in 0..20 {
        app.handle_prompt_mouse(wheel(MouseEventKind::ScrollDown));
    }
    terminal.draw(|frame| app.render(frame)).unwrap();
    let OverlayMouseLayout::JcodeModels { offset, .. } = app.overlay_layout.active else {
        panic!("models layout");
    };
    assert!(offset > 0, "mouse-only users reach hidden rows");
    app.handle_prompt_mouse(wheel(MouseEventKind::Down(
        ratatui::crossterm::event::MouseButton::Left,
    )));
    let PromptState::JcodeModels(prompt) = &app.prompt else {
        panic!("models form");
    };
    assert!(prompt.selected.contains(&format!("tab-{offset}")));
    let outcomes = (0..30)
        .map(|i| ModelChange {
            tab_id: format!("tab-{i}"),
            label: "same agent".into(),
            error: Some(format!("failure-{i} {}", "details ".repeat(20))),
        })
        .collect();
    app.finish_jcode_models(Some(Ok(outcomes)));
    terminal.draw(|frame| app.render(frame)).unwrap();
    assert_eq!(
        super::super::modal::modal_spec(&app.prompt).unwrap().family,
        super::super::modal::ModalFamily::Report
    );
    app.handle_jcode_models_key(KeyEvent::new(KeyCode::PageDown, KeyModifiers::NONE));
    let PromptState::JcodeModels(prompt) = &app.prompt else {
        panic!("models report");
    };
    assert!(
        prompt.scroll.offset > 0,
        "report paging uses the shared scroll bindings"
    );
    for _ in 0..100 {
        app.handle_prompt_mouse(wheel(MouseEventKind::ScrollDown));
    }
    terminal.draw(|frame| app.render(frame)).unwrap();
    let buffer = terminal.backend().buffer();
    let text: String = buffer
        .content
        .iter()
        .map(ratatui::buffer::Cell::symbol)
        .collect();
    assert!(
        text.contains("tab-29: failure-29"),
        "the final failure and its tab id can be read"
    );
    app.handle_jcode_models_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(matches!(app.prompt, PromptState::None));
}

#[test]
fn catalog_and_worker_failures_are_visible_inside_a_short_terminal_dialog() {
    use ratatui::{Terminal, backend::TestBackend};
    let mut app = test_app(default_bindings());
    let tmp = tempfile::tempdir().unwrap();
    seed_running_jcodes(&mut app, tmp.path());
    app.open_jcode_models();
    let PromptState::JcodeModels(prompt) = &mut app.prompt else {
        panic!("models form");
    };
    prompt.selected.insert(prompt.targets[0].tab_id.clone());
    app.load_jcode_model_choices();
    super::super::test_support::finish_ui_jobs(&mut app);
    let mut terminal = Terminal::new(TestBackend::new(80, 24)).unwrap();
    terminal.draw(|frame| app.render(frame)).unwrap();
    let text: String = terminal
        .backend()
        .buffer()
        .content
        .iter()
        .map(ratatui::buffer::Cell::symbol)
        .collect();
    assert!(
        text.contains("Could not load model choices"),
        "catalog failure stays inside the dialog"
    );
    app.finish_jcode_models(None);
    terminal.draw(|frame| app.render(frame)).unwrap();
    let text: String = terminal
        .backend()
        .buffer()
        .content
        .iter()
        .map(ratatui::buffer::Cell::symbol)
        .collect();
    assert!(text.contains("The model worker stopped"));
}
