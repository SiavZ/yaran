//! The auth status document as served, with this build's compatibility signal for the phone app.
//!
//! `native_auth_ui` says this build's served page never takes a password inside the phone app:
//! signed out there, the page hands sign-in to the app's native sheet. The phone admits a
//! machine's page only when it is `true`, and it is `true` only when the embedded frontend is
//! proven to be this source's own build ([`native_auth_ui`]): a Rust-only build that reused an
//! old `web/dist`, or embedded the notice page, says `false`. It is compatibility, never
//! authorization: the same for every client and request, and nothing on the server reads it.

use serde::Serialize;

use super::StatusDoc;

#[derive(Serialize)]
pub(super) struct StatusAnswer {
    #[serde(flatten)]
    doc: StatusDoc,
    native_auth_ui: bool,
}

/// `doc` with this yaran's public `instance` and the compatibility signal.
pub(super) fn answer(mut doc: StatusDoc, instance: Option<&str>) -> StatusAnswer {
    doc.instance = instance.map(str::to_string);
    StatusAnswer {
        doc,
        native_auth_ui: native_auth_ui(),
    }
}

/// Whether this binary's own build script built the frontend it serves from this source. Read
/// from the state file `build.rs` writes in `$OUT_DIR` on every path, never from the environment,
/// so no ambient variable can claim a build that did not happen; a binary without the file does
/// not compile. Only exactly `built` qualifies: a reused (`stale`) or absent (`not_built`)
/// frontend, or anything unrecognised, is `false` (the opposite default from
/// `web_assets::ui_build_state`, whose unknown value means Built so tests fail loudly).
pub(super) fn native_auth_ui() -> bool {
    proven(include_str!(concat!(env!("OUT_DIR"), "/ui_build_state")))
}

fn proven(recorded: &str) -> bool {
    recorded == "built"
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::web_assets::{UiBuildState, ui_build_state};

    #[test]
    fn only_a_proven_frontend_build_claims_the_native_sign_in_page() {
        assert!(proven("built"));
        for unproven in ["stale", "not_built", "", "Built", "built\n", "true", "1"] {
            assert!(!proven(unproven), "{unproven:?}");
        }
        // This binary's own claim is its recorded build: true for a real build, false for the
        // hatch's stale reuse or notice page (both stamp the same state into the env marker).
        assert_eq!(native_auth_ui(), ui_build_state() == UiBuildState::Built);
    }
}
