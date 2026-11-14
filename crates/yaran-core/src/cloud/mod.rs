//! yaran's cloud connect code (Yaran Cloud): the phone-app control plane's machine side.
//!
//! `protocol` is the wire contract (Phase 02). Phase 09 adds the `[cloud]` config
//! section, the owner-only credentials store, the machine identity and signed client,
//! the browser login and the `yaran cloud` CLI as siblings.
//!
//! - No runtime behaviour of its own.
//!
//! <module-headers:begin>
//! <module-headers:end>

//TODO pub mod cli;
pub mod config;
pub mod config_patch;
pub mod credentials;
pub mod identity;
pub mod leg_state;
pub mod login;
pub mod loopback;
pub mod machine_api;
pub mod machine_api_error;
pub mod org_url;
pub mod outcome;
pub mod paths;
pub mod pkce;
pub mod protocol;
pub mod qr;
pub mod revocation;
pub mod signed_request;
#[cfg(any(test, feature = "test-support"))]
pub mod test_support;
