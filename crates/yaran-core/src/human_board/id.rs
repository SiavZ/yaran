//! Card ids.
//!
//! A board one machine keeps for itself numbers its cards `1`, `2`, `3`. A
//! board several machines share cannot: two of them would hand out the same
//! next number between syncs. So a machine writing to a shared board puts its
//! own prefix in front of the numbers it hands out (`G-12`, `S-3`), the way an
//! issue tracker prefixes a project's keys, and two machines with different
//! prefixes can never collide.
//!
//! The prefix and the number are kept apart rather than as one string, so
//! ordering is numeric (`G-9` before `G-10`) and a bare `12` typed at the CLI
//! can be matched against the number alone.

use std::fmt;

use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// Longest prefix accepted, in characters.
pub const MAX_PREFIX_CHARS: usize = 8;

/// One card's id: an optional prefix and a number.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct CardId {
    /// Upper-case ASCII letters and digits, starting with a letter; empty on
    /// a board that is not shared.
    prefix: String,
    number: u64,
}

impl CardId {
    /// An id from parts already known to be valid: `prefix` must be a value
    /// [`normalize_prefix`] returned.
    pub fn new(prefix: &str, number: u64) -> Self {
        Self {
            prefix: prefix.to_string(),
            number,
        }
    }

    /// An unprefixed id, as a board that is not shared hands out.
    pub fn plain(number: u64) -> Self {
        Self::new("", number)
    }

    pub fn prefix(&self) -> &str {
        &self.prefix
    }

    pub fn number(&self) -> u64 {
        self.number
    }

    /// Parse an id as a person or an agent writes it: `12`, `#12`, `G-12`,
    /// `#g-12` or `G12`, case-insensitively. `None` when it is not an id.
    pub fn parse(value: &str) -> Option<Self> {
        let bare = value.trim().trim_start_matches('#').trim();
        if bare.is_empty() {
            return None;
        }
        let digits_from = bare
            .char_indices()
            .rev()
            .take_while(|(_, c)| c.is_ascii_digit())
            .last()
            .map(|(at, _)| at)?;
        let number: u64 = bare[digits_from..].parse().ok()?;
        let head = &bare[..digits_from];
        if head.chars().any(char::is_whitespace) {
            return None;
        }
        let prefix = head.strip_suffix('-').unwrap_or(head);
        if prefix.is_empty() {
            return (head.is_empty()).then(|| Self::plain(number));
        }
        let prefix = normalize_prefix(prefix)?;
        Some(Self { prefix, number })
    }

    /// The note a folder board keeps this card in.
    pub fn file_name(&self) -> String {
        format!("{self}.md")
    }
}

impl fmt::Display for CardId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.prefix.is_empty() {
            write!(f, "{}", self.number)
        } else {
            write!(f, "{}-{}", self.prefix, self.number)
        }
    }
}

/// A prefix as stored: trimmed, upper-cased, without a trailing dash. `None`
/// when it is not one: it must start with a letter, hold only ASCII letters
/// and digits, and be at most [`MAX_PREFIX_CHARS`] long. An empty value is a
/// valid "no prefix" and comes back as `Some("")`.
pub fn normalize_prefix(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let trimmed = trimmed.strip_suffix('-').unwrap_or(trimmed);
    if trimmed.is_empty() {
        return Some(String::new());
    }
    let upper = trimmed.to_ascii_uppercase();
    let mut chars = upper.chars();
    let starts_with_letter = chars.next().is_some_and(|c| c.is_ascii_alphabetic());
    let rest_ok = chars.all(|c| c.is_ascii_alphanumeric());
    (starts_with_letter && rest_ok && upper.chars().count() <= MAX_PREFIX_CHARS).then_some(upper)
}

