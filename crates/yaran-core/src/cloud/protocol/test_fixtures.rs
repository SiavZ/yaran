//! Test-only reader for the shared cloud protocol fixtures in `cloud/protocol/fixtures/`.
//!
//! The same files are read by the TypeScript suite, the Worker, the relay and the mobile
//! apps; resolving them from `CARGO_MANIFEST_DIR` follows the `prose.rs` cross-language
//! fixture pattern, so Rust and TS pass or fail on identical bytes.
//!
//! - Compiled only under `cfg(test)`; panics on a missing or malformed fixture.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/protocol/test_fixtures.rs
//! └── cloud::protocol::rules
//! External: serde, serde_json, std
//!
//! Used by:
//! cloud/protocol/test_fixtures.rs
//! ├── cloud::leg::tests
//! ├── cloud::machine_api_error
//! ├── cloud::protocol
//! ├── cloud::protocol::concat_kdf
//! ├── cloud::protocol::errors
//! ├── cloud::protocol::fingerprint
//! ├── cloud::protocol::handoff::tests
//! ├── cloud::protocol::handoff_consent::tests
//! ├── cloud::protocol::machine
//! ├── cloud::protocol::meta
//! ├── cloud::protocol::pairing
//! ├── cloud::protocol::rules
//! ├── cloud::protocol::signals
//! ├── cloud::protocol::signing
//! ├── cloud::protocol::ua
//! ├── cloud::protocol::uri
//! ├── cloud::qr
//! └── cloud::signed_request
//! <module-headers:end>

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use super::rules::Validate;

/// The `cloud/protocol` package root.
pub fn protocol_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../cloud/protocol")
}

/// Parses a JSON file under the package root (`fixtures/...` or `registry/...`).
pub fn load(relative: &str) -> Value {
    let path = protocol_root().join(relative);
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("fixture {} must be readable: {e}", path.display()));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("fixture {relative} must parse: {e}"))
}

/// Parses a fixture under `fixtures/`.
pub fn fixture(relative: &str) -> Value {
    load(&format!("fixtures/{relative}"))
}

type Cases = Vec<(String, Value)>;

/// The `(valid, invalid)` named values of `fixtures/api/<Type>.json`.
pub fn api_cases(type_name: &str) -> (Cases, Cases) {
    let file = fixture(&format!("api/{type_name}.json"));
    let list = |key: &str| -> Cases {
        file[key]
            .as_array()
            .unwrap_or_else(|| panic!("{type_name}: `{key}` must be an array"))
            .iter()
            .map(|c| {
                (
                    c["name"].as_str().expect("case name").to_string(),
                    c["value"].clone(),
                )
            })
            .collect()
    };
    let (valid, invalid) = (list("valid"), list("invalid"));
    assert!(
        !valid.is_empty() && !invalid.is_empty(),
        "{type_name} needs valid and invalid cases"
    );
    (valid, invalid)
}

/// Every valid value deserializes, validates and re-serializes to an equal value; every
/// invalid value fails to deserialize or fails validation.
pub fn assert_api_type<T: DeserializeOwned + Serialize + Validate>(type_name: &str) {
    let (valid, invalid) = api_cases(type_name);
    for (name, value) in valid {
        let parsed: T = serde_json::from_value(value.clone())
            .unwrap_or_else(|e| panic!("{type_name} `{name}` must deserialize: {e}"));
        if let Err(e) = parsed.validate() {
            panic!("{type_name} `{name}` must validate: {e}");
        }
        let again = serde_json::to_value(&parsed).expect("serializes");
        assert_eq!(
            again, value,
            "{type_name} `{name}` must round-trip unchanged"
        );
    }
    for (name, value) in invalid {
        let rejected = match serde_json::from_value::<T>(value) {
            Err(_) => true,
            Ok(parsed) => parsed.validate().is_err(),
        };
        assert!(rejected, "{type_name} `{name}` must be rejected");
    }
}

/// Lowercase hex of bytes.
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Bytes of a hex string.
pub fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
        .collect()
}
