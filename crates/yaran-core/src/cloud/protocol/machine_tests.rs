//! Schema-fixture and redaction tests for the machine API bodies.
//!
//! - Test-only (`#[cfg(test)]` child of `cloud::protocol::machine`).
//!
//! <module-headers:begin>
//! Uses:
//! cloud/protocol/machine_tests.rs
//! ├── cloud::protocol::machine
//! └── cloud::protocol::test_fixtures
//! External: none
//!
//! Used by:
//! cloud/protocol/machine_tests.rs
//! └── cloud::protocol::machine
//! <module-headers:end>

use super::*;
use crate::cloud::protocol::test_fixtures::assert_api_type;

#[test]
fn machine_types_match_the_schema_fixtures() {
    assert_api_type::<TunnelCredentials>("TunnelCredentials");
    assert_api_type::<MachineAccess>("MachineAccess");
    assert_api_type::<ClaimRequest>("ClaimRequest");
    assert_api_type::<ClaimResponse>("ClaimResponse");
    assert_api_type::<MachineConfig>("MachineConfig");
    assert_api_type::<EventBatch>("EventBatch");
    assert_api_type::<Event>("Event");
    assert_api_type::<AttentionEvent>("AttentionEvent");
    assert_api_type::<ExitEvent>("ExitEvent");
    assert_api_type::<EventBatchResult>("EventBatchResult");
    assert_api_type::<RotateRequest>("RotateRequest");
    assert_api_type::<RotateResponse>("RotateResponse");
    assert_api_type::<TeardownStarted>("TeardownStarted");
    assert_api_type::<OriginUpdate>("OriginUpdate");
    assert_api_type::<OriginUpdateResult>("OriginUpdateResult");
}

#[test]
fn the_tunnel_token_never_reaches_debug_output() {
    let creds = TunnelCredentials {
        id: "x".into(),
        token: "secret-token".into(),
        token_version: 1,
    };
    assert!(!format!("{creds:?}").contains("secret-token"));
}
