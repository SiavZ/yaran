//! The app URIs yaran builds (Design §10) and the handoff redirect allowlist (§8).
//!
//! `add_org_uri` is the QR payload the CLI, TUI and web show after pairing (Phase 09);
//! `redirect_allowed` is the one rule `/__yaran/handoff` (Phase 11) and the Worker share:
//! a release request may only name a configured https callback, byte for byte, and the
//! custom scheme is accepted only with `build=dev`.
//!
//! - Pure. The parsers live with the app (TS `src/uri.ts`); yaran only builds.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/protocol/uri.rs
//! ├── cloud::protocol::handoff
//! ├── cloud::protocol::rules
//! └── cloud::protocol::test_fixtures
//! External: percent_encoding
//!
//! Used by:
//! cloud/protocol/uri.rs
//! └── cloud::protocol
//! <module-headers:end>

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};

use super::handoff::HandoffBuild;
use super::rules;

/// The only callback a `build=dev` handoff may name.
pub const DEV_HANDOFF_REDIRECT: &str = "yaranapp://auth/callback";
pub const ADD_ORG_MAX_CHARS: usize = 512;

/// What JavaScript's `encodeURIComponent` leaves unescaped.
const URI_COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

/// The add-org QR payload, or `None` when `org_url` is not an `OrgUrl` or the URI would
/// exceed 512 characters.
pub fn add_org_uri(org_url: &str) -> Option<String> {
    if !rules::is_org_url(org_url) {
        return None;
    }
    let uri = format!(
        "yaranapp://add-org?u={}",
        utf8_percent_encode(org_url, URI_COMPONENT)
    );
    (uri.len() <= ADD_ORG_MAX_CHARS).then_some(uri)
}

/// True when `redirect` may receive a handoff for `build` (absent means release).
pub fn redirect_allowed(
    redirect: &str,
    build: Option<HandoffBuild>,
    configured: &[String],
) -> bool {
    match build {
        Some(HandoffBuild::Dev) => redirect == DEV_HANDOFF_REDIRECT,
        Some(HandoffBuild::Release) | None => {
            redirect.starts_with("https://") && configured.iter().any(|c| c == redirect)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::protocol::test_fixtures::fixture;

    #[test]
    fn add_org_uris_match_the_fixture() {
        let f = fixture("uri/add-org.json");
        for c in f["build"].as_array().unwrap() {
            let org = c["org_url"].as_str().unwrap();
            assert_eq!(add_org_uri(org).as_deref(), c["expect"].as_str(), "{org}");
        }
    }

    #[test]
    fn the_redirect_allowlist_matches_the_fixture() {
        let f = fixture("uri/handoff-redirect.json");
        let configured: Vec<String> = f["configured"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        for c in f["cases"].as_array().unwrap() {
            let build = match c["build"].as_str() {
                None => None,
                Some("release") => Some(HandoffBuild::Release),
                Some("dev") => Some(HandoffBuild::Dev),
                Some(other) => panic!("unknown build {other}"),
            };
            let redirect = c["redirect"].as_str().unwrap();
            assert_eq!(
                redirect_allowed(redirect, build, &configured),
                c["expect"].as_bool().unwrap(),
                "{redirect} {build:?}"
            );
        }
    }
}
