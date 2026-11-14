//! Same-origin comparison of an `Origin` header against the request's `Host` (Phase 11 §3).
//!
//! Compares canonical authorities rather than raw strings, so harmless spelling
//! differences (host case, one trailing dot, the scheme's default port written out) no
//! longer fail, while everything the raw comparison rejected still fails: a different
//! port stays a mismatch (a page on another local port must not mutate yaran), and a
//! `null`, scheme-less or malformed Origin is a mismatch.
//!
//! - Trust boundary: both headers are attacker input; anything unparseable is a mismatch.
//!
//! <module-headers:begin>
//! Uses: none
//! External: none
//!
//! Used by:
//! origin_match.rs
//! └── server
//! <module-headers:end>

/// `host` (ASCII-lowercased, one trailing dot dropped, IPv6 kept bracketed) and the port
/// as written, or `None` when the authority is malformed.
fn split_authority(authority: &str) -> Option<(String, Option<u16>)> {
    if authority.is_empty() || authority.contains('@') {
        return None;
    }
    let (host, port) = if let Some(rest) = authority.strip_prefix('[') {
        let (inner, after) = rest.split_once(']')?;
        if inner.is_empty() || inner.contains(['[', ']']) {
            return None;
        }
        let port = match after {
            "" => None,
            p => Some(p.strip_prefix(':')?),
        };
        (format!("[{inner}]"), port)
    } else {
        if authority.contains(['[', ']']) {
            return None;
        }
        match authority.split_once(':') {
            Some((h, p)) => (h.to_string(), Some(p)),
            None => (authority.to_string(), None),
        }
    };
    let port = match port {
        None => None,
        Some(p) if !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) => Some(p.parse().ok()?),
        Some(_) => return None,
    };
    let host = host.to_ascii_lowercase();
    let host = host.strip_suffix('.').unwrap_or(&host).to_string();
    (!host.is_empty()).then_some((host, port))
}

fn default_port(scheme: &str) -> Option<u16> {
    match scheme {
        "https" | "wss" => Some(443),
        "http" | "ws" => Some(80),
        _ => None,
    }
}

/// Whether `origin` (`scheme://authority`) names the same authority as the `Host`
/// header, with the default port of the ORIGIN's scheme dropped from both sides.
pub(crate) fn same_origin(origin: &str, host: &str) -> bool {
    let Some((scheme, rest)) = origin.split_once("://") else {
        return false;
    };
    let scheme = scheme.to_ascii_lowercase();
    // An Origin carries no path, but stay defensive about one.
    let authority = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    let (Some(o), Some(h)) = (split_authority(authority), split_authority(host.trim())) else {
        return false;
    };
    let effective = |port: Option<u16>| port.filter(|p| Some(*p) != default_port(&scheme));
    o.0 == h.0 && effective(o.1) == effective(h.1)
}

#[cfg(test)]
mod tests {
    use super::same_origin;

    #[test]
    fn the_phase_11_table_holds() {
        let equal = [
            ("https://Alice.Zone", "alice.zone:443"),
            ("https://alice.zone", "alice.zone"),
            ("http://localhost:3890", "localhost:3890"),
            ("http://[::1]:3890", "[::1]:3890"),
            ("http://[::1]", "[::1]:80"),
            ("https://alice.zone.", "alice.zone"),
            ("https://alice.zone", "Alice.Zone.:443"),
            ("HTTPS://alice.zone:443", "alice.zone"),
            ("http://127.0.0.1:3890", "127.0.0.1:3890"),
        ];
        for (origin, host) in equal {
            assert!(same_origin(origin, host), "{origin} vs {host} should match");
        }
        let mismatch = [
            ("https://alice.zone:8443", "alice.zone"),
            ("http://localhost:8000", "localhost:3890"),
            ("https://alice.zone", "alice.zone:80"),
            ("http://alice.zone", "alice.zone:443"),
            ("http://[::1]:3890", "[::1]:3891"),
            ("https://user@alice.zone", "alice.zone"),
            ("https://alice.zone", "user@alice.zone"),
            ("null", "alice.zone"),
            ("", "alice.zone"),
            ("alice.zone", "alice.zone"),
            ("https://", "alice.zone"),
            ("https://alice.zone", ""),
            ("http://[::1:3890", "[::1]:3890"),
            ("http://localhost:38a0", "localhost:38a0"),
            ("http://localhost:", "localhost"),
            ("http://localhost:99999", "localhost:99999"),
            ("https://evil.example", "alice.zone"),
        ];
        for (origin, host) in mismatch {
            assert!(
                !same_origin(origin, host),
                "{origin} vs {host} should not match"
            );
        }
    }

    #[test]
    fn an_unknown_scheme_keeps_every_port() {
        assert!(same_origin("custom://box:7", "box:7"));
        assert!(!same_origin("custom://box", "box:443"));
    }
}
