//! `[board]`, resolved: which store, whose queues, who runs this yaran, and
//! how a shared folder is kept in step.
//!
//! Every value degrades rather than refusing the config: an unknown sync mode
//! is "off", a prefix that is not one falls back to the derived default, and
//! the reason is logged once at the place that reads it.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Result, bail};

use super::id::normalize_prefix;
use super::sync::SyncMode;
use super::{BoardStore, MAX_FROM_CHARS, clean, same_person};
use crate::config::BoardConfig;

/// Shortest sync interval honoured, so a typo cannot hammer a remote.
pub const MIN_SYNC_INTERVAL: Duration = Duration::from_secs(15);

/// Words that mean "nobody in particular" where a person is expected.
const NOBODY: &[&str] = &[
    "anyone", "anybody", "everyone", "nobody", "none", "all", "-",
];

/// `[board]`, resolved.
#[derive(Clone, Debug)]
pub struct BoardSettings {
    pub store: BoardStore,
    /// The people with a queue, as configured, without blanks or repeats.
    pub people: Vec<String>,
    /// Who runs this yaran: one of `people` (in its configured spelling), or
    /// any name when `people` is empty. `None` when unset.
    pub me: Option<String>,
    pub sync: SyncMode,
    pub sync_every: Duration,
}

impl BoardSettings {
    /// Resolve `config` for the yaran home at `root`.
    pub fn from_config(config: &BoardConfig, root: &Path) -> Self {
        Self::resolve(config, root, home_dir().as_deref())
    }

    fn resolve(config: &BoardConfig, root: &Path, home: Option<&Path>) -> Self {
        let mut people: Vec<String> = Vec::new();
        for person in &config.people {
            if let Some(name) = clean(person, MAX_FROM_CHARS, false)
                && !people.iter().any(|known| same_person(known, &name))
            {
                people.push(name);
            }
        }
        let me = clean(&config.me, MAX_FROM_CHARS, false).map(|me| {
            people
                .iter()
                .find(|person| same_person(person, &me))
                .cloned()
                .unwrap_or(me)
        });
        let store = match resolve_dir(&config.dir, home) {
            Some(dir) => {
                let prefix = normalize_prefix(&config.id_prefix).unwrap_or_else(|| {
                    crate::logger::warn(&format!(
                        "[board] id_prefix {:?} is not a prefix (letters and digits, starting \
                         with a letter, at most {} long); using the default",
                        config.id_prefix,
                        super::id::MAX_PREFIX_CHARS
                    ));
                    String::new()
                });
                let prefix = if prefix.is_empty() {
                    default_prefix(me.as_deref())
                } else {
                    prefix
                };
                BoardStore::folder(&dir, root, &prefix)
            }
            None => BoardStore::new(root),
        };
        let sync = SyncMode::parse(&config.sync).unwrap_or_else(|| {
            crate::logger::warn(&format!(
                "[board] sync {:?} is not \"off\" or \"git\"; the board is not synced",
                config.sync
            ));
            SyncMode::Off
        });
        let sync_every =
            Duration::from_secs(u64::from(config.sync_interval_seconds)).max(MIN_SYNC_INTERVAL);
        Self {
            store,
            people,
            me,
            sync,
            sync_every,
        }
    }

    /// Whether the board has queues for named people.
    pub fn has_people(&self) -> bool {
        !self.people.is_empty()
    }

    /// The assignee a `--for` value names: `Ok(None)` for nobody in
    /// particular; a configured person in their configured spelling; any
    /// cleaned name when no people are configured. A name that is not one of
    /// the configured people is refused with the list, so a typo never parks a
    /// card in a queue nobody reads.
    pub fn person(&self, value: &str) -> Result<Option<String>> {
        let trimmed = value.trim();
        if NOBODY.iter().any(|word| trimmed.eq_ignore_ascii_case(word)) {
            return Ok(None);
        }
        let Some(name) = clean(trimmed, MAX_FROM_CHARS, false) else {
            bail!("--for needs a person");
        };
        if self.people.is_empty() {
            return Ok(Some(name));
        }
        match self.people.iter().find(|person| same_person(person, &name)) {
            Some(person) => Ok(Some(person.clone())),
            None => bail!(
                "{name:?} has no queue on this board; use one of {} (or \"anyone\")",
                self.people.join(", ")
            ),
        }
    }
}

