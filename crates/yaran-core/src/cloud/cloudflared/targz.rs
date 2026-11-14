//! A minimal `.tgz` reader for the darwin cloudflared asset: one regular file named
//! `cloudflared`, nothing else.
//!
//! The extracted binary's SHA-256 is the trust anchor, so this reader only has to refuse
//! shapes that could write anything but that one file: a second member, a link, a device,
//! a directory, or an oversize member. pax header records (`x`/`g`) are metadata and are
//! skipped; their contents are never applied.
//!
//! - Pure over a `Read`/`Write` pair; no filesystem access of its own.
//!
//! <module-headers:begin>
//! Uses: none
//! External: flate2, std
//!
//! Used by:
//! cloud/cloudflared/targz.rs
//! ├── cloud::cloudflared
//! ├── cloud::cloudflared::acquire
//! └── cloud::cloudflared::acquire::tests
//! <module-headers:end>

use std::io::{Read, Write};

const BLOCK: usize = 512;

/// Why an archive was refused.
#[derive(Debug, PartialEq, Eq)]
pub enum TarError {
    Io(String),
    /// Something other than one regular `cloudflared` file.
    UnexpectedEntry(String),
    /// The member is larger than the cap.
    TooLarge,
    /// The archive ended before a `cloudflared` member was found.
    Missing,
}

impl std::fmt::Display for TarError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "the archive could not be read ({e})"),
            Self::UnexpectedEntry(what) => write!(f, "the archive holds an unexpected {what}"),
            Self::TooLarge => f.write_str("the archive's binary is larger than yaran accepts"),
            Self::Missing => f.write_str("the archive holds no cloudflared binary"),
        }
    }
}

fn io(err: std::io::Error) -> TarError {
    TarError::Io(err.to_string())
}

/// Decompress `gz`, copy its one `cloudflared` member into `out`, and answer its length.
pub fn extract_cloudflared(gz: impl Read, out: &mut impl Write, cap: u64) -> Result<u64, TarError> {
    let mut tar = flate2::read::GzDecoder::new(gz);
    let mut header = [0u8; BLOCK];
    let mut found: Option<u64> = None;
    loop {
        if !read_block(&mut tar, &mut header)? || header.iter().all(|b| *b == 0) {
            return found.ok_or(TarError::Missing);
        }
        let size =
            octal(&header[124..136]).ok_or_else(|| TarError::UnexpectedEntry("header".into()))?;
        let padded = size.div_ceil(BLOCK as u64) * BLOCK as u64;
        match header[156] {
            b'x' | b'g' => {
                skip(&mut tar, padded)?;
                continue;
            }
            b'0' | 0 => {}
            other => {
                return Err(TarError::UnexpectedEntry(format!(
                    "entry of type {:?}",
                    other as char
                )));
            }
        }
        let name = entry_name(&header);
        if found.is_some() || (name != "cloudflared" && name != "./cloudflared") {
            return Err(TarError::UnexpectedEntry(format!(
                "member {:?}",
                crate::sanitize::for_terminal(&name)
            )));
        }
        if size > cap {
            return Err(TarError::TooLarge);
        }
        let copied = std::io::copy(&mut (&mut tar).take(size), out).map_err(io)?;
        if copied != size {
            return Err(TarError::Io("truncated member".into()));
        }
        skip(&mut tar, padded - size)?;
        found = Some(size);
    }
}

/// Read one block; `false` at a clean end of stream.
fn read_block(r: &mut impl Read, buf: &mut [u8; BLOCK]) -> Result<bool, TarError> {
    let mut filled = 0;
    while filled < BLOCK {
        match r.read(&mut buf[filled..]).map_err(io)? {
            0 if filled == 0 => return Ok(false),
            0 => return Err(TarError::Io("truncated header".into())),
            n => filled += n,
        }
    }
    Ok(true)
}

fn skip(r: &mut impl Read, n: u64) -> Result<(), TarError> {
    let skipped = std::io::copy(&mut r.take(n), &mut std::io::sink()).map_err(io)?;
    if skipped == n {
        Ok(())
    } else {
        Err(TarError::Io("truncated archive".into()))
    }
}

