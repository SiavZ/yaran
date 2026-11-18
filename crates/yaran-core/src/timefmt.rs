//! The timestamp text yaran writes and reads, pinned byte for byte.
//!
//! yaran stores timestamps in SQLite as RFC 3339 text and compares them as
//! text, writes them into JSON files and board notes, and sends them to the
//! browser. Those strings were first written by chrono, so new ones must keep
//! chrono's exact shape or old and new rows would stop sorting together:
//! the fraction is 0, 3, 6 or 9 digits (whichever shows every non-zero digit)
//! and the offset is `+00:00`, or `Z` in the serde and board forms. jiff's own
//! `Display` trims the fraction to the shortest form, so every persisted or
//! sent timestamp goes through this module instead. The tests pin the strings
//! chrono produced before the switch to jiff.

use std::fmt::Write as _;

use jiff::civil;
use jiff::tz::{AmbiguousOffset, Offset, TimeZone};
use jiff::{Timestamp, Zoned};

/// The RFC 3339 forms yaran persists and sends.
pub trait Rfc3339 {
    /// The wall-clock time and its offset east of UTC, in seconds.
    fn wall_and_offset(&self) -> (civil::DateTime, i32);

    /// `2026-01-02T03:04:05.123+00:00`: the fraction shows every non-zero
    /// digit in groups of three, and the offset is always numeric.
    fn to_rfc3339(&self) -> String {
        render(self.wall_and_offset(), Form::Numeric)
    }

    /// The same with `Z` for a zero offset, which is also the serde form.
    fn to_rfc3339_z(&self) -> String {
        render(self.wall_and_offset(), Form::Zulu)
    }

    /// Whole seconds, `Z` for a zero offset: `2026-01-02T03:04:05Z`. A
    /// fraction is dropped, never rounded.
    fn to_rfc3339_secs_z(&self) -> String {
        render(self.wall_and_offset(), Form::SecondsZulu)
    }
}

impl Rfc3339 for Timestamp {
    fn wall_and_offset(&self) -> (civil::DateTime, i32) {
        (Offset::UTC.to_datetime(*self), 0)
    }
}

/// A local time keeps its own offset, as chrono's `DateTime<Local>` did.
impl Rfc3339 for Zoned {
    fn wall_and_offset(&self) -> (civil::DateTime, i32) {
        (self.datetime(), self.offset().seconds())
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Form {
    Numeric,
    Zulu,
    SecondsZulu,
}

fn render((at, offset_seconds): (civil::DateTime, i32), form: Form) -> String {
    let mut out = format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
        at.year(),
        at.month(),
        at.day(),
        at.hour(),
        at.minute(),
        at.second()
    );
    let nanos = at.subsec_nanosecond();
    if form != Form::SecondsZulu && nanos != 0 {
        let _ = if nanos % 1_000_000 == 0 {
            write!(out, ".{:03}", nanos / 1_000_000)
        } else if nanos % 1_000 == 0 {
            write!(out, ".{:06}", nanos / 1_000)
        } else {
            write!(out, ".{nanos:09}")
        };
    }
    if form != Form::Numeric && offset_seconds == 0 {
        out.push('Z');
    } else {
        // Whole minutes, rounded to the nearest, as chrono wrote them.
        let sign = if offset_seconds < 0 { '-' } else { '+' };
        let minutes = (offset_seconds.unsigned_abs() + 30) / 60;
        let _ = write!(out, "{sign}{:02}:{:02}", minutes / 60, minutes % 60);
    }
    out
}

/// Read an RFC 3339 timestamp with `Z` or any numeric offset, with or without
/// a fraction, and a `T`, `t` or space between the date and the time.
///
/// # Errors
///
/// Fails when the text is not a timestamp with an offset.
pub fn parse_rfc3339(text: &str) -> Result<Timestamp, jiff::Error> {
    text.parse()
}

/// The earliest instant a wall-clock time names in `tz`: the earlier of the
/// two in a fold, and none at all in a gap, where that wall-clock time never
/// happens. This differs from chrono 0.4.44's `Local` `.earliest()`, which
/// picked the later instant in a fold and accepted the first minute of a gap.
pub fn earliest(tz: &TimeZone, at: civil::DateTime) -> Option<Timestamp> {
    let ambiguous = tz.to_ambiguous_timestamp(at);
    match ambiguous.offset() {
        AmbiguousOffset::Gap { .. } => None,
        AmbiguousOffset::Unambiguous { .. } | AmbiguousOffset::Fold { .. } => {
            ambiguous.earlier().ok()
        }
    }
}

/// A UTC instant from its calendar fields, for fixed instants in code and
/// tests.
///
/// # Panics
///
/// Panics when the fields do not name a real instant.
pub fn utc(year: i16, month: i8, day: i8, hour: i8, minute: i8, second: i8) -> Timestamp {
    civil::datetime(year, month, day, hour, minute, second, 0)
        .to_zoned(TimeZone::UTC)
        .expect("a UTC calendar instant")
        .timestamp()
}

/// `#[serde(with = "...")]` for a [`Timestamp`] field, in the form
/// [`Rfc3339::to_rfc3339_z`] writes. Reading accepts any RFC 3339 offset.
pub mod serde_rfc3339 {
    use jiff::Timestamp;
    use serde::{Deserialize, Deserializer, Serializer, de::Error as _};

