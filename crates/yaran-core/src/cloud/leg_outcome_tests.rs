//! Tests for the cloud-leg sentences: plain spelling, chips, tone and stickiness.
//!
//! - Test-only.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/leg_outcome_tests.rs
//! ├── cloud::cloudflared::acquire
//! └── cloud::leg_outcome
//! External: std
//!
//! Used by:
//! cloud/leg_outcome_tests.rs
//! └── cloud::leg_outcome
//! <module-headers:end>

use super::*;
use crate::cloud::cloudflared::acquire::BinaryUnavailable;
use std::time::Duration;

#[test]
fn every_mode_outcome_says_the_saved_value_and_chips_its_names() {
    let host = "laptop.example.com".to_string();
    let outcomes = [
        CloudModeOutcome::Starting {
            hostname: host.clone(),
        },
        CloudModeOutcome::AlreadyRunning {
            hostname: host.clone(),
        },
        CloudModeOutcome::Stopped,
        CloudModeOutcome::NotPaired,
        CloudModeOutcome::Revoked {
            hostname: host.clone(),
        },
        CloudModeOutcome::NotServing,
        CloudModeOutcome::TimedOut,
    ];
    for outcome in outcomes {
        let report = outcome.report(CloudMode::Auto);
        assert!(
            report
                .message
                .message()
                .starts_with("[cloud] mode is saved as \"auto\".")
                || matches!(outcome, CloudModeOutcome::Revoked { .. }),
            "{outcome:?}: {}",
            report.message.message()
        );
        if report.message.message().contains(&host) {
            let segments = report.message.segments().expect("names are chips");
            assert!(segments.iter().any(|s| format!("{s:?}").contains(&host)));
            assert!(report.message.message().contains(&format!("\"{host}\"")));
        }
    }
}

#[test]
fn not_paired_warns_and_sticks_only_under_yes() {
    let auto = CloudModeOutcome::NotPaired.report(CloudMode::Auto);
    assert!(!auto.warning && !auto.sticky);
    let yes = CloudModeOutcome::NotPaired.report(CloudMode::Yes);
    assert!(yes.warning && yes.sticky);
    assert!(yes.message.message().contains("\"yaran cloud login\""));
    let status = CloudModeOutcome::NotPaired.status(CloudMode::Yes);
    assert_eq!(status.key.as_deref(), Some(CLOUD_MODE_KEY));
    assert!(status.sticky);
}

#[test]
fn leg_events_map_to_keys_tones_and_stickiness() {
    let h = "laptop.example.com";
    let o = "me@example.com";
    let s = |event: CloudLegEvent, mode| leg_status(&event, h, o, mode);
    let ready = s(CloudLegEvent::Ready { connections: 4 }, CloudMode::Auto).unwrap();
    assert_eq!(ready.key.as_deref(), Some(CLOUD_LEG_KEY));
    assert_eq!(ready.tone, StatusTone::Info);
    assert!(ready.message.contains(h) && ready.message.contains(o));
    let busy = s(
        CloudLegEvent::Acquiring {
            pct: Some(42),
            total_mb: Some(41),
        },
        CloudMode::Auto,
    )
    .unwrap();
    assert_eq!(busy.key.as_deref(), Some(CLOUD_CLOUDFLARED_KEY));
    assert_eq!(busy.tone, StatusTone::Busy);
    assert_eq!(
        busy.message,
        "Downloading cloudflared 2026.11.0 (41 MB): 42%"
    );
    let first = CloudLegEvent::Restarting {
        attempt: 1,
        delay: Duration::from_secs(1),
        first: true,
        escalate: false,
    };
    assert_eq!(s(first, CloudMode::Auto).unwrap().tone, StatusTone::Warning);
    let quiet = CloudLegEvent::Restarting {
        attempt: 3,
        delay: Duration::from_secs(4),
        first: false,
        escalate: false,
    };
    assert!(s(quiet, CloudMode::Auto).is_none());
    let escalate = CloudLegEvent::Restarting {
        attempt: 5,
        delay: Duration::from_secs(16),
        first: false,
        escalate: true,
    };
    assert!(s(escalate, CloudMode::Auto).unwrap().sticky);
    assert!(s(CloudLegEvent::Stopped(LegStop::Requested), CloudMode::Yes).is_none());
    let revoked = s(
        CloudLegEvent::Stopped(LegStop::Revoked { hostname: h.into() }),
        CloudMode::Auto,
    )
    .unwrap();
    assert!(revoked.sticky && revoked.message.contains("revoked"));
    let missing = CloudLegEvent::Stopped(LegStop::BinaryUnavailable(
        BinaryUnavailable::UnsupportedTarget,
    ));
    assert!(!s(missing.clone(), CloudMode::Auto).unwrap().sticky);
    assert!(s(missing, CloudMode::Yes).unwrap().sticky);
    let mismatch = s(
        CloudLegEvent::Stopped(LegStop::OriginPortMismatch {
            paired: 3890,
            serving: 4000,
        }),
        CloudMode::Auto,
    )
    .unwrap();
    assert!(mismatch.message.contains("3890") && mismatch.message.contains("4000"));
    let heal = s(
        CloudLegEvent::Stopped(LegStop::HealFailed { hostname: h.into() }),
        CloudMode::Auto,
    )
    .unwrap();
    assert_eq!(heal.tone, StatusTone::Error);
}

#[test]
fn the_tls_disclosure_names_the_host() {
    assert_eq!(
        tls_disclosure("h.example.com"),
        "Cloudflare terminates TLS for h.example.com and can see this traffic."
    );
}