/// An unprefixed id travels as a number, so a board document written before
/// prefixes existed reads back unchanged and `yaran board list --json` keeps
/// printing numbers for a board that is not shared. A prefixed one travels as
/// its text.
impl Serialize for CardId {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        if self.prefix.is_empty() {
            serializer.serialize_u64(self.number)
        } else {
            serializer.collect_str(self)
        }
    }
}

impl<'de> Deserialize<'de> for CardId {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct IdVisitor;

        impl Visitor<'_> for IdVisitor {
            type Value = CardId;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a card number or an id like G-12")
            }

            fn visit_u64<E: de::Error>(self, value: u64) -> Result<CardId, E> {
                Ok(CardId::plain(value))
            }

            fn visit_i64<E: de::Error>(self, value: i64) -> Result<CardId, E> {
                u64::try_from(value)
                    .map(CardId::plain)
                    .map_err(|_| E::custom(format!("{value} is not a card number")))
            }

            fn visit_str<E: de::Error>(self, value: &str) -> Result<CardId, E> {
                CardId::parse(value).ok_or_else(|| E::custom(format!("{value:?} is not a card id")))
            }
        }

        deserializer.deserialize_any(IdVisitor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_parse_every_spelling_people_use() {
        assert_eq!(CardId::parse("12"), Some(CardId::plain(12)));
        assert_eq!(CardId::parse(" #12 "), Some(CardId::plain(12)));
        assert_eq!(CardId::parse("G-12"), Some(CardId::new("G", 12)));
        assert_eq!(CardId::parse("#g-12"), Some(CardId::new("G", 12)));
        assert_eq!(CardId::parse("g12"), Some(CardId::new("G", 12)));
        assert_eq!(CardId::parse("ab2-7"), Some(CardId::new("AB2", 7)));
        for not_an_id in [
            "",
            "#",
            "G-",
            "-12",
            "12x",
            "G 12",
            "1G-2",
            "TOOLONGPFX-1",
            "é-1",
        ] {
            assert_eq!(CardId::parse(not_an_id), None, "{not_an_id:?}");
        }
    }

    #[test]
    fn ids_print_order_and_name_their_note() {
        assert_eq!(CardId::plain(7).to_string(), "7");
        assert_eq!(CardId::new("S", 3).to_string(), "S-3");
        assert_eq!(CardId::new("S", 3).file_name(), "S-3.md");
        let mut ids = vec![
            CardId::new("G", 10),
            CardId::new("G", 9),
            CardId::plain(2),
            CardId::new("A", 1),
        ];
        ids.sort();
        assert_eq!(
            ids,
            vec![
                CardId::plain(2),
                CardId::new("A", 1),
                CardId::new("G", 9),
                CardId::new("G", 10),
            ],
            "numbers order numerically within a prefix"
        );
    }

    #[test]
    fn prefixes_normalize_or_are_refused() {
        assert_eq!(normalize_prefix(" g- ").as_deref(), Some("G"));
        assert_eq!(normalize_prefix("").as_deref(), Some(""));
        assert_eq!(normalize_prefix("Ab3").as_deref(), Some("AB3"));
        assert_eq!(normalize_prefix("3a"), None);
        assert_eq!(normalize_prefix("a-b"), None);
        assert_eq!(normalize_prefix("abcdefghi"), None);
    }

    #[test]
    fn plain_ids_travel_as_numbers_and_prefixed_ones_as_text() {
        assert_eq!(serde_json::to_string(&CardId::plain(5)).unwrap(), "5");
        assert_eq!(
            serde_json::to_string(&CardId::new("G", 5)).unwrap(),
            "\"G-5\""
        );
        let back: Vec<CardId> = serde_json::from_str("[5, \"G-5\", \"#7\"]").unwrap();
        assert_eq!(
            back,
            vec![CardId::plain(5), CardId::new("G", 5), CardId::plain(7)]
        );
        assert!(serde_json::from_str::<CardId>("\"nope\"").is_err());
        assert!(serde_json::from_str::<CardId>("-1").is_err());
    }
}
