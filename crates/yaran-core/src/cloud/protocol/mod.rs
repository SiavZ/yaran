//! The yaran cloud wire contract, machine side (`cloud/protocol` in the repo is the
//! source of truth: JSON Schemas, registries and shared fixtures).
//!
//! Types for every body yaran sends or receives, Ed25519 request signing, the sealed
//! handoff envelope, remembered consent, the UA token, URI builders and refusal signals,
//! all tested against the same fixtures as the TypeScript package. This file adds
//! protocol version negotiation (Design §3).
//!
//! - Pure apart from CSPRNG draws in `signing::sign_now` and `handoff::seal`; no I/O.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/protocol/mod.rs
//! ├── cloud::protocol::concat_kdf
//! ├── cloud::protocol::errors
//! ├── cloud::protocol::fingerprint
//! ├── cloud::protocol::handoff
//! ├── cloud::protocol::handoff_consent
//! ├── cloud::protocol::machine
//! ├── cloud::protocol::meta
//! ├── cloud::protocol::pairing
//! ├── cloud::protocol::rules
//! ├── cloud::protocol::signals
//! ├── cloud::protocol::signing
//! ├── cloud::protocol::test_fixtures
//! ├── cloud::protocol::ua
//! └── cloud::protocol::uri
//! External: (none)
//!
//! Used by:
//! cloud/protocol/mod.rs
//! └── cloud
//! <module-headers:end>

pub mod concat_kdf;
pub mod errors;
pub mod fingerprint;
pub mod handoff;
pub mod handoff_consent;
pub mod machine;
pub mod meta;
pub mod pairing;
pub mod rules;
pub mod signals;
pub mod signing;
#[cfg(test)]
pub(crate) mod test_fixtures;
pub mod ua;
pub mod uri;

pub use errors::{ErrorCode, ErrorEnvelope};
pub use meta::{Deprecation, Meta, ProtocolRange};
pub use rules::{Invalid, Validate};
pub use signals::{REFUSAL_HEADER, RefusalCode, SESSION_EXPIRED_CLOSE_CODE};

/// The protocol versions this build speaks.
pub const PROTOCOL_MIN: i64 = 1;
pub const PROTOCOL_MAX: i64 = 1;

/// The client's own range.
pub const CLIENT_RANGE: ProtocolRange = ProtocolRange {
    min: PROTOCOL_MIN,
    max: PROTOCOL_MAX,
};

/// Which side must be updated when the ranges do not overlap.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateSide {
    /// The server only speaks newer versions than this yaran.
    Client,
    /// The server is older than this yaran supports.
    Server,
}

/// n = min(cmax, smax), required to be >= max(cmin, smin) (`protocol_unsupported` otherwise).
pub fn negotiate(client: ProtocolRange, server: ProtocolRange) -> Result<i64, UpdateSide> {
    let n = client.max.min(server.max);
    if n >= client.min.max(server.min) {
        Ok(n)
    } else if server.min > client.max {
        Err(UpdateSide::Client)
    } else {
        Err(UpdateSide::Server)
    }
}

/// The server's deprecation entry for the chosen version, if it lists one.
pub fn deprecation_for(version: i64, deprecations: Option<&[Deprecation]>) -> Option<&Deprecation> {
    deprecations?.iter().find(|d| d.protocol == version)
}

#[cfg(test)]
mod tests {
    use super::*;
    use test_fixtures::fixture;

    #[test]
    fn negotiation_matches_the_decision_table() {
        let f = fixture("version/negotiate.json");
        let range = |v: &serde_json::Value| ProtocolRange {
            min: v["min"].as_i64().unwrap(),
            max: v["max"].as_i64().unwrap(),
        };
        for c in f["cases"].as_array().unwrap() {
            let name = c["name"].as_str().unwrap();
            let got = negotiate(range(&c["client"]), range(&c["server"]));
            match c["expect"]["update"].as_str() {
                Some("client") => assert_eq!(got, Err(UpdateSide::Client), "{name}"),
                Some("server") => assert_eq!(got, Err(UpdateSide::Server), "{name}"),
                _ => assert_eq!(got.ok(), c["expect"]["version"].as_i64(), "{name}"),
            }
            let deps: Option<Vec<Deprecation>> =
                serde_json::from_value(c["deprecations"].clone()).ok();
            let found = got.ok().and_then(|n| deprecation_for(n, deps.as_deref()));
            assert_eq!(
                found.map(|d| serde_json::to_value(d).unwrap()),
                Some(c["deprecated"].clone()).filter(|v| !v.is_null()),
                "{name}"
            );
        }
    }
}
