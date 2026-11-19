//! A CLI token presented as the session cookie, as the phone app's direct machines do.

use std::sync::Arc;

use axum::http::HeaderMap;
use yaran_core::config::ServerAuthConfig;
use yaran_core::web_sessions::SessionKind;

use super::{AuthSetup, AuthState, LiveAuth, RequestFacts};

/// A CLI token presented as the session cookie (the phone app's direct
/// machines) keeps the CLI's idle limit, not the browser's: the session's
/// kind decides, never how the token travelled.
#[tokio::test]
async fn a_cli_token_in_the_cookie_idles_by_the_cli_limit() {
    use std::sync::atomic::{AtomicI64, Ordering};
    let hash = yaran_core::auth::hash_password(&yaran_core::auth::Password::new(
        "orbit velvet quarry lantern cobalt".to_string(),
    ))
    .unwrap();
    let config = ServerAuthConfig {
        password_hash: hash,
        session_idle_seconds: 60,
        cli_token_idle_days: 2,
        ..ServerAuthConfig::default()
    };
    let now = Arc::new(AtomicI64::new(1_000_000));
    let reads = Arc::clone(&now);
    let state = AuthState::start_with_clock(
        AuthSetup {
            live: Arc::new(LiveAuth::new(&config)),
            exposure: None,
            bound_ips: Vec::new(),
            tailscale_leg: None,
            config_path: None,
            sessions_db: None,
            console: crate::console::Console::noop(),
            engine: None,
            reload: Arc::new(|| {}),
            opening_hook: None,
        },
        Arc::new(move || reads.load(Ordering::SeqCst)),
    );
    let generation = state.snapshot().generation.clone();
    let issue = |kind| state.sessions.issue(&generation, kind);
    let cli = issue(SessionKind::Cli).await.unwrap();
    let browser = issue(SessionKind::Browser).await.unwrap();
    let signed_in = |value: String| {
        let state = Arc::clone(&state);
        async move {
            let mut headers = HeaderMap::new();
            headers.insert(
                "cookie",
                format!("yaran_session_0={value}").parse().unwrap(),
            );
            let facts = RequestFacts::of(None, &headers);
            state.assess(facts, &headers).await.session.is_some()
        }
    };
    assert!(signed_in(cli.cookie_value.clone()).await);
    assert!(signed_in(browser.cookie_value.clone()).await);
    // A day unused: far past the browser's minute, inside the CLI's two days.
    now.fetch_add(86_400_000, Ordering::SeqCst);
    assert!(!signed_in(browser.cookie_value).await, "the browser idled");
    assert!(signed_in(cli.cookie_value.clone()).await, "the CLI did not");
    // Two days and a moment unused after that use: the CLI's limit ends it.
    now.fetch_add(2 * 86_400_000 + 1, Ordering::SeqCst);
    assert!(!signed_in(cli.cookie_value).await, "the CLI idled");
}
