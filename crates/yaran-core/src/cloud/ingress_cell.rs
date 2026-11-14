//! The live cloud ingress cell: the hostname and Access identity a request arriving
//! through the tunnel is checked against (Phase 11 reads it; D4 requires a live rule,
//! never an `allowed_hosts` entry).
//!
//! It is set ONLY while the leg is Ready and cleared on every other transition and on
//! shutdown, so the rule is live exactly while the tunnel can deliver requests.
//!
//! - One writer: [`CloudIngressWriter`] is not `Clone`, and only `CloudLoop` owns one.
//!
//! ```compile_fail
//! let (writer, _reader) = yaran_core::cloud::ingress_cell::LiveCloudIngress::new();
//! let _second = writer.clone();
//! ```
//!
//! <module-headers:begin>
//! Uses: none
//! External: std
//!
//! Used by:
//! cloud/ingress_cell.rs
//! ├── cloud
//! ├── yaran-web::cloud_loop
//! ├── yaran-web::cloud_loop::live_cloud_mode_tests
//! └── yaran-web::cloud_mode
//! <module-headers:end>

use std::sync::{Arc, RwLock};

/// What a tunnelled request must match (from the credentials; `owner_email` is
/// `ClaimResponse.owner_email`, D3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudIngress {
    pub hostname: String,
    pub team_domain: String,
    pub aud: String,
    pub owner_email: String,
}

type Cell = Arc<RwLock<Option<Arc<CloudIngress>>>>;

/// The constructor namespace.
pub struct LiveCloudIngress;

impl LiveCloudIngress {
    #[allow(clippy::new_ret_no_self)]
    pub fn new() -> (CloudIngressWriter, CloudIngressReader) {
        let cell: Cell = Arc::default();
        (CloudIngressWriter(cell.clone()), CloudIngressReader(cell))
    }
}

/// The one writer.
#[derive(Debug)]
pub struct CloudIngressWriter(Cell);

impl CloudIngressWriter {
    pub fn set(&self, ingress: CloudIngress) {
        *self.0.write().unwrap_or_else(|p| p.into_inner()) = Some(Arc::new(ingress));
    }

    pub fn clear(&self) {
        *self.0.write().unwrap_or_else(|p| p.into_inner()) = None;
    }

    pub fn reader(&self) -> CloudIngressReader {
        CloudIngressReader(self.0.clone())
    }
}

/// A cheap reader.
#[derive(Debug, Clone, Default)]
pub struct CloudIngressReader(Cell);

impl CloudIngressReader {
    pub fn current(&self) -> Option<Arc<CloudIngress>> {
        self.0.read().unwrap_or_else(|p| p.into_inner()).clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readers_see_the_writer() {
        let (writer, reader) = LiveCloudIngress::new();
        assert!(reader.current().is_none());
        let ingress = CloudIngress {
            hostname: "h.example.com".into(),
            team_domain: "t.cloudflareaccess.com".into(),
            aud: "aud".into(),
            owner_email: "me@example.com".into(),
        };
        writer.set(ingress.clone());
        assert_eq!(reader.clone().current().as_deref(), Some(&ingress));
        writer.clear();
        assert!(reader.current().is_none());
    }
}
