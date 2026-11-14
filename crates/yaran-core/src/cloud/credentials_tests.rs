//! Tests for the credentials store (round trip, modes, refusals, D24 consent key).
//!
//! <module-headers:begin>
//! Uses:
//! cloud/credentials_tests.rs
//! ├── cloud::credentials
//! └── cloud::test_support
//! External: serde_json, std, tempfile
//!
//! Used by:
//! cloud/credentials_tests.rs
//! └── cloud::credentials
//! <module-headers:end>

use super::*;
use crate::cloud::test_support::{SAMPLE_ORG, pair_sample, sample_credentials};
use std::os::unix::fs::PermissionsExt;

fn paths() -> (tempfile::TempDir, CloudPaths) {
    let root = tempfile::tempdir().unwrap();
    let paths = CloudPaths::from_root(root.path());
    (root, paths)
}

fn mode(p: &std::path::Path) -> u32 {
    fs::metadata(p).unwrap().permissions().mode() & 0o777
}

#[test]
fn a_record_round_trips_owner_only_in_an_owner_only_dir() {
    let (_root, paths) = paths();
    assert_eq!(read(&paths).unwrap(), None);
    let creds = pair_sample(&paths, SAMPLE_ORG);
    assert_eq!(read(&paths).unwrap(), Some(creds.clone()));
    assert_eq!(mode(&paths.credentials), 0o600);
    assert_eq!(mode(&paths.dir), 0o700);
    assert_eq!(creds.owner_email, "sam@example.com");
    assert_eq!(creds.origin_port, 3890);
    assert_eq!(creds.token_version, 1);
}

#[test]
fn a_symlink_is_refused() {
    let (root, paths) = paths();
    paths.ensure_dir().unwrap();
    let real = root.path().join("elsewhere.json");
    fs::write(&real, "{}").unwrap();
    std::os::unix::fs::symlink(&real, &paths.credentials).unwrap();
    assert_eq!(read(&paths), Err(CredentialsError::Symlink));
}

#[test]
fn a_future_schema_is_refused_without_a_write() {
    let (_root, paths) = paths();
    paths.ensure_dir().unwrap();
    let body = br#"{"schema": 2, "anything": true}"#;
    fs::write(&paths.credentials, body).unwrap();
    let err = read(&paths).unwrap_err();
    assert_eq!(err, CredentialsError::NewerSchema(2));
    assert!(err.to_string().contains("yaran cloud logout --local-only"));
    assert!(stamp_revoked(&paths).is_err());
    assert_eq!(fs::read(&paths.credentials).unwrap(), body);
}

#[test]
fn a_loose_file_is_tightened_on_read() {
    let (_root, paths) = paths();
    pair_sample(&paths, SAMPLE_ORG);
    fs::set_permissions(&paths.credentials, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(read(&paths).unwrap().is_some());
    assert_eq!(mode(&paths.credentials), 0o600);
}

#[test]
fn debug_output_redacts_every_secret() {
    let creds = sample_credentials(SAMPLE_ORG);
    let shown = format!("{creds:?}");
    for secret in [
        &creds.machine_key_pkcs8,
        &creds.tunnel_token,
        &creds.handoff_consent_key,
    ] {
        assert!(!shown.contains(secret.as_str()), "leaked into {shown}");
    }
    let key = creds.consent_key().unwrap();
    let shown = format!("{key:?}");
    assert!(shown.contains("redacted") && !shown.contains(&format!("{:?}", key.key)));
}

#[test]
fn the_revision_changes_on_rewrite() {
    let (_root, paths) = paths();
    assert_eq!(revision(&paths), None);
    pair_sample(&paths, SAMPLE_ORG);
    let first = revision(&paths).unwrap();
    rotate_consent_key(&paths).unwrap();
    assert_ne!(revision(&paths).unwrap(), first);
}

#[test]
fn concurrent_writers_serialize() {
    let (_root, paths) = paths();
    pair_sample(&paths, SAMPLE_ORG);
    let threads: Vec<_> = (0..8)
        .map(|_| {
            let paths = paths.clone();
            std::thread::spawn(move || {
                update(&paths, |c| {
                    let mut c = c.unwrap();
                    std::thread::sleep(std::time::Duration::from_millis(5));
                    c.token_version += 1;
                    Ok(Some(c))
                })
                .unwrap();
            })
        })
        .collect();
    for t in threads {
        t.join().unwrap();
    }
    assert_eq!(read(&paths).unwrap().unwrap().token_version, 9);
}

#[test]
fn revoked_at_is_stamped_once() {
    let (_root, paths) = paths();
    stamp_revoked(&paths).unwrap(); // unpaired: no-op, no file
    assert_eq!(read(&paths).unwrap(), None);
    pair_sample(&paths, SAMPLE_ORG);
    stamp_revoked(&paths).unwrap();
    let first = read(&paths).unwrap().unwrap().revoked_at.unwrap();
    stamp_revoked(&paths).unwrap();
    assert_eq!(read(&paths).unwrap().unwrap().revoked_at.unwrap(), first);
}

#[test]
fn the_consent_key_reader_returns_the_stored_key() {
    let (_root, paths) = paths();
    assert_eq!(read_handoff_consent_key(&paths).unwrap(), None);
    let creds = pair_sample(&paths, SAMPLE_ORG);
    let key = read_handoff_consent_key(&paths).unwrap().unwrap();
    assert_eq!(key, creds.consent_key().unwrap());
    assert_eq!(key.version, 1);
    let rotated = rotate_consent_key(&paths).unwrap().unwrap();
    let after = read_handoff_consent_key(&paths).unwrap().unwrap();
    assert_eq!(after.version, 2);
    assert_ne!(after.key, key.key);
    assert_eq!(rotated.tunnel_token, creds.tunnel_token);
    assert_eq!(rotated.token_version, creds.token_version);
}

#[test]
fn a_missing_or_bad_consent_field_is_unreadable() {
    let (_root, paths) = paths();
    paths.ensure_dir().unwrap();
    let good = serde_json::to_value(sample_credentials(SAMPLE_ORG)).unwrap();
    let cases: Vec<(&str, serde_json::Value)> = vec![
        ("handoff_consent_key", serde_json::Value::Null),
        ("handoff_consent_key_version", serde_json::Value::Null),
        ("handoff_consent_key", serde_json::json!("c2hvcnQ")),
        ("handoff_consent_key_version", serde_json::json!(0)),
    ];
    for (field, value) in cases {
        let mut v = good.clone();
        if value.is_null() {
            v.as_object_mut().unwrap().remove(field);
        } else {
            v[field] = value;
        }
        fs::write(&paths.credentials, v.to_string()).unwrap();
        assert!(
            matches!(read(&paths), Err(CredentialsError::Malformed(_))),
            "{field}"
        );
        assert!(read_handoff_consent_key(&paths).is_err(), "{field}");
    }
}

#[test]
fn a_claim_mints_the_consent_version_above_the_previous() {
    let prev = sample_credentials(SAMPLE_ORG);
    assert_eq!(HandoffConsentKey::for_claim(None).unwrap().version, 1);
    let next = HandoffConsentKey::for_claim(Some(&prev)).unwrap();
    assert_eq!(next.version, prev.handoff_consent_key_version + 1);
    assert_ne!(next.key, prev.consent_key().unwrap().key);
}

#[test]
fn delete_forgets_even_an_unreadable_file() {
    let (_root, paths) = paths();
    paths.ensure_dir().unwrap();
    fs::write(&paths.credentials, "not json").unwrap();
    delete(&paths).unwrap();
    assert_eq!(read(&paths).unwrap(), None);
}