    use super::Rfc3339;

    /// # Errors
    ///
    /// Whatever the serializer returns.
    pub fn serialize<S: Serializer>(at: &Timestamp, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&at.to_rfc3339_z())
    }

    /// # Errors
    ///
    /// Fails on anything but a timestamp string.
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Timestamp, D::Error> {
        let text = std::borrow::Cow::<str>::deserialize(deserializer)?;
        super::parse_rfc3339(&text).map_err(D::Error::custom)
    }

    /// The same for an `Option<Timestamp>` field; `None` is `null`.
    pub mod option {
        use jiff::Timestamp;
        use serde::{Deserialize, Deserializer, Serializer, de::Error as _};

        /// # Errors
        ///
        /// Whatever the serializer returns.
        pub fn serialize<S: Serializer>(
            at: &Option<Timestamp>,
            serializer: S,
        ) -> Result<S::Ok, S::Error> {
            match at {
                Some(at) => super::serialize(at, serializer),
                None => serializer.serialize_none(),
            }
        }

        /// # Errors
        ///
        /// Fails on anything but a timestamp string or `null`.
        pub fn deserialize<'de, D: Deserializer<'de>>(
            deserializer: D,
        ) -> Result<Option<Timestamp>, D::Error> {
            Option::<std::borrow::Cow<'_, str>>::deserialize(deserializer)?
                .map(|text| super::super::parse_rfc3339(&text).map_err(D::Error::custom))
                .transpose()
        }
    }
}

#[cfg(test)]
mod tests {
    //! Every expected string below is what chrono 0.4 produced for the same
    //! instant before yaran moved to jiff; none may change.

    use super::*;
    use jiff::SignedDuration;
    use serde::{Deserialize, Serialize};

    fn at(nanos: u32) -> Timestamp {
        utc(2026, 1, 2, 3, 4, 5) + SignedDuration::from_nanos(i64::from(nanos))
    }
    const SUBSECS: [u32; 6] = [0, 500_000_000, 123_000_000, 123_456_000, 123_456_789, 100];

    #[test]
    fn rfc3339() {
        let got: Vec<String> = SUBSECS.iter().map(|n| at(*n).to_rfc3339()).collect();
        assert_eq!(
            got,
            [
                "2026-01-02T03:04:05+00:00",
                "2026-01-02T03:04:05.500+00:00",
                "2026-01-02T03:04:05.123+00:00",
                "2026-01-02T03:04:05.123456+00:00",
                "2026-01-02T03:04:05.123456789+00:00",
                "2026-01-02T03:04:05.000000100+00:00",
            ]
        );
    }

    #[test]
    fn rfc3339_z() {
        let got: Vec<String> = SUBSECS.iter().map(|n| at(*n).to_rfc3339_z()).collect();
        assert_eq!(
            got,
            [
                "2026-01-02T03:04:05Z",
                "2026-01-02T03:04:05.500Z",
                "2026-01-02T03:04:05.123Z",
                "2026-01-02T03:04:05.123456Z",
                "2026-01-02T03:04:05.123456789Z",
                "2026-01-02T03:04:05.000000100Z",
            ]
        );
    }

    #[test]
    fn rfc3339_secs_z() {
        for n in SUBSECS {
            assert_eq!(at(n).to_rfc3339_secs_z(), "2026-01-02T03:04:05Z");
            assert_eq!(
                at(n).strftime("%Y-%m-%dT%H:%M:%SZ").to_string(),
                "2026-01-02T03:04:05Z"
            );
        }
    }

    #[test]
    fn before_1970_keeps_its_fraction() {
        let early = utc(1969, 12, 31, 23, 59, 59) + SignedDuration::from_millis(250);
        assert_eq!(early.to_rfc3339(), "1969-12-31T23:59:59.250+00:00");
    }

