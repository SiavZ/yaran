//! Diff comments: notes a person leaves on single lines of an agent's diff,
//! queued per agent and later typed into that agent's prompt as review
//! feedback.
//!
//! This module holds the data model and the prompt they become. Storage lives
//! in [`crate::storage`] (the `session_diff_comments` table), and the terminal
//! UI owns the editing and the send, which goes through its pty ownership gate.
//!
//! A comment is anchored by WHAT it is about, not only where: the file, the
//! side of the diff (a removed line exists only in the old version), the line
//! number on that side, and the line's text. A line whose text changed is a
//! different line, so a comment never silently moves onto code it was not
//! written about.

use crate::text::count_of;

/// The prompt each queued comment becomes when none is configured.
///
/// Placeholders: `{filename}`, `{line_number}`, `{line_content}`, `{message}`.
// backtick-ok: a prompt typed into an agent (markdown code spans), never a status.
pub const DEFAULT_PROMPT_TEMPLATE: &str = "\
On `{filename}` line `{line_number}`:
\t{line_content}
Feedback:
\t{message}
";

/// What separates two queued comments in the prompt when none is configured.
pub const DEFAULT_PROMPT_SEPARATOR: &str = "---";

/// Which version of the file a diff line belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum DiffSide {
    /// The committed version: a removed line.
    Old,
    /// The working copy: an added or unchanged line.
    New,
}

impl DiffSide {
    /// The stored spelling.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Old => "old",
            Self::New => "new",
        }
    }

    /// Read a stored spelling. Anything but `old` is the new side, the side
    /// every unchanged and added line is on.
    #[must_use]
    pub fn parse(value: &str) -> Self {
        if value == "old" { Self::Old } else { Self::New }
    }
}

/// The one diff line a comment is about.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct DiffAnchor {
    /// The file, relative to the agent's working copy.
    pub rel_path: String,
    /// Which version the line number counts in.
    pub side: DiffSide,
    /// One-based line number on `side`.
    pub line_number: usize,
    /// The line's text, without its line ending.
    pub line_content: String,
}

/// One queued comment.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiffComment {
    /// The agent the comment is queued for.
    pub session_id: String,
    /// The line it is about.
    pub anchor: DiffAnchor,
    /// What the person wrote, trimmed.
    pub text: String,
}

/// `"1 diff comment"` / `"3 diff comments"`.
#[must_use]
pub fn count_label(count: usize) -> String {
    count_of(count, "diff comment")
}

/// The prompt `comments` become, in file and line order, or `None` when there
/// are none.
///
/// Each comment fills `template` (the default when it is blank); a template
/// that leaves out `{message}` still carries the message after it, so what was
/// written is never dropped. Comments after the first are preceded by a line
/// break, then `separator` on a line of its own and a blank line (or by the
/// line break alone when the separator is empty).
#[must_use]
pub fn render_prompt(comments: &[&DiffComment], template: &str, separator: &str) -> Option<String> {
    if comments.is_empty() {
        return None;
    }
    let template = if template.trim().is_empty() {
        DEFAULT_PROMPT_TEMPLATE
    } else {
        template
    };
    let mut sorted = comments.to_vec();
    sorted.sort_by(|a, b| a.anchor.cmp(&b.anchor));
    let mut prompt = String::new();
    for (index, comment) in sorted.iter().enumerate() {
        if index > 0 {
            prompt.push('\n');
            if !separator.is_empty() {
                prompt.push_str(separator);
                prompt.push_str("\n\n");
            }
        }
        prompt.push_str(&render_one(template, comment));
    }
    Some(prompt)
}

fn render_one(template: &str, comment: &DiffComment) -> String {
    let line_number = comment.anchor.line_number.to_string();
    let rendered = fill(
        template,
        &[
            ("{filename}", &comment.anchor.rel_path),
            ("{line_number}", &line_number),
            ("{line_content}", &comment.anchor.line_content),
            ("{message}", &comment.text),
        ],
    );
    if template.contains("{message}") {
        rendered
    } else {
        format!("{rendered}\n{}", comment.text)
    }
}

