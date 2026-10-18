//! Where the board lives, and the one way to read and change it.
//!
//! Two stores, behind one [`BoardStore`]:
//!
//! - **A document**, [`BOARD_FILE`] in the yaran home: the whole board in one
//!   owner-only JSON file, private to this machine. The default.
//! - **A folder** (`[board] dir`): one Markdown note per card, named after the
//!   card's id ([`super::markdown`]). The folder is the user's own (a notes
//!   vault, a repository), so its notes get ordinary file modes, and other
//!   people and machines may change them; see [`super::sync`].
//!
//! Either way every change is a read-modify-write under an exclusive
//! `flock(2)` on [`BOARD_LOCK`] in the yaran home, and every file lands with an
//! atomic rename. A folder change rewrites only the notes of the cards it
//! changed, so two machines editing different cards never touch the same
//! file.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::{Duration, SystemTime};

use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};

use super::id::CardId;
use super::{BOARD_FILE, BOARD_LOCK, BOARD_VERSION, Board, markdown};

/// Largest note a folder board reads, in bytes. A card's text is bounded far
/// below this; a bigger file is not a card yaran wrote.
pub const MAX_NOTE_BYTES: u64 = 256 * 1024;

#[derive(Clone, Debug)]
enum Backend {
    /// The whole board in one JSON document.
    Document(PathBuf),
    /// One Markdown note per card in a folder.
    Folder(PathBuf),
}

/// Where the board lives, and the one way to read and change it.
#[derive(Clone, Debug)]
pub struct BoardStore {
    backend: Backend,
    lock_path: PathBuf,
    /// What this machine puts in front of the numbers it hands out.
    prefix: String,
}

impl BoardStore {
    /// The board document of the yaran home at `root`.
    pub fn new(root: &Path) -> Self {
        Self {
            backend: Backend::Document(root.join(BOARD_FILE)),
            lock_path: root.join(BOARD_LOCK),
            prefix: String::new(),
        }
    }

    /// A folder board in `dir`, locked through the yaran home at `root`, whose
    /// new cards are numbered behind `prefix` (a value
    /// [`super::id::normalize_prefix`] returned).
    pub fn folder(dir: &Path, root: &Path, prefix: &str) -> Self {
        Self {
            backend: Backend::Folder(dir.to_path_buf()),
            lock_path: root.join(BOARD_LOCK),
            prefix: prefix.to_string(),
        }
    }

    /// The board document, or the folder.
    pub fn path(&self) -> &Path {
        match &self.backend {
            Backend::Document(path) | Backend::Folder(path) => path,
        }
    }

    /// Whether this is a folder board.
    pub fn is_folder(&self) -> bool {
        matches!(self.backend, Backend::Folder(_))
    }

    pub fn prefix(&self) -> &str {
        &self.prefix
    }

    /// The private board document of the same yaran home: where a board
    /// lived before it moved to a folder, for `yaran board import`.
    pub fn private_document(&self) -> BoardStore {
        BoardStore::new(self.home())
    }

    /// The yaran home this store locks through: where this machine keeps what
    /// is its own about the board (what its person has read), even when the
    /// cards themselves are shared.
    pub fn home(&self) -> &Path {
        self.lock_path.parent().unwrap_or(Path::new("."))
    }

    /// Read the board. A missing document or folder is an empty board; an
    /// unreadable document is an error naming the file. An unreadable note in
    /// a folder is not: it is listed in [`Board::problems`] and the rest of
    /// the board loads.
    pub fn load(&self) -> Result<Board> {
        let mut board = match &self.backend {
            Backend::Document(path) => load_document(path)?,
            Backend::Folder(dir) => load_folder(dir)?,
        };
        board.prefix = self.prefix.clone();
        Ok(board)
    }

