//! Where Yaran Cloud keeps its files: `<config root>/cloud/`.
//!
//! A separate value derived from `YaranPaths` rather than new `YaranPaths` fields,
//! because `YaranPaths` is built as a struct literal in over a hundred places.
//!
//! - `ensure_dir` creates `cloud/` owner-only (`0700`) through `file_modes`.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/paths.rs
//! ├── config
//! └── file_modes
//! External: std, tempfile
//!
//! Used by:
//! cloud/paths.rs
//! ├── cloud
//! ├── cloud::actions
//! ├── cloud::cli
//! ├── cloud::credentials
//! ├── cloud::leg_identity
//! ├── cloud::leg_state
//! ├── cloud::login
//! ├── cloud::login_session
//! ├── cloud::machine_api
//! ├── cloud::push_link
//! ├── cloud::status
//! ├── cloud::test_support
//! ├── yaran-core[test cloud_login]
//! ├── yaran-core[test cloud_machine_api]
//! ├── yaran-core[test cloud_push_emitter]
//! ├── yaran-tui::app::cloud_commands
//! ├── yaran-web::cloud_ingress
//! ├── yaran-web::cloud_ingress_tests
//! ├── yaran-web::cloud_loop
//! ├── yaran-web::cloud_phone_routes
//! ├── yaran-web::cloud_routes
//! ├── yaran-web::cloud_routes::actions_routes
//! └── yaran-web::cloud_routes::tests
//! <module-headers:end>

use std::io;
use std::path::{Path, PathBuf};

use crate::config::YaranPaths;

/// Every Yaran Cloud path under one config root.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CloudPaths {
    /// `<root>/cloud`, mode `0700`.
    pub dir: PathBuf,
    /// `credentials.json`, mode `0600`: every secret and pairing-derived value.
    pub credentials: PathBuf,
    /// `credentials.lock`, the writers' `flock`.
    pub lock: PathBuf,
    /// `leg-state.json`, written by the tunnel leg (Phase 10), read by `status`.
    pub leg_state: PathBuf,
    /// `tunnel-token`, written by Phase 10 just before each cloudflared spawn.
    pub tunnel_token: PathBuf,
}

impl CloudPaths {
    pub fn new(paths: &YaranPaths) -> Self {
        Self::from_root(&paths.root)
    }

    pub fn from_root(root: &Path) -> Self {
        Self::from_dir(&root.join("cloud"))
    }

    /// The same layout under an explicit `cloud/` directory.
    pub fn from_dir(dir: &Path) -> Self {
        let dir = dir.to_path_buf();
        Self {
            credentials: dir.join("credentials.json"),
            lock: dir.join("credentials.lock"),
            leg_state: dir.join("leg-state.json"),
            tunnel_token: dir.join("tunnel-token"),
            dir,
        }
    }

    /// Create `cloud/` (and the root if missing) and make it owner-only.
    pub fn ensure_dir(&self) -> io::Result<()> {
        crate::file_modes::create_private_dir_all(&self.dir)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn the_cloud_dir_is_owner_only() {
        let root = tempfile::tempdir().unwrap();
        let paths = CloudPaths::from_root(root.path());
        paths.ensure_dir().unwrap();
        let mode = std::fs::metadata(&paths.dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
        assert_eq!(
            paths.credentials,
            root.path().join("cloud/credentials.json")
        );
    }
}
