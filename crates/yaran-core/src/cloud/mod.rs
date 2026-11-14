//! yaran's cloud connect code (Yaran Cloud): the phone-app control plane's machine side.
//!
//! `protocol` is the wire contract (Phase 02). Phase 09 adds the `[cloud]` config
//! section, the owner-only credentials store, the machine identity and signed client,
//! the browser login and the `yaran cloud` CLI as siblings; Phase 10 adds the cloudflared
//! leg (`cloudflared`, `leg*`, `planner`, `view`) on top of them.
//!
//! - No runtime behaviour of its own.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/mod.rs
//! ├── cloud::actions
//! ├── cloud::cli
//! ├── cloud::cloudflared
//! ├── cloud::config
//! ├── cloud::config_patch
//! ├── cloud::credentials
//! ├── cloud::identity
//! ├── cloud::ingress_cell
//! ├── cloud::leg
//! ├── cloud::leg_identity
//! ├── cloud::leg_outcome
//! ├── cloud::leg_run
//! ├── cloud::leg_start
//! ├── cloud::leg_state
//! ├── cloud::login
//! ├── cloud::login_session
//! ├── cloud::loopback
//! ├── cloud::machine_api
//! ├── cloud::machine_api_error
//! ├── cloud::org_url
//! ├── cloud::outcome
//! ├── cloud::pair_refusal
//! ├── cloud::paths
//! ├── cloud::pkce
//! ├── cloud::planner
//! ├── cloud::protocol
//! ├── cloud::qr
//! ├── cloud::revocation
//! ├── cloud::signed_request
//! ├── cloud::status
//! ├── cloud::test_support
//! └── cloud::view
//! External: none
//!
//! Used by:
//! cloud/mod.rs
//! └── crate
//! <module-headers:end>

pub mod actions;
pub mod cli;
pub mod cloudflared;
pub mod config;
pub mod config_patch;
pub mod credentials;
pub mod identity;
pub mod ingress_cell;
pub mod leg;
pub mod leg_identity;
pub mod leg_outcome;
mod leg_run;
mod leg_start;
pub mod leg_state;
pub mod login;
pub mod login_session;
pub mod loopback;
pub mod machine_api;
pub mod machine_api_error;
pub mod org_url;
pub mod outcome;
pub mod pair_refusal;
pub mod paths;
pub mod pkce;
pub mod planner;
pub mod protocol;
pub mod qr;
pub mod revocation;
pub mod signed_request;
pub mod status;
#[cfg(any(test, feature = "test-support"))]
pub mod test_support;
pub mod view;