    /// Change the board under the writers' lock: read it, let `change` edit it,
    /// prune the history, and write it back atomically. Nothing is written when
    /// `change` fails.
    pub fn update<T>(&self, change: impl FnOnce(&mut Board) -> Result<T>) -> Result<T> {
        let _lock = self.lock()?;
        let before = self.load()?;
        if before.version > BOARD_VERSION {
            bail!(
                "{} was written by a newer yaran (board version {}); update this yaran \
                 before changing the board",
                self.path().display(),
                before.version
            );
        }
        let mut board = before.clone();
        let value = change(&mut board)?;
        board.version = BOARD_VERSION;
        board.prune();
        match &self.backend {
            Backend::Document(path) => write_document(path, &board)?,
            Backend::Folder(dir) => write_folder(dir, &before, &board)?,
        }
        Ok(value)
    }

    /// Run `work` while holding the writers' lock, so no writer on this machine
    /// changes the board meanwhile. What a sync holds while it commits or
    /// merges the folder.
    pub fn with_lock<T>(&self, work: impl FnOnce() -> Result<T>) -> Result<T> {
        let _lock = self.lock()?;
        work()
    }

    fn lock(&self) -> Result<File> {
        use rustix::fs::{FlockOperation, flock};
        if let Some(parent) = self.lock_path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("could not create {}", parent.display()))?;
        }
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .mode(0o600)
            .open(&self.lock_path)
            .with_context(|| format!("could not open {}", self.lock_path.display()))?;
        crate::io_retry::retry_on_interrupt_errno(|| flock(&file, FlockOperation::LockExclusive))
            .with_context(|| format!("could not lock {}", self.lock_path.display()))?;
        // The lock is released when the returned file is dropped.
        Ok(file)
    }
}

fn load_document(path: &Path) -> Result<Board> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Board::default()),
        Err(err) => {
            return Err(err).with_context(|| format!("could not read {}", path.display()));
        }
    };
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(Board::default());
    }
    serde_json::from_slice(&bytes).with_context(|| {
        format!(
            "{} is not a board yaran can read; fix or move it aside (it is never \
             overwritten while unreadable, so no card in it is lost)",
            path.display()
        )
    })
}

/// Write a file of this machine's own (owner-only) whole, through a rename.
pub(crate) fn write_private(path: &Path, body: &[u8]) -> Result<()> {
    write_atomic(path, body, Some(0o600))
}

fn write_document(path: &Path, board: &Board) -> Result<()> {
    let mut body = serde_json::to_vec_pretty(board).context("could not encode the board")?;
    body.push(b'\n');
    write_atomic(path, &body, Some(0o600))
}

/// Whether `name` is a note the folder board reads: a visible `.md` file.
fn is_note_name(name: &str) -> bool {
    !name.starts_with('.') && name.ends_with(".md") && name.len() > ".md".len()
}

fn load_folder(dir: &Path) -> Result<Board> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Board::default()),
        Err(err) => {
            return Err(err)
                .with_context(|| format!("could not read the board folder {}", dir.display()));
        }
    };
    let mut names: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| is_note_name(name))
        .collect();
    names.sort();

    let mut board = Board {
        version: BOARD_VERSION,
        ..Board::default()
    };
    for name in names {
        let path = dir.join(&name);
        let stem = name.trim_end_matches(".md");
        // A symlink is not followed: the folder may be shared, and a note
        // must not be a way to read some other file into the board.
        let meta = match fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_file() => meta,
            Ok(_) => continue,
            Err(err) => {
                board.problems.push(format!("{name}: {err}"));
                reserve(&mut board, stem);
                continue;
            }
        };
        if meta.len() > MAX_NOTE_BYTES {
            board.problems.push(format!(
                "{name} is {} KiB, larger than a card note can be; it was left alone",
                meta.len() / 1024
            ));
            reserve(&mut board, stem);
            continue;
        }
        let text = match fs::read(&path) {
            Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            Err(err) => {
                board.problems.push(format!("{name}: {err}"));
                reserve(&mut board, stem);
                continue;
            }
        };
        let modified = meta
            .modified()
            .map(DateTime::<Utc>::from)
            .unwrap_or_else(|_| Utc::now());
        match markdown::parse(&text, stem, modified) {
            Ok(None) => {}
            Ok(Some(card)) => {
                if let Some(first) = board.files.get(&card.id) {
                    let first = first
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    board.problems.push(format!(
                        "{name} and {first} are both card #{}; {name} was left out",
                        card.id
                    ));
                    reserve(&mut board, stem);
                    continue;
                }
                board.files.insert(card.id.clone(), path);
                board.cards.push(card);
            }
            Err(why) => {
                board
                    .problems
                    .push(format!("{name} is not a card yaran can read: {why}"));
                reserve(&mut board, stem);
            }
        }
    }
    Ok(board)
}

