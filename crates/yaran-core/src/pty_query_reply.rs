//! Telling a terminal's automatic answers apart from input.
//!
//! Every terminal attached to a PTY answers the queries the child prints
//! (where is the cursor, what are you, is this mode set), so with several
//! attached the child would get one answer per terminal. The size registry
//! forwards only the size holder's (see
//! [`crate::pty_owners::PtySizeOwners::note_write`]), which needs these
//! answers recognised without ever mistaking a keystroke for one.

/// Whether `bytes` is nothing but one or more complete terminal query replies.
///
/// The rule is the reply's whole shape, never a prefix, so it cannot swallow a
/// keystroke: a lone `ESC P` or `ESC ]` is an Alt chord, and only a string
/// sequence closed by its terminator counts. Recognised:
///
///   - `CSI ? … R` (DECXCPR) and `CSI row ; col R` (CPR), EXCEPT `CSI 1 ; m R`
///     with `m` in 2..=16, which is also xterm's modified F3 and stays a key
///   - `CSI ? … c` and `CSI > … c` (primary and secondary device attributes)
///   - `CSI … $ y` and `CSI ? … $ y` (DECRQM)
///   - `CSI … n` (device status) and `CSI … t` (window reports)
///   - `CSI ? … u` (keyboard protocol flags)
///   - `OSC … BEL` / `OSC … ST` and `DCS … ST` with a body
///
/// No key xterm.js sends ends a CSI in `c`, `n`, `t` or `y`, or carries `?`
/// or `>` before a final `R`, `c` or `u`.
pub fn is_query_reply(bytes: &[u8]) -> bool {
    let mut rest = bytes;
    while !rest.is_empty() {
        match take_query_reply(rest) {
            Some(tail) => rest = tail,
            None => return false,
        }
    }
    true
}

/// [`crate::pty::classify_pty_write`] for bytes typed at this machine's own
/// keyboard, the terminal UI's write path: its embedded emulator answers the
/// child's queries itself and never through the keyboard, so a batch of real
/// keys shaped like a reply (Alt-Shift-P … Alt-\\, rxvt's Shift-Insert
/// `ESC [ 2 $ y`) is typing there.
pub fn classify_keyboard_write(bytes: &[u8]) -> crate::pty::PtyWriteKind {
    match crate::pty::classify_pty_write(bytes) {
        crate::pty::PtyWriteKind::QueryReply => crate::pty::PtyWriteKind::Typing,
        kind => kind,
    }
}

/// One complete reply off the front of `bytes`, returning the remainder.
fn take_query_reply(bytes: &[u8]) -> Option<&[u8]> {
    if let Some(body) = bytes.strip_prefix(b"\x1b[") {
        return take_csi_reply(body);
    }
    let (body, osc) = match bytes {
        [0x1b, b']', body @ ..] => (body, true),
        [0x1b, b'P', body @ ..] => (body, false),
        _ => return None,
    };
    let end = (0..body.len()).find(|&i| {
        (osc && body[i] == 0x07) || (body[i] == 0x1b && body.get(i + 1) == Some(&b'\\'))
    })?;
    if end == 0 {
        return None;
    }
    let after = if body[end] == 0x07 { end + 1 } else { end + 2 };
    Some(&body[after..])
}

/// A CSI reply's parameters and final byte, after the `ESC [`.
fn take_csi_reply(body: &[u8]) -> Option<&[u8]> {
    let (marker, body) = match body.first() {
        Some(&m @ (b'?' | b'>')) => (Some(m), &body[1..]),
        _ => (None, body),
    };
    let params_len = body
        .iter()
        .position(|b| !(b.is_ascii_digit() || *b == b';'))?;
    let params = &body[..params_len];
    let tail = &body[params_len..];
    let (dollar, tail) = match tail.strip_prefix(b"$") {
        Some(tail) => (true, tail),
        None => (false, tail),
    };
    let (&last, rest) = tail.split_first()?;
    let reply = match (marker, dollar, last) {
        (None, false, b'n' | b't') => !params.is_empty(),
        (None, false, b'R') => is_cursor_report(params),
        shape => matches!(
            shape,
            (None | Some(b'?'), true, b'y')
                | (Some(b'?'), false, b'R' | b'c' | b'u')
                | (Some(b'>'), false, b'c')
        ),
    };
    reply.then_some(rest)
}

