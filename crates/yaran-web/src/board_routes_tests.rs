//! Tests for the human board routes.

use axum::body::Body;
use axum::http::Request;
use tower::ServiceExt;
use yaran_core::human_board::{BoardStore, CardKind, NewCard};

use super::*;

fn post_card(root: &std::path::Path, title: &str) -> CardId {
    BoardStore::new(root)
        .update(|board| {
            let card = NewCard {
                kind: Some(CardKind::Confirm),
                title: title.to_string(),
                from: Some("someone-elsewhere".to_string()),
                ..NewCard::default()
            };
            Ok(board.post(&card, Timestamp::now())?.id())
        })
        .unwrap()
}

fn request(method: &str, uri: &str, body: &str) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

async fn json(app: &Router, req: Request<Body>) -> (StatusCode, serde_json::Value) {
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
    )
}

#[test]
fn a_reply_goes_to_the_poster_only_when_it_runs_here_and_posted_here() {
    let tmp = yaran_core::test_scratch::ScratchDir::new();
    let config = yaran_core::config::BoardConfig {
        me: "Sam".to_string(),
        ..Default::default()
    };
    let inputs = BoardInputs {
        settings: BoardSettings::from_config(&config, tmp.path()),
        reply_template: String::new(),
        running_agents: vec![("fixer".to_string(), "Fixer".to_string())],
        exe: None,
    };
    let id = post_card(tmp.path(), "Roll it?");
    let mut card = BoardStore::new(tmp.path())
        .load()
        .unwrap()
        .card(&id)
        .unwrap()
        .clone();
    assert!(inputs.poster_here(&card).is_none(), "not a running agent");
    card.from = Some("fixer".to_string());
    assert_eq!(
        inputs.poster_here(&card).map(|(_, l)| l.as_str()),
        Some("Fixer")
    );
    card.origin = Some("Alex".to_string());
    assert!(
        inputs.poster_here(&card).is_none(),
        "a same-named agent on Alex's machine is somebody else"
    );
}

#[tokio::test]
async fn an_empty_board_reads_as_no_cards() {
    let (_tmp, app) = crate::test_support::router_no_auth();
    let (status, body) = json(&app, request("GET", "/api/v1/board", "")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["cards"], serde_json::json!([]));
    assert_eq!(body["people"], serde_json::json!([]));
}

#[tokio::test]
async fn a_card_is_marked_done_reopened_and_replied_to() {
    let (tmp, app) = crate::test_support::router_no_auth();
    let id = post_card(tmp.path(), "Merge the auth fix?");

    let (status, body) = json(&app, request("GET", "/api/v1/board", "")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["cards"][0]["title"], "Merge the auth fix?");
    assert_eq!(body["cards"][0]["label"], format!("#{id}"));
    assert_eq!(body["cards"][0]["reply_agent"], serde_json::Value::Null);

    let resolve = format!("/api/v1/board/cards/{id}/resolve");
    let (status, body) = json(&app, request("POST", &resolve, "")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["changed"], true);
    let (_, body) = json(&app, request("POST", &resolve, "")).await;
    assert_eq!(body["changed"], false, "a done card stays done");
    let board = BoardStore::new(tmp.path()).load().unwrap();
    assert!(!board.card(&id).unwrap().is_open());

    let reopen = format!("/api/v1/board/cards/{id}/reopen");
    let (status, _) = json(&app, request("POST", &reopen, "")).await;
    assert_eq!(status, StatusCode::OK);

    let reply = format!("/api/v1/board/cards/{id}/reply");
    let (status, body) = json(
        &app,
        request("POST", &reply, r#"{"text":"yes, merge it","done":true}"#),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["sent_to"], serde_json::Value::Null);
    let board = BoardStore::new(tmp.path()).load().unwrap();
    let card = board.card(&id).unwrap();
    assert!(!card.is_open(), "the reply marked it done");
    assert_eq!(card.thread.len(), 1);
    assert_eq!(card.thread[0].text, "yes, merge it");
    assert_eq!(card.thread[0].from, "human");
}

#[tokio::test]
async fn a_task_is_handed_to_a_queue_and_its_priority_changed() {
    let (tmp, app) = crate::test_support::router_no_auth();
    std::fs::write(
        tmp.path().join("config.toml"),
        "[board]\npeople = [\"Sam\", \"Alex\"]\nme = \"Sam\"\n",
    )
    .unwrap();
    let (status, _) = json(&app, request("POST", "/api/v1/config/reload", "{}")).await;
    assert_eq!(status, StatusCode::OK);
    let task = BoardStore::new(tmp.path())
        .update(|board| {
            let card = NewCard {
                kind: Some(CardKind::Task),
                title: "Approve the payout terms".to_string(),
                ..NewCard::default()
            };
            Ok(board.post(&card, Timestamp::now())?.id())
        })
        .unwrap();
    let news = post_card(tmp.path(), "Merged");

    let assign = format!("/api/v1/board/cards/{task}/assign");
    let (status, body) = json(&app, request("POST", &assign, r#"{"person":"alex"}"#)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let board = BoardStore::new(tmp.path()).load().unwrap();
    let card = board.card(&task).unwrap();
    assert_eq!(
        card.assignee.as_deref(),
        Some("Alex"),
        "the configured spelling"
    );
    assert_eq!(card.assigned_by.as_deref(), Some("Sam"));

    let (status, _) = json(&app, request("POST", &assign, r#"{"person":"Robin"}"#)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "not on the board");
    let other = format!("/api/v1/board/cards/{news}/assign");
    let (status, _) = json(&app, request("POST", &other, r#"{"person":"Alex"}"#)).await;
    assert_eq!(status, StatusCode::CONFLICT, "only tasks are handed over");

    let priority = format!("/api/v1/board/cards/{task}/priority");
    let (status, _) = json(&app, request("POST", &priority, r#"{"priority":"high"}"#)).await;
    assert_eq!(status, StatusCode::OK);
    let board = BoardStore::new(tmp.path()).load().unwrap();
    assert_eq!(board.card(&task).unwrap().priority, Priority::High);
    let (status, _) = json(&app, request("POST", &priority, r#"{"priority":"meh"}"#)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn an_unknown_card_or_an_empty_reply_is_refused() {
    let (_tmp, app) = crate::test_support::router_no_auth();
    let (status, _) = json(&app, request("POST", "/api/v1/board/cards/42/resolve", "")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = json(
        &app,
        request("POST", "/api/v1/board/cards/42/reply", r#"{"text":"  "}"#),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}
