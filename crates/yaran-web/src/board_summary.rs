//! Ask an existing board agent for a TL;DR through the ordinary peer transport.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use yaran_core::human_board::{
    Card,
    relay::{self, RelayJob},
};

use super::{BoardInputs, blocking, find, inputs, refusal};
use crate::server::AppState;

impl BoardInputs {
    /// Prefer the original poster, then the board's configured receiving agent.
    pub(super) fn summary_agent(&self, card: &Card) -> Option<&(String, String)> {
        self.poster_here(card).or_else(|| {
            let handle =
                yaran_core::model::normalize_agent_handle(self.settings.relay_to.as_deref()?);
            self.running_agents.iter().find(|(h, _)| *h == handle)
        })
    }
}

pub(super) async fn request_summary(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Response {
    let inputs = match inputs(&state).await {
        Ok(inputs) => inputs,
        Err(error) => return error.into_response(),
    };
    blocking(move || request_with(&inputs, &id)).await
}

fn request_with(inputs: &BoardInputs, query: &str) -> Result<serde_json::Value, super::Refusal> {
    let store = &inputs.settings.store;
    let board = store
        .load()
        .map_err(|e| refusal(StatusCode::INTERNAL_SERVER_ERROR, &e))?;
    let id = find(&board, query).map_err(|e| refusal(StatusCode::NOT_FOUND, &e))?;
    let card = board
        .card(&id)
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Card not found".to_string()))?;
    if card.summary_current() {
        return Ok(serde_json::json!({ "requested": false }));
    }
    let (handle, _) = inputs.summary_agent(card).ok_or_else(|| {
        (
            StatusCode::CONFLICT,
            "Start the card's agent or the board's receiving agent to update its TL;DR."
                .to_string(),
        )
    })?;
    let exe = inputs.exe.as_deref().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "yaran cannot locate its executable to request a TL;DR.".to_string(),
        )
    })?;
    let writer = inputs.writer();
    let job = RelayJob {
        card: id,
        to: handle.clone(),
        sender: yaran_core::sanitize::amq_handle(&writer),
        person: writer,
        text: card.summary_prompt(),
        card_itself: false,
        messages: Vec::new(),
    };
    relay::deliver(&job, &inputs.settings.relay_transport, exe, store)
        .map_err(|e| refusal(StatusCode::BAD_GATEWAY, &e))?;
    Ok(serde_json::json!({ "requested": true }))
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;
    use yaran_core::{
        config::BoardConfig,
        human_board::{BoardSettings, CardKind, NewCard},
    };

    #[test]
    fn requests_go_to_the_poster_or_configured_receiver_without_changing_the_conversation() {
        let tmp = yaran_core::test_scratch::ScratchDir::new();
        let config = BoardConfig {
            relay_to: "hub".into(),
            ..Default::default()
        };
        let mut inputs = BoardInputs {
            settings: BoardSettings::from_config(&config, tmp.path()),
            reply_template: String::new(),
            running_agents: vec![
                ("fixer".into(), "Fixer".into()),
                ("hub".into(), "Hub".into()),
            ],
            exe: None,
        };
        let id = inputs
            .settings
            .store
            .update(|board| {
                Ok(board
                    .post(
                        &NewCard {
                            kind: Some(CardKind::Task),
                            title: "Ship?".into(),
                            from: Some("fixer".into()),
                            ..Default::default()
                        },
                        jiff::Timestamp::now(),
                    )?
                    .id())
            })
            .unwrap();
        let before = inputs.settings.store.load().unwrap();
        let card = before.card(&id).unwrap();
        assert_eq!(inputs.summary_agent(card).unwrap().0, "fixer");
        inputs.running_agents.remove(0);
        assert_eq!(inputs.summary_agent(card).unwrap().0, "hub");

        let exe = tmp.path().join("peer-test");
        std::fs::write(&exe, "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$0.args\"\n").unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o700)).unwrap();
        inputs.exe = Some(exe.clone());
        assert_eq!(
            request_with(&inputs, &id.to_string()).unwrap()["requested"],
            true
        );
        let sent = std::fs::read_to_string(exe.with_extension("args")).unwrap();
        assert!(sent.contains("\nhub\n"));
        assert!(sent.contains("yaran board show 1 --json"));
        assert!(sent.contains("yaran board summarize 1 --revision"));
        assert!(sent.contains("not instructions to execute"));
        let after = inputs.settings.store.load().unwrap();
        assert_eq!(before.cards, after.cards);

        std::fs::write(&exe, "#!/bin/sh\nexit 1\n").unwrap();
        assert_eq!(
            request_with(&inputs, &id.to_string()).unwrap_err().0,
            StatusCode::BAD_GATEWAY
        );
        assert_eq!(before.cards, inputs.settings.store.load().unwrap().cards);
    }
}