/// The prefix a shared board's cards get when `id_prefix` is empty: the first
/// letter of `me`, upper-cased. No `me`, no prefix.
fn default_prefix(me: Option<&str>) -> String {
    me.and_then(|me| me.chars().find(char::is_ascii_alphabetic))
        .map(|c| c.to_ascii_uppercase().to_string())
        .unwrap_or_default()
}

/// The board folder `dir` names: `~` and `~/...` start at the home directory,
/// and so does any other relative path. Empty is no folder.
fn resolve_dir(dir: &str, home: Option<&Path>) -> Option<PathBuf> {
    let dir = dir.trim();
    if dir.is_empty() {
        return None;
    }
    let path = Path::new(dir);
    if path.is_absolute() {
        return Some(path.to_path_buf());
    }
    let rest = dir
        .strip_prefix('~')
        .map(|rest| rest.trim_start_matches('/'));
    match (home, rest) {
        (Some(home), Some(rest)) => Some(home.join(rest)),
        (Some(home), None) => Some(home.join(dir)),
        (None, _) => Some(path.to_path_buf()),
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(dir: &str, people: &[&str], me: &str, prefix: &str) -> BoardConfig {
        BoardConfig {
            dir: dir.to_string(),
            people: people.iter().map(|p| p.to_string()).collect(),
            me: me.to_string(),
            id_prefix: prefix.to_string(),
            ..BoardConfig::default()
        }
    }

    fn resolve(config: &BoardConfig) -> BoardSettings {
        BoardSettings::resolve(config, Path::new("/state"), Some(Path::new("/home/u")))
    }

    #[test]
    fn no_folder_is_the_private_document() {
        let settings = resolve(&config("", &[], "", ""));
        assert!(!settings.store.is_folder());
        assert_eq!(settings.store.path(), Path::new("/state/human_board.json"));
        assert_eq!(settings.sync, SyncMode::Off);
        assert_eq!(settings.me, None);
    }

    #[test]
    fn a_folder_resolves_home_relative_and_takes_a_prefix() {
        let settings = resolve(&config("~/vault/Board", &["Sam", "Alex"], "sam", ""));
        assert!(settings.store.is_folder());
        assert_eq!(settings.store.path(), Path::new("/home/u/vault/Board"));
        assert_eq!(settings.store.prefix(), "S", "derived from me");
        assert_eq!(
            settings.me.as_deref(),
            Some("Sam"),
            "the configured spelling"
        );

        let explicit = resolve(&config("/srv/board", &[], "sam", "ab-"));
        assert_eq!(explicit.store.path(), Path::new("/srv/board"));
        assert_eq!(explicit.store.prefix(), "AB");

        let relative = resolve(&config("notes/board", &[], "", "not a prefix"));
        assert_eq!(relative.store.path(), Path::new("/home/u/notes/board"));
        assert_eq!(relative.store.prefix(), "", "no me, no prefix");
    }

    #[test]
    fn people_are_deduplicated_and_names_are_checked_against_them() {
        let settings = resolve(&config("", &["Sam", " sam ", "", "Alex"], "", ""));
        assert_eq!(settings.people, ["Sam", "Alex"]);
        assert_eq!(settings.person("ALEX").unwrap().as_deref(), Some("Alex"));
        assert_eq!(settings.person("anyone").unwrap(), None);
        let err = settings.person("Sma").unwrap_err();
        assert!(format!("{err}").contains("Sam, Alex"), "{err}");

        let open = resolve(&config("", &[], "", ""));
        assert_eq!(open.person(" Kim ").unwrap().as_deref(), Some("Kim"));
    }

    #[test]
    fn sync_settings_degrade_and_are_floored() {
        let mut cfg = config("/b", &[], "", "");
        cfg.sync = "Git".to_string();
        cfg.sync_interval_seconds = 1;
        let settings = resolve(&cfg);
        assert_eq!(settings.sync, SyncMode::Git);
        assert_eq!(settings.sync_every, MIN_SYNC_INTERVAL);
        cfg.sync = "rsync".to_string();
        assert_eq!(resolve(&cfg).sync, SyncMode::Off);
    }
}
