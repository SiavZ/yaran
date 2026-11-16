//! Turning a recorded driver identity into a short label a surface can render.
//!
//! The PTY-ownership registry records whatever a claiming connection presented
//! at its upgrade: a browser's raw `User-Agent`, or the terminal UI's fixed
//! [`TUI_DEVICE_LABEL`]. Both end up as copy on a watcher's screen, where there
//! is a name's worth of room and not a paragraph's.
//!
//! The terminal UI's twin of the web's `deviceLabel.ts`, kept in step with it:
//! the same UA shapes must produce the same label on both surfaces, or one
//! device is called two different things depending on which screen is looking at
//! it. Both suites read one fixture, `tests/fixtures/device_label_cross_language.json`.
//!
//! The phone app's `YaranApp/…` token (Phase 02 §11) is read FIRST, before any OS
//! check, because an iPad's WKWebView sends a Mac User-Agent.
//!
//! The two deliberately differ on an unparseable string: `deviceLabel.ts`
//! returns `null` because it renders into HTML, where echoing an
//! attacker-supplied string is a bug class of its own, while this returns a
//! control-stripped prefix bounded to [`SHORT_LABEL_MAX_CHARS`], which cannot
//! corrupt a frame and is more use than "another device" to somebody working out
//! which of their machines holds a terminal.

use crate::background_serve::TUI_DEVICE_LABEL;
use crate::cloud::protocol::ua::{AppForm, AppOs, parse_yaran_app_ua};

/// How long an UNRECOGNIZED label may be before it is cut, ellipsis included.
///
/// Sized for the place it is rendered: one line inside the center pane, sharing
/// that line with the sentence that says how to take the terminal back. Names
/// this parser DOES recognize ("Chrome on Android") already sit well inside it.
pub const SHORT_LABEL_MAX_CHARS: usize = 24;

/// The operating system a `User-Agent` names, or `None`.
///
/// Order matters, and it is the same order `deviceLabel.ts` uses: an Android UA
/// also contains "Linux" and an iOS UA also contains "like Mac OS X", so the
/// more specific token has to be tested first.
fn detect_os(ua: &str) -> Option<&'static str> {
    if ua.contains("Android") {
        return Some("Android");
    }
    if ua.contains("iPhone") || ua.contains("iPad") || ua.contains("iPod") {
        return Some("iOS");
    }
    if ua.contains("Windows") {
        return Some("Windows");
    }
    if ua.contains("Macintosh") || ua.contains("Mac OS X") {
        return Some("macOS");
    }
    if ua.contains("Linux") {
        return Some("Linux");
    }
    None
}

/// The browser a `User-Agent` names, or `None`.
///
/// Order matters, and it matches `deviceLabel.ts`: Edge and Chrome both carry a
/// "Chrome/" token and Chrome and Safari both carry a "Safari/" token, so each
/// check excludes the engines layered above it. Edge's token is platform
/// specific ("Edg/", "EdgA/", "EdgiOS/") and the mobile spellings must be matched
/// explicitly or they fall through to Chrome, into which the other
/// Chromium-based browsers are deliberately folded.
fn detect_browser(ua: &str) -> Option<&'static str> {
    if ua.contains("Edg/") || ua.contains("EdgA/") || ua.contains("EdgiOS/") {
        return Some("Edge");
    }
    if ua.contains("Firefox/") {
        return Some("Firefox");
    }
    if ua.contains("Chrome/") || ua.contains("CriOS/") {
        return Some("Chrome");
    }
    if ua.contains("Safari/") {
        return Some("Safari");
    }
    None
}

/// The phone app's own label, from its User-Agent token, or `None` for a browser.
fn app_label(ua: &str) -> Option<&'static str> {
    let app = parse_yaran_app_ua(ua)?;
    Some(match (app.os, app.form) {
        (AppOs::Ios, AppForm::Phone) => "yaran on iPhone",
        (AppOs::Ios, AppForm::Tablet) => "yaran on iPad",
        (AppOs::Android, AppForm::Phone) => "yaran on Android phone",
        (AppOs::Android, AppForm::Tablet) => "yaran on Android tablet",
    })
}

/// Cut `text` to at most `max` DISPLAY characters, marking the cut.
///
/// Char based, never byte based: a `User-Agent` is attacker-supplied and can
/// carry multi-byte UTF-8, and byte slicing inside a character panics.
///
/// Public because the surface that renders a label has a second, narrower budget
/// the parser cannot know: the width actually left on the line after the rest of
/// the sentence. Cutting twice with one function keeps the ellipsis consistent.
pub fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    // One character of the budget belongs to the ellipsis that says it was cut.
    let keep = max.saturating_sub(1);
    let mut out: String = text.chars().take(keep).collect();
    out.push('\u{2026}');
    out
}