/// Whether CPR parameters are a cursor report rather than xterm's modified F3
/// (`CSI 1 ; m R`, `m` the modifier code 2..=16).
fn is_cursor_report(params: &[u8]) -> bool {
    let mut fields = params.split(|b| *b == b';');
    let (Some(row), Some(col), None) = (fields.next(), fields.next(), fields.next()) else {
        return false;
    };
    let number = |field: &[u8]| -> Option<u32> {
        if field.is_empty() || field.len() > 9 {
            return None;
        }
        std::str::from_utf8(field).ok()?.parse().ok()
    };
    match (number(row), number(col)) {
        (Some(1), Some(modifier)) => !(2..=16).contains(&modifier),
        (Some(_), Some(_)) => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use crate::pty::{PtyWriteKind, classify_pty_write};

    /// Keys typed at the terminal UI are never a query reply, whatever their
    /// shape, while focus reports stay ignored there too.
    #[test]
    fn reply_shaped_keyboard_bytes_are_typing() {
        for bytes in [&b"\x1bPp\x1b\\"[..], b"\x1b[2$y", b"\x1b[12;40R"] {
            assert_eq!(classify_pty_write(bytes), PtyWriteKind::QueryReply);
            assert_eq!(
                super::classify_keyboard_write(bytes),
                PtyWriteKind::Typing,
                "{bytes:?}"
            );
        }
        assert_eq!(
            super::classify_keyboard_write(b"\x1b[I"),
            PtyWriteKind::Ignored
        );
    }

    /// The answers xterm.js sends by itself to a child's queries are told apart
    /// from input, so only the size holder's answer reaches the child.
    #[test]
    fn query_replies_are_classified_as_such() {
        for bytes in [
            &b"\x1b[12;40R"[..],                 // cursor position report
            b"\x1b[1;1R",                        // CPR at the origin
            b"\x1b[1;17R",                       // CPR past any modifier code
            b"\x1b[?12;40R",                     // DECXCPR
            b"\x1b[?1;2c",                       // primary device attributes
            b"\x1b[>0;276;0c",                   // secondary device attributes
            b"\x1b[?2004;1$y",                   // DECRQM, private mode
            b"\x1b[4;2$y",                       // DECRQM, ANSI mode
            b"\x1b[0n",                          // device status
            b"\x1b[8;24;80t",                    // window size report
            b"\x1b[?0u",                         // keyboard flags
            b"\x1b]11;rgb:0000/0000/0000\x1b\\", // OSC color, ST
            b"\x1b]10;rgb:ffff/ffff/ffff\x07",   // OSC color, BEL
            b"\x1bP1$r0m\x1b\\",                 // DECRQSS
            b"\x1bP!|00000000\x1b\\",            // DA3
            b"\x1b[12;40R\x1b[?1;2c",            // two replies in one write
        ] {
            assert_eq!(
                classify_pty_write(bytes),
                PtyWriteKind::QueryReply,
                "{bytes:?} is a query reply"
            );
        }
    }

    /// A query reply is recognised by its whole shape, so no real keystroke is
    /// ever swallowed as one: Escape, arrows, function keys (xterm's modified
    /// F3 shares CPR's shape), Alt chords on the string introducers, and text.
    #[test]
    fn no_real_keystroke_is_a_query_reply() {
        let mut keys: Vec<Vec<u8>> = vec![
            b"\x1b".to_vec(),                   // Escape
            b"\x1b[A".to_vec(),                 // Up
            b"\x1b[1;5C".to_vec(),              // Ctrl-Right
            b"\x1bOR".to_vec(),                 // F3
            b"\x1b[15~".to_vec(),               // F5
            b"\x1b[15;2~".to_vec(),             // Shift-F5
            b"\x1b[Z".to_vec(),                 // Shift-Tab
            b"\x1bP".to_vec(),                  // Alt-Shift-p, the DCS introducer
            b"\x1b]".to_vec(),                  // Alt-], the OSC introducer
            b"\x1b[".to_vec(),                  // Alt-[
            b"\x1bc".to_vec(),                  // Alt-c
            b"\x1b[200~text\x1b[201~".to_vec(), // bracketed paste
            b"n".to_vec(),
            b"hello world\r".to_vec(),
            b"\x1b[97;5u".to_vec(), // a CSI-u key, no private marker
        ];
        // Every modifier code xterm puts on F3, the one CPR look-alike.
        for modifier in 2..=16 {
            keys.push(format!("\x1b[1;{modifier}R").into_bytes());
        }
        for key in keys {
            assert_eq!(
                classify_pty_write(&key),
                PtyWriteKind::Typing,
                "{key:?} is a keystroke"
            );
        }
    }
}
