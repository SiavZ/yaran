//! `yaran cloud pair-phone`: print the add-org QR code, its URI and an install hint.
//!
//! The org is the paired one (credentials), else `--org`, else `[cloud] org_url`, and
//! is normalized like a login URL. The QR comes from the one shared encoder
//! (`cloud::qr`), so the CLI, TUI and web codes cannot differ.
//!
//! - Pure apart from reading the credentials.
//!
//! <module-headers:begin>
//! <module-headers:end>

use std::io::Write;

use super::CloudDeps;
use crate::cloud::credentials;
use crate::cloud::org_url::normalize_org_url;
use crate::cloud::qr::Qr;

pub(super) fn run(deps: &CloudDeps, org: Option<String>, out: &mut dyn Write) -> i32 {
    let paired = credentials::read(&deps.paths)
        .ok()
        .flatten()
        .map(|c| c.org_url);
    let raw = paired
        .or(org)
        .unwrap_or_else(|| deps.config.org_url.clone());
    if raw.trim().is_empty() {
        let _ = writeln!(
            out,
            "This machine is not paired and no organization was named; run `yaran cloud pair-phone --org <url>` or `yaran cloud login` first."
        );
        return 2;
    }
    let org_url = match normalize_org_url(&raw) {
        Ok(u) => u,
        Err(e) => {
            let _ = writeln!(out, "{e}");
            return 2;
        }
    };
    match Qr::add_org(&org_url) {
        Ok((uri, qr)) => {
            let _ = writeln!(
                out,
                "{}\nScan this with the Yaran app on your phone to add {org_url}.\nOr open this link on the phone: {uri}\nNo app yet? Install Yaran from your app store first, then scan again.",
                qr.to_terminal()
            );
            0
        }
        Err(e) => {
            let _ = writeln!(out, "{e}");
            1
        }
    }
}
