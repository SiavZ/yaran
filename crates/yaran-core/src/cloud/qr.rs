//! The add-org QR code: one encoder for the CLI, the TUI and the web (Phase 13).
//!
//! The payload is `yaranapp://add-org?u=<org url>`, built by 02's `add_org_uri`. The
//! matrix comes from the `qrcode` crate (no default features: no image dependencies).
//! Three renderings: a terminal string (half-block characters, light modules drawn so a
//! dark terminal still scans), an SVG for the web, and the raw module matrix the TUI
//! paints with its `yaran.qr_dark` / `yaran.qr_light` theme tokens. Every rendering
//! carries the standard 4-module quiet zone.
//!
//! - Pure.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/qr.rs
//! ├── cloud::protocol::test_fixtures
//! └── cloud::protocol::uri
//! External: qrcode, ring
//!
//! Used by:
//! cloud/qr.rs
//! ├── cloud
//! ├── cloud::cli::pair_phone
//! ├── yaran-tui::app::cloud_commands
//! ├── yaran-tui::app::cloud_tests
//! └── yaran-web::cloud_phone_routes
//! <module-headers:end>

use qrcode::render::{svg, unicode};
use qrcode::{Color, QrCode};

use crate::cloud::protocol::uri::add_org_uri;

/// Modules of light border around the symbol.
pub const QUIET_ZONE: usize = 4;

/// An encoded QR symbol.
pub struct Qr {
    code: QrCode,
}

impl Qr {
    /// Encode `data`.
    pub fn encode(data: &str) -> Result<Self, String> {
        QrCode::new(data.as_bytes())
            .map(|code| Self { code })
            .map_err(|e| format!("could not encode the QR code: {e}"))
    }

    /// The add-org QR for `org_url`, with its URI.
    pub fn add_org(org_url: &str) -> Result<(String, Self), String> {
        let uri = add_org_uri(org_url)
            .ok_or_else(|| format!("{org_url:?} is not a Yaran Cloud organization address"))?;
        Ok((uri.clone(), Self::encode(&uri)?))
    }

    /// Side length in modules, quiet zone included.
    pub fn size(&self) -> usize {
        self.code.width() + 2 * QUIET_ZONE
    }

    /// Whether the module at `(x, y)` (quiet zone included) is dark.
    pub fn is_dark(&self, x: usize, y: usize) -> bool {
        let w = self.code.width();
        let (Some(x), Some(y)) = (x.checked_sub(QUIET_ZONE), y.checked_sub(QUIET_ZONE)) else {
            return false;
        };
        x < w && y < w && self.code[(x, y)] == Color::Dark
    }

    /// Two module rows per text line; light modules are drawn as blocks so the symbol
    /// reads correctly on a dark terminal background.
    pub fn to_terminal(&self) -> String {
        self.code
            .render::<unicode::Dense1x2>()
            .dark_color(unicode::Dense1x2::Light)
            .light_color(unicode::Dense1x2::Dark)
            .quiet_zone(true)
            .build()
    }

    /// A standalone SVG, black on white, `module_px` pixels per module.
    pub fn to_svg(&self, module_px: u32) -> String {
        self.code
            .render::<svg::Color>()
            .module_dimensions(module_px, module_px)
            .dark_color(svg::Color("#000000"))
            .light_color(svg::Color("#ffffff"))
            .quiet_zone(true)
            .build()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::protocol::test_fixtures::fixture;
    use ring::digest::{SHA256, digest};

    #[test]
    fn the_payload_is_the_fixture_uri() {
        let f = fixture("uri/add-org.json");
        for c in f["build"].as_array().unwrap() {
            let org = c["org_url"].as_str().unwrap();
            match c["expect"].as_str() {
                Some(want) => assert_eq!(Qr::add_org(org).unwrap().0, want, "{org}"),
                None => assert!(Qr::add_org(org).is_err(), "{org}"),
            }
        }
    }

    #[test]
    fn the_matrix_matches_the_encoder_with_a_four_module_quiet_zone() {
        let (_, qr) = Qr::add_org("https://cloud.example.com").unwrap();
        let colors = qr.code.to_colors();
        let w = qr.code.width();
        assert_eq!(qr.size(), w + 8);
        for y in 0..qr.size() {
            for x in 0..qr.size() {
                let inside = (QUIET_ZONE..QUIET_ZONE + w).contains(&x)
                    && (QUIET_ZONE..QUIET_ZONE + w).contains(&y);
                let want = inside && colors[(y - QUIET_ZONE) * w + (x - QUIET_ZONE)] == Color::Dark;
                assert_eq!(qr.is_dark(x, y), want, "({x},{y})");
            }
        }
        // The finder pattern's corner is dark, the module before it is quiet zone.
        assert!(qr.is_dark(QUIET_ZONE, QUIET_ZONE));
        assert!(!qr.is_dark(QUIET_ZONE - 1, QUIET_ZONE));
    }

    #[test]
    fn the_terminal_rendering_is_pinned() {
        let (_, qr) = Qr::add_org("https://cloud.example.com").unwrap();
        let text = qr.to_terminal();
        assert_eq!(text.lines().count(), qr.size().div_ceil(2));
        // The top quiet-zone line is all light, drawn as full blocks.
        assert!(text.lines().next().unwrap().chars().all(|c| c == '█'));
        let hex: String = digest(&SHA256, text.as_bytes())
            .as_ref()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(hex, SNAPSHOT_SHA256, "Dense1x2 rendering changed");
        let svg = qr.to_svg(4);
        assert!(svg.starts_with("<?xml") && svg.contains("#000000"));
    }

    const SNAPSHOT_SHA256: &str =
        "69948e167cab9579e4b489c746dbefd54436a009dee755612d6bb29654692b1a";
}