    #[derive(Serialize, Deserialize, Debug, PartialEq)]
    struct Pinned {
        #[serde(with = "serde_rfc3339")]
        at: Timestamp,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            with = "serde_rfc3339::option"
        )]
        maybe: Option<Timestamp>,
    }

    #[test]
    fn serde_form() {
        let got: Vec<String> = SUBSECS
            .iter()
            .map(|n| {
                serde_json::to_string(&Pinned {
                    at: at(*n),
                    maybe: Some(at(*n)),
                })
                .unwrap()
            })
            .collect();
        assert_eq!(
            got,
            [
                r#"{"at":"2026-01-02T03:04:05Z","maybe":"2026-01-02T03:04:05Z"}"#,
                r#"{"at":"2026-01-02T03:04:05.500Z","maybe":"2026-01-02T03:04:05.500Z"}"#,
                r#"{"at":"2026-01-02T03:04:05.123Z","maybe":"2026-01-02T03:04:05.123Z"}"#,
                r#"{"at":"2026-01-02T03:04:05.123456Z","maybe":"2026-01-02T03:04:05.123456Z"}"#,
                r#"{"at":"2026-01-02T03:04:05.123456789Z","maybe":"2026-01-02T03:04:05.123456789Z"}"#,
                r#"{"at":"2026-01-02T03:04:05.000000100Z","maybe":"2026-01-02T03:04:05.000000100Z"}"#,
            ]
        );
        assert_eq!(
            serde_json::to_string(&Pinned {
                at: at(0),
                maybe: None
            })
            .unwrap(),
            r#"{"at":"2026-01-02T03:04:05Z"}"#
        );
        for (text, nanos) in [
            (r#"{"at":"2026-01-02T03:04:05Z"}"#, 0),
            (r#"{"at":"2026-01-02T03:04:05+00:00"}"#, 0),
            (r#"{"at":"2026-01-02T05:04:05.5+02:00"}"#, 500_000_000),
            (r#"{"at":"2026-01-02T03:04:05.123456789Z"}"#, 123_456_789),
            (r#"{"at":"2026-01-02 03:04:05Z"}"#, 0),
        ] {
            let read: Pinned = serde_json::from_str(text).unwrap();
            assert_eq!(
                read,
                Pinned {
                    at: at(nanos),
                    maybe: None
                },
                "{text}"
            );
        }
        let read: Pinned =
            serde_json::from_str(r#"{"at":"2026-01-02T03:04:05Z","maybe":null}"#).unwrap();
        assert_eq!(read.maybe, None);
        assert!(serde_json::from_str::<Pinned>(r#"{"at":"yesterday"}"#).is_err());
    }

    #[test]
    fn parse_rfc3339_accepts_what_chrono_did() {
        for (text, nanos) in [
            ("2026-01-02T03:04:05Z", 0),
            ("2026-01-02T03:04:05z", 0),
            ("2026-01-02t03:04:05Z", 0),
            ("2026-01-02 03:04:05Z", 0),
            ("2026-01-02T03:04:05+00:00", 0),
            ("2026-01-02T03:04:05-00:00", 0),
            ("2026-01-02T08:34:05+05:30", 0),
            ("2026-01-01T22:04:05.5-05:00", 500_000_000),
            ("2026-01-02T03:04:05.123456789Z", 123_456_789),
        ] {
            assert_eq!(parse_rfc3339(text).unwrap(), at(nanos), "{text}");
        }
        for text in ["", "2026-01-02", "2026-01-02T03:04:05", "not a time"] {
            assert!(parse_rfc3339(text).is_err(), "{text}");
        }
    }

    #[test]
    fn parse_rfc2822() {
        let parsed = jiff::fmt::rfc2822::parse("Fri, 02 Jan 2026 03:04:05 GMT")
            .unwrap()
            .timestamp();
        assert_eq!(parsed.to_rfc3339_secs_z(), "2026-01-02T03:04:05Z");
        let parsed = jiff::fmt::rfc2822::parse("Fri, 2 Jan 2026 05:04:05 +0200").unwrap();
        assert_eq!(parsed.timestamp(), at(0));
        assert!(jiff::fmt::rfc2822::parse("2026-01-02").is_err());
    }

    #[test]
    fn utc_patterns() {
        let t = at(123_456_789);
        for (pattern, want) in [
            ("%Y%m%dT%H%M%SZ", "20260102T030405Z"),
            ("%Y%m%d-%H%M%S", "20260102-030405"),
            ("%Y-%m-%d %H:%M UTC", "2026-01-02 03:04 UTC"),
            ("%Y-%m-%d %H:%M", "2026-01-02 03:04"),
            ("%Y-%m-%d %H:%M:%S", "2026-01-02 03:04:05"),
            ("%b %-d, %Y", "Jan 2, 2026"),
            ("%b %-d, %H:%M", "Jan 2, 03:04"),
            ("%H:%M", "03:04"),
            ("%H:%M:%S", "03:04:05"),
            ("%H:%M:%S%.3f", "03:04:05.123"),
        ] {
            assert_eq!(t.strftime(pattern).to_string(), want, "{pattern}");
            // The local-time sites format a `Zoned` with the same patterns.
            assert_eq!(
                t.to_zoned(TimeZone::UTC).strftime(pattern).to_string(),
                want,
                "{pattern}"
            );
        }
        assert_eq!(at(0).strftime("%H:%M:%S%.3f").to_string(), "03:04:05.000");
        let late = utc(2026, 12, 25, 23, 59, 59);
        assert_eq!(late.strftime("%b %-d, %Y").to_string(), "Dec 25, 2026");
    }

    #[test]
    fn a_local_time_keeps_its_offset() {
        let local = |offset_seconds: i32, nanos: i32| {
            civil::datetime(2026, 1, 2, 5, 4, 5, nanos)
                .to_zoned(TimeZone::fixed(
                    Offset::from_seconds(offset_seconds).unwrap(),
                ))
                .unwrap()
        };
        for (offset, nanos, want, want_z) in [
            (
                7200,
                0,
                "2026-01-02T05:04:05+02:00",
                "2026-01-02T05:04:05+02:00",
            ),
            (
                7200,
                123_000_000,
                "2026-01-02T05:04:05.123+02:00",
                "2026-01-02T05:04:05.123+02:00",
            ),
            (
                -19_800,
                123_456_789,
                "2026-01-02T05:04:05.123456789-05:30",
                "2026-01-02T05:04:05.123456789-05:30",
            ),
            (
                0,
                123_000_000,
                "2026-01-02T05:04:05.123+00:00",
                "2026-01-02T05:04:05.123Z",
            ),
            (
                5429,
                0,
                "2026-01-02T05:04:05+01:30",
                "2026-01-02T05:04:05+01:30",
            ),
            (
                5431,
                0,
                "2026-01-02T05:04:05+01:31",
                "2026-01-02T05:04:05+01:31",
            ),
        ] {
            assert_eq!(local(offset, nanos).to_rfc3339(), want);
            assert_eq!(local(offset, nanos).to_rfc3339_z(), want_z);
            assert_eq!(
                local(offset, nanos)
                    .strftime("%Y-%m-%d %H:%M:%S")
                    .to_string(),
                "2026-01-02 05:04:05"
            );
            assert_eq!(
                local(offset, nanos).strftime("%b %-d, %H:%M").to_string(),
                "Jan 2, 05:04"
            );
        }
    }

    #[test]
    fn naive_parsing() {
        for (text, ok) in [
            ("2026-01-02", true),
            ("2026-1-2", true),
            ("2026-02-30", false),
            ("2026-01-02x", false),
        ] {
            assert_eq!(
                civil::Date::strptime("%Y-%m-%d", text).is_ok(),
                ok,
                "{text}"
            );
        }
        for (text, format, ok) in [
            ("2026-01-02T03:04:05", "%Y-%m-%dT%H:%M:%S", true),
            ("2026-01-02T03:04", "%Y-%m-%dT%H:%M", true),
            ("2026-01-02 03:04:05", "%Y-%m-%d %H:%M:%S", true),
            ("2026-01-02 03:04", "%Y-%m-%d %H:%M", true),
            ("2026-01-02T3:4:5", "%Y-%m-%dT%H:%M:%S", true),
            ("2026-01-02T03:04:05Z", "%Y-%m-%dT%H:%M:%SZ", true),
            ("2026-01-02T03:04:60Z", "%Y-%m-%dT%H:%M:%SZ", true),
            ("2026-01-02T24:04:05Z", "%Y-%m-%dT%H:%M:%SZ", false),
            ("2026-01-02T03:04", "%Y-%m-%dT%H:%M:%S", false),
        ] {
            assert_eq!(
                civil::DateTime::strptime(format, text).is_ok(),
                ok,
                "{text} {format}"
            );
        }
    }

    #[test]
    fn earliest_is_the_first_instant_in_a_fold_and_none_in_a_gap() {
        let tz = TimeZone::get("America/New_York").unwrap();
        // 2026-03-08 02:30 never happens in New York, so there is no instant.
        // (chrono 0.4.44 also accepted a gap's first minute, 02:00; jiff does not.)
        assert_eq!(
            earliest(&tz, civil::datetime(2026, 3, 8, 2, 30, 0, 0)),
            None
        );
        // 2026-11-01 01:30 happens twice; we take the earlier, still on EDT.
        // (chrono 0.4.44 picked the later one, 06:30Z.)
        assert_eq!(
            earliest(&tz, civil::datetime(2026, 11, 1, 1, 30, 0, 0)),
            Some(utc(2026, 11, 1, 5, 30, 0))
        );
        assert_eq!(
            earliest(&tz, civil::datetime(2026, 7, 1, 12, 0, 0, 0)),
            Some(utc(2026, 7, 1, 16, 0, 0))
        );
    }
}
