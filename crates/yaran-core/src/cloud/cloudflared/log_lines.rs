//! cloudflared's stderr, one line at a time: parse, redact, log, classify.
//!
//! cloudflared writes JSON log objects (`--output json`) whose key order is not stable;
//! a usage error is plain text. Every `message` and `error` is attacker-adjacent text from
//! the edge, so it goes through `sanitize::for_terminal`, and any occurrence of the exact
//! tunnel token is replaced by `*****` as a backstop to cloudflared's own masking.
//!
//! - Pure apart from [`log`], which writes under the `yaran::cloudflare` target.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/cloudflared/log_lines.rs
//! └── sanitize
//! External: serde_json, tracing
//!
//! Used by:
//! cloud/cloudflared/log_lines.rs
//! ├── cloud::cloudflared
//! ├── cloud::cloudflared::supervisor
//! └── cloud::leg_run
//! <module-headers:end>

/// Longest stderr line kept; the rest is dropped.
pub const MAX_LINE_BYTES: usize = 16 * 1024;

/// What a line means to the leg.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogSignal {
    /// `Registered tunnel connection`: one edge connection is up.
    Registered,
    /// The edge refused the token. cloudflared retries this forever rather than exiting.
    Unauthorized,
    Other,
}

/// cloudflared's level, mapped one to one onto `tracing`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineLevel {
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedLine {
    pub level: LineLevel,
    pub message: String,
    pub error: Option<String>,
    pub signal: LogSignal,
}

fn clean(text: &str, token: &str) -> String {
    let redacted = if token.is_empty() {
        text.to_string()
    } else {
        text.replace(token, "*****")
    };
    crate::sanitize::for_terminal(&redacted)
}

/// Parse one raw stderr line.
pub fn parse_line(raw: &[u8], token: &str) -> ParsedLine {
    let cut = &raw[..raw.len().min(MAX_LINE_BYTES)];
    let text = String::from_utf8_lossy(cut);
    let text = text.trim_end();
    let Ok(serde_json::Value::Object(obj)) = serde_json::from_str::<serde_json::Value>(text) else {
        return ParsedLine {
            level: LineLevel::Warn,
            message: clean(text, token),
            error: None,
            signal: LogSignal::Other,
        };
    };
    let field = |key: &str| {
        obj.get(key)
            .and_then(|v| v.as_str())
            .map(|s| clean(s, token))
    };
    let message = field("message").unwrap_or_default();
    let error = field("error");
    let level = match obj.get("level").and_then(|v| v.as_str()).unwrap_or("info") {
        "debug" | "trace" => LineLevel::Debug,
        "warn" | "warning" => LineLevel::Warn,
        "error" | "fatal" | "panic" => LineLevel::Error,
        _ => LineLevel::Info,
    };
    let signal = if error.as_deref().is_some_and(|e| e.contains("Unauthorized")) {
        LogSignal::Unauthorized
    } else if message.starts_with("Registered tunnel connection") {
        LogSignal::Registered
    } else {
        LogSignal::Other
    };
    ParsedLine {
        level,
        message,
        error,
        signal,
    }
}

/// Write the line to `yaran.log`.
pub fn log(line: &ParsedLine) {
    let error = line.error.as_deref().unwrap_or("");
    match line.level {
        LineLevel::Debug => tracing::debug!(target: "yaran::cloudflare", error, "{}", line.message),
        LineLevel::Info => tracing::info!(target: "yaran::cloudflare", error, "{}", line.message),
        LineLevel::Warn => tracing::warn!(target: "yaran::cloudflare", error, "{}", line.message),
        LineLevel::Error => tracing::error!(target: "yaran::cloudflare", error, "{}", line.message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_registered_and_unauthorized() {
        let reg = parse_line(
            br#"{"connIndex":0,"message":"Registered tunnel connection","level":"info"}"#,
            "",
        );
        assert_eq!(
            (reg.signal, reg.level),
            (LogSignal::Registered, LineLevel::Info)
        );
        let unauth = parse_line(
            br#"{"level":"error","error":"Unauthorized: Invalid tunnel secret","message":"Register tunnel error from server side"}"#,
            "",
        );
        assert_eq!(unauth.signal, LogSignal::Unauthorized);
        assert_eq!(unauth.level, LineLevel::Error);
        assert_eq!(
            parse_line(br#"{"message":"hello"}"#, "").signal,
            LogSignal::Other
        );
    }

    #[test]
    fn redacts_the_token_and_strips_escapes() {
        let line = parse_line(
            b"{\"level\":\"warn\",\"message\":\"token sekrit-token \\u001b[31mred\"}",
            "sekrit-token",
        );
        assert!(!line.message.contains("sekrit-token"), "{}", line.message);
        assert!(line.message.contains("*****"));
        assert!(!line.message.contains('\u{1b}'));
    }

    #[test]
    fn plain_text_is_a_sanitized_warning() {
        let line = parse_line(b"flag provided but not defined: -x\x1b]0;evil\x07\n", "");
        assert_eq!(line.level, LineLevel::Warn);
        assert!(!line.message.contains('\u{7}'));
        assert!(line.message.starts_with("flag provided"));
    }

    #[test]
    fn oversize_lines_are_cut() {
        let long = vec![b'a'; MAX_LINE_BYTES * 2];
        assert!(parse_line(&long, "").message.len() <= MAX_LINE_BYTES);
    }
}
