//! yaran's cloud connect code (Yaran Cloud): the phone-app control plane's machine side.
//!
//! Today it holds only the wire contract (`protocol`); Phase 09 adds the credentials
//! store, machine identity and CLI as siblings.
//!
//! - No runtime behaviour of its own.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/mod.rs
//! └── cloud::protocol
//! External: none
//!
//! Used by:
//! cloud/mod.rs
//! └── crate
//! <module-headers:end>

pub mod protocol;