/// The short label for a recorded driver identity, or `None` when there is
/// nothing to name at all.
///
///   - Nothing, or only whitespace and control bytes, gives `None`; the caller
///     says "another device", which is the honest answer for a connection that
///     presented no `User-Agent`.
///   - The terminal UI's own fixed label passes through verbatim. It parses as
///     no OS at all, so without this the one non-browser driver yaran has would be
///     truncated into nonsense.
///   - A known OS with a known browser gives "Chrome on macOS".
///   - A known OS alone gives the OS.
///   - Anything else gives a control-stripped prefix, cut to
///     [`SHORT_LABEL_MAX_CHARS`].
pub fn short_device_label(raw: &str) -> Option<String> {
    // Control bytes first, before anything measures or matches: this is rendered
    // into a frame, and an escape sequence smuggled through a `User-Agent` would
    // move the cursor rather than print.
    let cleaned: String = raw.chars().filter(|c| !c.is_control()).collect();
    let ua = cleaned.trim();
    if ua.is_empty() {
        return None;
    }
    if ua == TUI_DEVICE_LABEL {
        return Some(ua.to_string());
    }
    if let Some(label) = app_label(ua) {
        return Some(label.to_string());
    }
    match detect_os(ua) {
        Some(os) => Some(match detect_browser(ua) {
            Some(browser) => format!("{browser} on {os}"),
            None => os.to_string(),
        }),
        None => Some(truncate_chars(ua, SHORT_LABEL_MAX_CHARS)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The fixture both suites read; a change to either parser the other did not
    /// follow fails here or in `deviceLabel.test.ts`.
    fn shared_cases() -> Vec<(String, String)> {
        let doc: serde_json::Value = serde_json::from_str(include_str!(
            "../tests/fixtures/device_label_cross_language.json"
        ))
        .expect("the shared fixture is JSON");
        doc["cases"]
            .as_array()
            .expect("cases")
            .iter()
            .map(|c| {
                (
                    c["ua"].as_str().expect("ua").to_string(),
                    c["label"].as_str().expect("label").to_string(),
                )
            })
            .collect()
    }

    #[test]
    fn the_shared_fixture_produces_the_same_labels_here() {
        for (raw, expected) in shared_cases() {
            assert_eq!(
                short_device_label(&raw).as_deref(),
                Some(expected.as_str()),
                "{raw}"
            );
        }
    }

    /// The terminal UI is the one participant that is not a browser, and its
    /// fixed label is copy already: it passes through untouched, exactly as the
    /// web's exact-match rule passes it through.
    #[test]
    fn the_terminal_uis_own_label_passes_through_verbatim() {
        assert_eq!(
            short_device_label(TUI_DEVICE_LABEL).as_deref(),
            Some(TUI_DEVICE_LABEL)
        );
    }

    /// Nothing to name is `None`, so the caller can say "another device" rather
    /// than render an empty span where a device name belongs.
    #[test]
    fn an_empty_or_blank_identity_names_nothing() {
        assert_eq!(short_device_label(""), None);
        assert_eq!(short_device_label("    "), None);
        // Control bytes alone leave nothing printable behind.
        assert_eq!(short_device_label("\u{1b}\u{7}\r\n"), None);
    }

    /// Every recognized user-agent shape fits the device-label line.
    #[test]
    fn every_recognized_shape_fits_the_line_it_is_rendered_on() {
        for (raw, _) in shared_cases() {
            if raw.chars().count() <= SHORT_LABEL_MAX_CHARS {
                continue;
            }
            // Only a UA longer than the budget proves the label was not a cut.
            let label = short_device_label(&raw).expect("a real UA names a device");
            assert!(
                label.chars().count() <= SHORT_LABEL_MAX_CHARS,
                "{label:?} is {} characters, over the {SHORT_LABEL_MAX_CHARS} the pane has",
                label.chars().count()
            );
        }
    }

    /// An unrecognized identity is cut to the budget rather than refused, and the
    /// cut is marked so nobody reads a prefix as the whole name.
    #[test]
    fn an_unrecognized_identity_is_cut_to_the_budget_and_marked() {
        let label = short_device_label(&"z".repeat(200)).expect("something was said");
        assert_eq!(label.chars().count(), SHORT_LABEL_MAX_CHARS);
        assert!(
            label.ends_with('\u{2026}'),
            "the cut must be visible: {label}"
        );

        // Short enough already: kept whole, with no ellipsis invented for it.
        assert_eq!(
            short_device_label("my-laptop").as_deref(),
            Some("my-laptop")
        );
    }

    /// The cut is CHARACTER based. A byte-based cut of multi-byte text panics
    /// inside a character, and this input is attacker-supplied.
    #[test]
    fn the_cut_never_lands_inside_a_multibyte_character() {
        let label = short_device_label(&"\u{1f600}".repeat(40)).expect("something was said");
        assert_eq!(label.chars().count(), SHORT_LABEL_MAX_CHARS);
        assert!(label.starts_with('\u{1f600}'));
    }

    /// Control bytes are stripped BEFORE anything renders the label: this value
    /// goes into a frame, and a smuggled escape sequence would move the cursor
    /// instead of printing.
    #[test]
    fn control_bytes_are_stripped_rather_than_rendered() {
        let label = short_device_label("lab\u{1b}[31mtop\u{7}").expect("something was said");
        assert!(
            !label.chars().any(char::is_control),
            "no control byte may survive into the frame: {label:?}"
        );
        assert_eq!(label, "lab[31mtop");
    }
}
