//! Failures after a claim succeeds must report cleanup and Replace effects truthfully.
//!
//! Exercises supersession and failed persistence through the real login and mock Worker.
//! - Test-only child of the cloud_login integration suite.
//!
//! <module-headers:begin>
//! Uses:
//! tests/cloud_login/after_claim.rs
//! └── crate
//! External: serde_json, std
//!
//! Used by:
//! tests/cloud_login/after_claim.rs
//! └── crate
//! <module-headers:end>

use super::*;
use std::os::unix::fs::PermissionsExt;

#[test]
fn a_pairing_made_while_the_claim_runs_is_kept() {
    let (_root, paths) = setup();
    let mut newer = sample_credentials(SAMPLE_ORG);
    newer.machine_id = "22afdb39-9d90-49a8-9ef5-b9482c1bdf61".into();
    let (other, kept) = (paths.clone(), newer.clone());
    let w = claim_side_effect(move || {
        credentials::update(&other, |_| Ok(Some(kept.clone()))).unwrap();
    });
    let mut io = FakeIo::new(Browser::Loopback);
    let out = login(&w, &paths, &mut io, Duration::from_secs(10));
    assert_eq!(
        out,
        CloudActionOutcome::LoginSuperseded {
            cleanup_started: true
        }
    );
    let said = out.report().message().to_string();
    assert!(said.contains("Replace"), "{said}");
    assert!(!said.contains("nothing was changed"), "{said}");
    assert!(said.contains("control plane is removing"), "{said}");
    assert!(out.is_failure());
    assert_eq!(credentials::read(&paths).unwrap(), Some(newer));
    assert_claim_unpair_requested(&w, &io);
}

#[test]
fn a_superseded_login_reports_when_claim_cleanup_fails() {
    let (_root, paths) = setup();
    let mut newer = sample_credentials(SAMPLE_ORG);
    newer.machine_id = "22afdb39-9d90-49a8-9ef5-b9482c1bdf61".into();
    let (other, kept) = (paths.clone(), newer.clone());
    let w = MockWorker::start(move |req| match req.path.as_str() {
        "/v1/meta" => MockResponse::json(200, meta(1)),
        "/v1/machine/claim" => {
            credentials::update(&other, |_| Ok(Some(kept.clone()))).unwrap();
            MockResponse::json(200, serde_json::to_value(sample_claim(SAMPLE_ORG)).unwrap())
        }
        "/v1/machine/unpair" => MockResponse::error(503, "unavailable", "Try again."),
        _ => MockResponse::error(404, "not_found", "nope"),
    });
    let mut io = FakeIo::new(Browser::Loopback);
    let out = login(&w, &paths, &mut io, Duration::from_secs(10));
    assert_eq!(
        out,
        CloudActionOutcome::LoginSuperseded {
            cleanup_started: false
        }
    );
    let said = out.report().message().to_string();
    assert!(!said.contains("removed again"), "{said}");
    assert!(said.contains("administrator"), "{said}");
    assert!(said.contains("Replace"), "{said}");
    assert!(out.is_failure() && out.sticky());
    assert_eq!(credentials::read(&paths).unwrap(), Some(newer));
    assert_claim_unpair_requested(&w, &io);
}

#[test]
fn a_claim_not_stored_reports_cleanup_and_possible_replacement() {
    for cleanup_status in [202, 503] {
        let (_root, paths) = setup();
        let previous = pair_previous(&paths);
        let dir = paths.dir.clone();
        let w = MockWorker::start(move |req| match req.path.as_str() {
            "/v1/meta" => MockResponse::json(200, meta(1)),
            "/v1/machine/claim" => {
                std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();
                MockResponse::json(200, serde_json::to_value(sample_claim(SAMPLE_ORG)).unwrap())
            }
            "/v1/machine/unpair" if cleanup_status == 202 => MockResponse::json(
                202,
                serde_json::json!({"machine_id": SAMPLE_MACHINE_ID, "state": "tearing_down"}),
            ),
            "/v1/machine/unpair" => MockResponse::error(503, "unavailable", "Try again."),
            _ => MockResponse::error(404, "not_found", "nope"),
        });
        let mut io = FakeIo::new(Browser::Loopback);
        let out = login(&w, &paths, &mut io, Duration::from_secs(10));
        std::fs::set_permissions(&paths.dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(matches!(
            &out,
            CloudActionOutcome::LoginNotStored { cleanup_started, .. }
                if *cleanup_started == (cleanup_status == 202)
        ));
        let said = out.report().message().to_string();
        assert!(said.contains("could not save"), "{said}");
        assert!(said.contains("Replace"), "{said}");
        if cleanup_status == 202 {
            assert!(said.contains("control plane is removing"), "{said}");
        } else {
            assert!(said.contains("administrator"), "{said}");
            assert!(out.sticky());
        }
        assert!(out.is_failure());
        assert_eq!(credentials::read(&paths).unwrap(), Some(previous));
        assert_claim_unpair_requested(&w, &io);
    }
}