/// Keep a new card from taking the file name of a note that did not load.
fn reserve(board: &mut Board, stem: &str) {
    if let Some(id) = CardId::parse(stem) {
        board.reserved.insert(id);
    }
}

/// Write the notes of the cards `change` added or changed, and remove the
/// notes of the cards it dropped. Untouched cards' notes are not rewritten,
/// so a hand-edited note keeps its own formatting until its card changes.
fn write_folder(dir: &Path, before: &Board, after: &Board) -> Result<()> {
    fs::create_dir_all(dir)
        .with_context(|| format!("could not create the board folder {}", dir.display()))?;
    for card in &after.cards {
        if before.card(&card.id) == Some(card) {
            continue;
        }
        let path = before
            .files
            .get(&card.id)
            .cloned()
            .unwrap_or_else(|| dir.join(card.id.file_name()));
        write_atomic(&path, markdown::render(card).as_bytes(), None)?;
    }
    for card in &before.cards {
        if after.card(&card.id).is_some() {
            continue;
        }
        if let Some(path) = before.files.get(&card.id) {
            match fs::remove_file(path) {
                Ok(()) => {}
                Err(err) if err.kind() == io::ErrorKind::NotFound => {}
                Err(err) => {
                    return Err(err)
                        .with_context(|| format!("could not remove {}", path.display()));
                }
            }
        }
    }
    Ok(())
}

/// Replace `path` with `body` through a temporary sibling and a rename.
/// `mode` is the new file's permission bits; `None` leaves them to the umask.
/// The temporary file is hidden (a leading dot), so a notes app or a folder
/// watcher that happens to look mid-write does not take it for a note.
fn write_atomic(path: &Path, body: &[u8], mode: Option<u32>) -> Result<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = dir.join(format!(
        ".{name}.tmp.{}.{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        if let Some(mode) = mode {
            options.mode(mode);
        }
        let mut file = options
            .open(&tmp)
            .with_context(|| format!("could not create {}", tmp.display()))?;
        file.write_all(body)
            .with_context(|| format!("could not write {}", tmp.display()))?;
        file.sync_all()
            .with_context(|| format!("could not sync {}", tmp.display()))?;
        fs::rename(&tmp, path).with_context(|| {
            format!(
                "could not replace {} with {}",
                path.display(),
                tmp.display()
            )
        })
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// The board as last read, or why it could not be read. What the watcher
/// hands a surface.
#[derive(Clone, Debug)]
pub struct BoardSnapshot {
    pub board: Result<Board, String>,
}

/// What identifies one version of a file on disk. A writer always replaces a
/// file by rename, so a new version has a new inode even when the size and
/// the mtime's resolution would hide the change.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FileStamp {
    inode: u64,
    len: u64,
    modified: Option<SystemTime>,
}

fn stamp(path: &Path) -> Option<FileStamp> {
    let meta = fs::metadata(path).ok()?;
    Some(FileStamp {
        inode: meta.ino(),
        len: meta.len(),
        modified: meta.modified().ok(),
    })
}

/// What the watcher compares between looks: the document's stamp, or every
/// note's name and stamp. `None` when the document or folder does not exist.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Fingerprint {
    Document(Option<FileStamp>),
    Folder(Option<Vec<(String, FileStamp)>>),
}

fn fingerprint(store: &BoardStore) -> Fingerprint {
    match &store.backend {
        Backend::Document(path) => Fingerprint::Document(stamp(path)),
        Backend::Folder(dir) => Fingerprint::Folder(fs::read_dir(dir).ok().map(|entries| {
            let mut notes: Vec<(String, FileStamp)> = entries
                .filter_map(|entry| entry.ok())
                .filter_map(|entry| {
                    let name = entry.file_name().into_string().ok()?;
                    if !is_note_name(&name) {
                        return None;
                    }
                    let stamp = stamp(&entry.path())?;
                    Some((name, stamp))
                })
                .collect();
            notes.sort_by(|a, b| a.0.cmp(&b.0));
            notes
        })),
    }
}

