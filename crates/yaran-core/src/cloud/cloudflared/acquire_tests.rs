//! Tests for the managed and user cloudflared acquisition paths, against a loopback stub.
//!
//! - Test-only; downloads only from 127.0.0.1.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/cloudflared/acquire_tests.rs
//! ├── cloud::cloudflared::acquire
//! ├── cloud::cloudflared::pins
//! ├── cloud::cloudflared::targz
//! └── cloud::cloudflared::test_support
//! External: ring, tempfile
//!
//! Used by:
//! cloud/cloudflared/acquire_tests.rs
//! └── cloud::cloudflared::acquire
//! <module-headers:end>

use super::*;
use crate::cloud::cloudflared::pins::{AssetKind, Pin};
use crate::cloud::cloudflared::targz::test_support::tgz;
use crate::cloud::cloudflared::test_support::{Reply, http_stub, script};

fn sha(bytes: &[u8]) -> &'static str {
    Box::leak(hex(ring::digest::digest(&ring::digest::SHA256, bytes).as_ref()).into_boxed_str())
}

fn pin(kind: AssetKind, asset: &[u8], binary: &[u8]) -> Pin {
    Pin {
        target: "test",
        asset: if kind == AssetKind::Tgz {
            "cf.tgz"
        } else {
            "cf"
        },
        kind,
        asset_sha256: sha(asset),
        binary_sha256: sha(binary),
    }
}

fn source(base: &str) -> ManagedSource {
    ManagedSource {
        base_url: base.to_string(),
        request_timeout: Duration::from_secs(5),
    }
}

fn bin_files(dir: &Path) -> Vec<String> {
    let mut names: Vec<_> = fs::read_dir(dir.join("bin"))
        .map(|it| {
            it.flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

fn fetch(dir: &Path, pin: &Pin, base: &str) -> Result<PathBuf, BinaryUnavailable> {
    managed_binary(dir, pin, "2026.11.0", &source(base), &mut |_| true)
}

#[test]
fn a_good_raw_download_is_stored_owner_only_and_reused() {
    let body = b"#!/bin/sh\necho ok\n".to_vec();
    let (base, _, hits) = http_stub(Reply::ok(body.clone()));
    let dir = tempfile::tempdir().unwrap();
    let pin = pin(AssetKind::Raw, &body, &body);
    let path = fetch(dir.path(), &pin, &base).expect("downloaded");
    assert_eq!(fs::read(&path).unwrap(), body);
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(bin_files(dir.path()), vec!["cloudflared-2026.11.0"]);
    fetch(dir.path(), &pin, &base).expect("reused");
    assert_eq!(
        *hits.lock().unwrap(),
        1,
        "a verified binary is not downloaded again"
    );
}

#[test]
fn a_tgz_is_verified_twice_and_extracted() {
    let binary = b"\x7fELF fake".to_vec();
    let archive = tgz(&[("cloudflared", b'0', &binary)]);
    let (base, _, _) = http_stub(Reply::ok(archive.clone()));
    let dir = tempfile::tempdir().unwrap();
    let path = fetch(dir.path(), &pin(AssetKind::Tgz, &archive, &binary), &base).unwrap();
    assert_eq!(fs::read(path).unwrap(), binary);
    assert_eq!(bin_files(dir.path()), vec!["cloudflared-2026.11.0"]);
}

#[test]
fn every_bad_download_fails_closed_and_leaves_no_file() {
    let good = b"the real binary".to_vec();
    let dir = tempfile::tempdir().unwrap();
    let pin = pin(AssetKind::Raw, &good, &good);
    let cases = [
        Reply::ok(b"tampered".to_vec()),
        Reply {
            status: 200,
            body: good[..4].to_vec(),
            claimed_len: Some(good.len()),
        },
        Reply {
            status: 200,
            body: Vec::new(),
            claimed_len: Some(MAX_ASSET_BYTES as usize + 1),
        },
        Reply {
            status: 404,
            body: Vec::new(),
            claimed_len: None,
        },
    ];
    for reply in cases {
        let (base, _, _) = http_stub(reply);
        assert!(fetch(dir.path(), &pin, &base).is_err());
        assert!(
            bin_files(dir.path()).is_empty(),
            "{:?}",
            bin_files(dir.path())
        );
    }
}

#[test]
fn a_tampered_managed_binary_is_downloaded_again() {
    let body = b"genuine".to_vec();
    let (base, _, hits) = http_stub(Reply::ok(body.clone()));
    let dir = tempfile::tempdir().unwrap();
    let pin = pin(AssetKind::Raw, &body, &body);
    let path = fetch(dir.path(), &pin, &base).unwrap();
    fs::write(&path, b"evil").unwrap();
    let again = fetch(dir.path(), &pin, &base).unwrap();
    assert_eq!(fs::read(again).unwrap(), body);
    assert_eq!(*hits.lock().unwrap(), 2);
}

#[test]
fn older_versions_are_removed_after_a_new_one_lands() {
    let body = b"new".to_vec();
    let (base, _, _) = http_stub(Reply::ok(body.clone()));
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("bin")).unwrap();
    fs::write(dir.path().join("bin/cloudflared-2025.4.0"), b"old").unwrap();
    fetch(dir.path(), &pin(AssetKind::Raw, &body, &body), &base).unwrap();
    assert_eq!(bin_files(dir.path()), vec!["cloudflared-2026.11.0"]);
}

#[test]
fn an_unpinned_row_is_refused_without_a_download() {
    let (base, _, hits) = http_stub(Reply::ok(b"x".to_vec()));
    let dir = tempfile::tempdir().unwrap();
    let mut unpinned = pin(AssetKind::Raw, b"x", b"x");
    unpinned.asset_sha256 = UNPINNED;
    assert!(matches!(
        fetch(dir.path(), &unpinned, &base),
        Err(BinaryUnavailable::NotPinned { .. })
    ));
    assert_eq!(*hits.lock().unwrap(), 0);
}

#[test]
fn a_cancelled_download_leaves_nothing() {
    let body = vec![1u8; 200_000];
    let (base, _, _) = http_stub(Reply::ok(body.clone()));
    let dir = tempfile::tempdir().unwrap();
    let pin = pin(AssetKind::Raw, &body, &body);
    let result = managed_binary(dir.path(), &pin, "2026.11.0", &source(&base), &mut |_| {
        false
    });
    assert_eq!(result, Err(BinaryUnavailable::Cancelled));
    assert!(bin_files(dir.path()).is_empty());
}

#[test]
fn the_user_path_is_held_to_the_floor() {
    let dir = tempfile::tempdir().unwrap();
    let old = script(dir.path(), "cf-old", "echo 'cloudflared version 2026.10.1'");
    let err = user_binary(old.to_str().unwrap()).unwrap_err();
    assert!(matches!(err, BinaryUnavailable::TooOld { .. }));
    assert!(err.to_string().contains("2026.11.0"), "{err}");
    let new = script(dir.path(), "cf-new", "echo 'cloudflared version 2026.11.0'");
    assert!(user_binary(new.to_str().unwrap()).is_ok());
    assert!(matches!(
        user_binary("/nonexistent/cloudflared"),
        Err(BinaryUnavailable::Missing { .. })
    ));
}
