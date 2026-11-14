//! The `/ws/events` application-level beat: the browser sends `{"beat":N}` and the
//! server answers `{"event":"beat","n":N}`.
//!
//! The server's own 30 s ping is a WebSocket control frame, which page JavaScript
//! never sees, so without this the browser cannot notice the half-open socket a radio
//! handoff leaves behind. The PTY sockets already carry the same beat; this is that
//! frame on the events socket, so there is still exactly one client pinger per socket.
//!
//! - Pure: parse and echo only. A malformed or beat-less frame is not a beat and is
//!   left to the ordinary subscribe parser, never an error.

/// How long the echo may hold the events sink. A twenty-five byte write needs no
/// more, and the browser stops waiting at its own deadline anyway.
pub(crate) const ECHO_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

#[derive(serde::Deserialize)]
struct BeatFrame {
    beat: u64,
}

/// The answer to a client text frame that is a beat, or `None` for anything else.
pub(crate) fn echo(text: &str) -> Option<String> {
    let frame: BeatFrame = serde_json::from_str(text).ok()?;
    Some(format!(r#"{{"event":"beat","n":{}}}"#, frame.beat))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_beat_is_echoed_with_its_own_number() {
        assert_eq!(
            echo(r#"{"beat":7}"#).as_deref(),
            Some(r#"{"event":"beat","n":7}"#)
        );
        let v: serde_json::Value = serde_json::from_str(&echo(r#"{"beat":0}"#).unwrap()).unwrap();
        assert_eq!(v, serde_json::json!({"event": "beat", "n": 0}));
    }

    #[test]
    fn anything_else_is_not_a_beat() {
        for text in [
            r#"{"subscribe":["sessions"]}"#,
            r#"{"beat":"7"}"#,
            r#"{"beat":-1}"#,
            r#"{"beat":1.5}"#,
            "not json",
            "",
        ] {
            assert_eq!(echo(text), None, "{text}");
        }
    }
}