/// Watches the board on a background thread and hands over a snapshot
/// whenever it changes, starting with one straight away.
///
/// The thread looks every `every`; a look costs one `stat` for a document and
/// one directory listing plus a `stat` per note for a folder. It stops once
/// this handle is dropped (at its next look), so a surface that switches the
/// board off simply drops its watcher.
pub struct BoardWatcher {
    rx: mpsc::Receiver<BoardSnapshot>,
    stop: Arc<AtomicBool>,
}

impl BoardWatcher {
    pub fn spawn(store: BoardStore, every: Duration) -> io::Result<Self> {
        let (tx, rx) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        thread::Builder::new()
            .name("yaran-human-board".to_string())
            .spawn(move || {
                let mut last: Option<Fingerprint> = None;
                while !thread_stop.load(Ordering::Relaxed) {
                    let now = fingerprint(&store);
                    if last.as_ref() != Some(&now) {
                        last = Some(now);
                        let snapshot = BoardSnapshot {
                            board: store.load().map_err(|err| format!("{err:#}")),
                        };
                        if tx.send(snapshot).is_err() {
                            return;
                        }
                    }
                    thread::sleep(every);
                }
            })?;
        Ok(Self { rx, stop })
    }

    /// The newest snapshot sent since the last call, if any. Older ones are
    /// skipped: only the board as it is now matters.
    pub fn latest(&self) -> Option<BoardSnapshot> {
        self.rx.try_iter().last()
    }

    /// Wait up to `timeout` for the next snapshot. For tests and tools.
    pub fn next_within(&self, timeout: Duration) -> Option<BoardSnapshot> {
        self.rx.recv_timeout(timeout).ok()
    }
}

impl Drop for BoardWatcher {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use chrono::TimeZone;

    use super::*;
    use crate::human_board::{CardKind, NewCard};