/// Substitute every placeholder in one pass, so a value that happens to
/// contain a placeholder's spelling (a line of code reading `{message}`) is
/// copied as it is rather than expanded again.
fn fill(template: &str, values: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let tail = &rest[start..];
        if let Some((name, value)) = values.iter().find(|(name, _)| tail.starts_with(name)) {
            out.push_str(value);
            rest = &tail[name.len()..];
        } else {
            out.push('{');
            rest = &tail[1..];
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn comment(path: &str, line: usize, content: &str, text: &str) -> DiffComment {
        DiffComment {
            session_id: "s1".to_string(),
            anchor: DiffAnchor {
                rel_path: path.to_string(),
                side: DiffSide::New,
                line_number: line,
                line_content: content.to_string(),
            },
            text: text.to_string(),
        }
    }

    #[test]
    fn the_default_template_names_the_file_line_code_and_feedback() {
        let one = comment("README.md", 45, "## title", "Use an h4 instead");
        let prompt = render_prompt(&[&one], "", DEFAULT_PROMPT_SEPARATOR).expect("prompt");
        assert_eq!(
            prompt,
            "On `README.md` line `45`:\n\t## title\nFeedback:\n\tUse an h4 instead\n"
        );
    }

    #[test]
    fn comments_are_ordered_by_file_then_line_and_separated() {
        let late = comment("b.rs", 1, "b", "second file");
        let second = comment("a.rs", 46, "**subtitle**", "Avoid bold");
        let first = comment("a.rs", 45, "## title", "h4");
        let prompt = render_prompt(
            &[&late, &second, &first],
            "{filename}:{line_number} {message}",
            "### next",
        )
        .expect("prompt");
        assert_eq!(
            prompt,
            "a.rs:45 h4\n### next\n\na.rs:46 Avoid bold\n### next\n\nb.rs:1 second file"
        );
    }

    #[test]
    fn an_empty_separator_leaves_only_the_line_break() {
        let a = comment("a.rs", 1, "x", "one");
        let b = comment("a.rs", 2, "y", "two");
        let prompt = render_prompt(&[&a, &b], "{message}", "").expect("prompt");
        assert_eq!(prompt, "one\ntwo");
    }

    #[test]
    fn a_placeholder_inside_a_value_is_not_expanded_again() {
        let tricky = comment("a.rs", 3, "let s = \"{message}\";", "{filename} stays");
        let prompt = render_prompt(&[&tricky], "{line_content} -> {message}", "").expect("prompt");
        assert_eq!(prompt, "let s = \"{message}\"; -> {filename} stays");
    }

    #[test]
    fn a_template_without_the_message_still_carries_it() {
        let one = comment("a.rs", 3, "x", "keep me");
        let prompt = render_prompt(&[&one], "Look at {filename}", "").expect("prompt");
        assert_eq!(prompt, "Look at a.rs\nkeep me");
    }

    #[test]
    fn unknown_braces_are_copied_verbatim() {
        let one = comment("a.rs", 3, "x", "m");
        let prompt = render_prompt(&[&one], "{nope} {message} {", "").expect("prompt");
        assert_eq!(prompt, "{nope} m {");
    }

    #[test]
    fn no_comments_is_no_prompt() {
        assert_eq!(render_prompt(&[], "", "---"), None);
    }

    #[test]
    fn sides_round_trip_through_their_stored_spelling() {
        for side in [DiffSide::Old, DiffSide::New] {
            assert_eq!(DiffSide::parse(side.as_str()), side);
        }
        assert_eq!(DiffSide::parse("garbage"), DiffSide::New);
        assert_eq!(count_label(1), "1 diff comment");
        assert_eq!(count_label(2), "2 diff comments");
    }
}
