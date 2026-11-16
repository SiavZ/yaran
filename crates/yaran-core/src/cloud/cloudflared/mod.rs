//! cloudflared: getting a trustworthy binary and running it as yaran's one tunnel child.
//!
//! Acquisition (`pins`, `version`, `targz`, `acquire`), the child's command line
//! (`command`), its stderr (`log_lines`), the exit policy (`policy`), one running child
//! (`supervisor`), the `/ready` probe (`ready`) and the process-global registry that
//! guarantees no orphan outlives yaran (`child_registry`).
//!
//! - No tokio: everything here runs on std threads owned by `cloud::leg`.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/cloudflared/mod.rs
//! ├── cloud::cloudflared::acquire
//! ├── cloud::cloudflared::child_registry
//! ├── cloud::cloudflared::command
//! ├── cloud::cloudflared::log_lines
//! ├── cloud::cloudflared::pins
//! ├── cloud::cloudflared::policy
//! ├── cloud::cloudflared::ready
//! ├── cloud::cloudflared::supervisor
//! ├── cloud::cloudflared::targz
//! ├── cloud::cloudflared::test_support
//! └── cloud::cloudflared::version
//! External: std
//!
//! Used by:
//! cloud/cloudflared/mod.rs
//! ├── cloud
//! └── cloud::leg_start
//! <module-headers:end>

pub mod acquire;
pub mod child_registry;
pub mod command;
pub mod log_lines;
pub mod pins;
pub mod policy;
pub mod ready;
pub mod supervisor;
pub mod targz;
#[cfg(test)]
pub(crate) mod test_support;
pub mod version;

/// The yaran release target this binary was built for, as a Rust triple, or `None` when
/// yaran does not ship for it (the managed path then names `cloudflared_path`).
pub fn current_target() -> Option<&'static str> {
    target_for(std::env::consts::ARCH, std::env::consts::OS)
}

/// The triple for an `(arch, os)` pair, split out so every row is testable on one host.
pub fn target_for(arch: &str, os: &str) -> Option<&'static str> {
    match (arch, os) {
        ("x86_64", "linux") => Some("x86_64-unknown-linux-musl"),
        ("aarch64", "linux") => Some("aarch64-unknown-linux-musl"),
        ("x86_64", "macos") => Some("x86_64-apple-darwin"),
        ("aarch64", "macos") => Some("aarch64-apple-darwin"),
        _ => None,
    }
}

/// The pinned asset for a target triple.
pub fn pin_for(target: &str) -> Option<&'static pins::Pin> {
    pins::PINS.iter().find(|pin| pin.target == target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_shipped_target_maps_to_a_pin() {
        for (arch, os) in [
            ("x86_64", "linux"),
            ("aarch64", "linux"),
            ("x86_64", "macos"),
            ("aarch64", "macos"),
        ] {
            let target = target_for(arch, os).expect("a shipped target");
            assert!(pin_for(target).is_some(), "no pin for {target}");
        }
        assert_eq!(target_for("riscv64", "linux"), None);
        assert_eq!(target_for("x86_64", "windows"), None);
    }

    #[test]
    fn the_pin_table_is_sane() {
        let is_hex = |s: &str| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit());
        let mut assets: Vec<_> = pins::PINS.iter().map(|pin| pin.asset).collect();
        assets.sort_unstable();
        assets.dedup();
        assert_eq!(assets.len(), pins::PINS.len(), "assets must be distinct");
        for pin in pins::PINS {
            assert!(
                is_hex(pin.asset_sha256) && is_hex(pin.binary_sha256),
                "{pin:?}"
            );
            assert_eq!(
                pin.kind == pins::AssetKind::Tgz,
                pin.asset.ends_with(".tgz"),
                "{pin:?}"
            );
        }
    }
}