    fn at(minute: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 14, 20, minute, 0).unwrap()
    }

    fn task(title: &str) -> NewCard {
        NewCard {
            kind: Some(CardKind::Task),
            title: title.to_string(),
            ..NewCard::default()
        }
    }

    fn folder() -> (tempfile::TempDir, BoardStore) {
        let home = tempfile::tempdir().unwrap();
        let store = BoardStore::folder(&home.path().join("vault/Board"), home.path(), "G");
        (home, store)
    }

    fn notes(store: &BoardStore) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(store.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn a_folder_board_keeps_one_note_per_card_under_its_prefix() {
        let (_home, store) = folder();
        assert!(store.load().unwrap().cards.is_empty(), "no folder is empty");
        let first = store.update(|b| b.post(task("one"), at(0))).unwrap().id();
        let second = store.update(|b| b.post(task("two"), at(1))).unwrap().id();
        assert_eq!(first, CardId::new("G", 1));
        assert_eq!(second, CardId::new("G", 2));
        assert_eq!(notes(&store), ["G-1.md", "G-2.md"]);
        let mode = fs::metadata(store.path().join("G-1.md"))
            .unwrap()
            .permissions()
            .mode();
        assert_ne!(
            mode & 0o044,
            0,
            "a note in the user's folder is not owner-only"
        );

        let board = store.load().unwrap();
        assert_eq!(board.card(&first).unwrap().title, "one");
        assert!(board.problems.is_empty(), "{:?}", board.problems);
    }

    #[test]
    fn a_change_rewrites_only_the_cards_it_touched() {
        let (_home, store) = folder();
        store.update(|b| b.post(task("one"), at(0))).unwrap();
        store.update(|b| b.post(task("two"), at(1))).unwrap();
        // A person edits the first note by hand, in their own style.
        let hand = "---\nkind: task\ntitle: one, edited by hand\n---\n";
        fs::write(store.path().join("G-1.md"), hand).unwrap();
        store
            .update(|b| b.resolve(CardId::new("G", 2), Some("human"), None, at(2)))
            .unwrap();
        assert_eq!(
            fs::read_to_string(store.path().join("G-1.md")).unwrap(),
            hand,
            "an untouched card's note is left exactly as it was"
        );
        let second = fs::read_to_string(store.path().join("G-2.md")).unwrap();
        assert!(second.contains("status: done"), "{second}");
    }

    #[test]
    fn unreadable_notes_are_reported_kept_and_never_reused() {
        let (_home, store) = folder();
        fs::create_dir_all(store.path()).unwrap();
        fs::write(
            store.path().join("G-7.md"),
            "---\nkind: chore\ntitle: x\n---\n",
        )
        .unwrap();
        fs::write(store.path().join("README.md"), "# The board\n").unwrap();
        fs::write(store.path().join("notes.txt"), "not a note").unwrap();
        let board = store.load().unwrap();
        assert!(board.cards.is_empty());
        assert_eq!(board.problems.len(), 1, "{:?}", board.problems);
        assert!(board.problems[0].contains("G-7.md"), "{:?}", board.problems);

        let id = store.update(|b| b.post(task("new"), at(0))).unwrap().id();
        assert_eq!(
            id,
            CardId::new("G", 8),
            "G-7 is taken by the unreadable note"
        );
        assert_eq!(
            fs::read_to_string(store.path().join("G-7.md")).unwrap(),
            "---\nkind: chore\ntitle: x\n---\n",
            "the unreadable note is left alone"
        );
    }

    #[test]
    fn two_notes_claiming_one_id_keep_the_first() {
        let (_home, store) = folder();
        fs::create_dir_all(store.path()).unwrap();
        fs::write(
            store.path().join("G-3.md"),
            "---\nid: G-3\nkind: task\ntitle: first\n---\n",
        )
        .unwrap();
        fs::write(
            store.path().join("copy.md"),
            "---\nid: G-3\nkind: task\ntitle: copy\n---\n",
        )
        .unwrap();
        let board = store.load().unwrap();
        assert_eq!(board.cards.len(), 1);
        assert_eq!(board.problems.len(), 1, "{:?}", board.problems);
        // `G-3.md` sorts before `copy.md`, so it is the one kept.
        assert_eq!(board.cards[0].title, "first");
    }

    #[test]
    fn a_pruned_card_takes_its_note_with_it() {
        let (_home, store) = folder();
        for n in 0..(super::super::RESOLVED_HISTORY + 1) {
            store
                .update(|b| {
                    let id = b.post(task(&format!("r{n}")), at(0))?.id();
                    b.resolve(id, None, None, at((n % 60) as u32))
                })
                .unwrap();
        }
        assert_eq!(notes(&store).len(), super::super::RESOLVED_HISTORY);
    }

    #[test]
    fn a_symlinked_note_is_not_followed() {
        let (home, store) = folder();
        fs::create_dir_all(store.path()).unwrap();
        let outside = home.path().join("outside.md");
        fs::write(&outside, "---\nkind: task\ntitle: from outside\n---\n").unwrap();
        std::os::unix::fs::symlink(&outside, store.path().join("G-1.md")).unwrap();
        assert!(store.load().unwrap().cards.is_empty());
    }

    #[test]
    fn the_watcher_sees_a_note_change_in_a_folder() {
        let (_home, store) = folder();
        let watcher = BoardWatcher::spawn(store.clone(), Duration::from_millis(10)).unwrap();
        let wait = Duration::from_secs(5);
        assert!(
            watcher
                .next_within(wait)
                .unwrap()
                .board
                .unwrap()
                .cards
                .is_empty()
        );
        store.update(|b| b.post(task("a"), at(0))).unwrap();
        assert_eq!(
            watcher
                .next_within(wait)
                .unwrap()
                .board
                .unwrap()
                .cards
                .len(),
            1
        );
        store
            .update(|b| b.resolve(CardId::new("G", 1), None, None, at(1)))
            .unwrap();
        let board = watcher.next_within(wait).unwrap().board.unwrap();
        assert!(!board.cards[0].is_open());
        assert!(watcher.next_within(Duration::from_millis(100)).is_none());
    }
}