/// ustar name, with the `prefix` field joined when present.
fn entry_name(h: &[u8; BLOCK]) -> String {
    let field = |b: &[u8]| {
        let end = b.iter().position(|c| *c == 0).unwrap_or(b.len());
        String::from_utf8_lossy(&b[..end]).into_owned()
    };
    let name = field(&h[0..100]);
    let prefix = if &h[257..262] == b"ustar" {
        field(&h[345..500])
    } else {
        String::new()
    };
    if prefix.is_empty() {
        name
    } else {
        format!("{prefix}/{name}")
    }
}

fn octal(field: &[u8]) -> Option<u64> {
    let text = std::str::from_utf8(field).ok()?;
    let digits = text.trim_matches(|c: char| c == '\0' || c == ' ');
    if digits.is_empty() {
        return Some(0);
    }
    u64::from_str_radix(digits, 8).ok()
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::BLOCK;
    use std::io::Write;

    /// A gzip'd tar of `(name, type, body)` members.
    pub(crate) fn tgz(members: &[(&str, u8, &[u8])]) -> Vec<u8> {
        let mut tar = Vec::new();
        for (name, kind, body) in members {
            let mut h = [0u8; BLOCK];
            h[..name.len()].copy_from_slice(name.as_bytes());
            h[100..107].copy_from_slice(b"0000755");
            h[124..135].copy_from_slice(format!("{:011o}", body.len()).as_bytes());
            h[156] = *kind;
            h[257..262].copy_from_slice(b"ustar");
            tar.extend_from_slice(&h);
            tar.extend_from_slice(body);
            tar.resize(tar.len().div_ceil(BLOCK) * BLOCK, 0);
        }
        tar.extend_from_slice(&[0u8; BLOCK * 2]);
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        gz.write_all(&tar).unwrap();
        gz.finish().unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::tgz;
    use super::*;

    #[test]
    fn extracts_the_one_binary() {
        let archive = tgz(&[("cloudflared", b'0', b"#!/bin/sh\necho hi\n")]);
        let mut out = Vec::new();
        assert_eq!(extract_cloudflared(&archive[..], &mut out, 1024), Ok(18));
        assert_eq!(out, b"#!/bin/sh\necho hi\n");
    }

    #[test]
    fn skips_pax_metadata() {
        let archive = tgz(&[
            ("pax", b'x', b"30 path=evil\n"),
            ("cloudflared", b'0', b"x"),
        ]);
        let mut out = Vec::new();
        assert_eq!(extract_cloudflared(&archive[..], &mut out, 1024), Ok(1));
    }

    #[test]
    fn refuses_every_other_shape() {
        type Member<'a> = (&'a str, u8, &'a [u8]);
        type Case<'a> = (&'a [Member<'a>], fn(&TarError) -> bool);
        let cases: [Case; 5] = [
            (
                &[("cloudflared", b'0', b"a"), ("cloudflared", b'0', b"b")],
                |e| matches!(e, TarError::UnexpectedEntry(_)),
            ),
            (&[("cloudflared", b'2', b"")], |e| {
                matches!(e, TarError::UnexpectedEntry(_))
            }),
            (&[("other", b'0', b"a")], |e| {
                matches!(e, TarError::UnexpectedEntry(_))
            }),
            (&[("cloudflared", b'0', &[7u8; 2048])], |e| {
                *e == TarError::TooLarge
            }),
            (&[], |e| *e == TarError::Missing),
        ];
        for (members, expected) in cases {
            let mut out = Vec::new();
            let err = extract_cloudflared(&tgz(members)[..], &mut out, 1024).unwrap_err();
            assert!(expected(&err), "{err:?}");
        }
    }

    #[test]
    fn a_truncated_archive_is_an_error() {
        let archive = tgz(&[("cloudflared", b'0', &[1u8; 900])]);
        let mut out = Vec::new();
        assert!(extract_cloudflared(&archive[..archive.len() / 2], &mut out, 4096).is_err());
    }
}
