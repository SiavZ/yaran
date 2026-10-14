use std::fs;
use std::sync::atomic::{AtomicUsize, Ordering};

use chrono::TimeZone;

use super::*;
use crate::git::test_support::git_command;
use crate::human_board::{CardId, CardKind, NewCard, Priority};

fn at(minute: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 14, 20, minute, 0).unwrap()
}

/// Run a fixture git command and return its standard output.
fn git(cwd: &Path, args: &[&str]) -> String {
    let out = git_command().args(args).current_dir(cwd).output().unwrap();
    assert!(
        out.status.success(),
        "git {args:?} failed in {}: {}",
        cwd.display(),
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

struct Machine {
    repo: PathBuf,
    store: BoardStore,
}

struct World {
    _tmp: tempfile::TempDir,
    a: Machine,
    b: Machine,
}

fn clone(tmp: &Path, remote: &Path, name: &str, prefix: &str) -> Machine {
    let repo = tmp.join(name);
    git(
        tmp,
        &[
            "clone",
            "-q",
            remote.to_str().unwrap(),
            repo.to_str().unwrap(),
        ],
    );
    git(&repo, &["config", "user.name", name]);
    git(
        &repo,
        &["config", "user.email", &format!("{name}@example.invalid")],
    );
    let home = tmp.join(format!("{name}-home"));
    let store = BoardStore::folder(&repo.join("Board"), &home, prefix);
    Machine { repo, store }
}

/// A shared remote with a README already in it, and two machines that cloned
/// it, each numbering its cards behind its own prefix.
fn world() -> World {
    let tmp = tempfile::tempdir().unwrap();
    let remote = tmp.path().join("remote.git");
    fs::create_dir_all(&remote).unwrap();
    git(&remote, &["init", "-q", "--bare", "-b", "main"]);
    let seed = tmp.path().join("seed");
    git(
        tmp.path(),
        &["init", "-q", "-b", "main", seed.to_str().unwrap()],
    );
    git(&seed, &["config", "user.name", "seed"]);
    git(&seed, &["config", "user.email", "seed@example.invalid"]);
    fs::write(seed.join("README.md"), "the vault\n").unwrap();
    git(&seed, &["add", "README.md"]);
    git(&seed, &["commit", "-q", "-m", "Start the vault"]);
    git(
        &seed,
        &[
            "push",
            "-q",
            remote.to_str().unwrap(),
            "HEAD:refs/heads/main",
        ],
    );
    let a = clone(tmp.path(), &remote, "a", "A");
    let b = clone(tmp.path(), &remote, "b", "B");
    World { _tmp: tmp, a, b }
}

fn post(machine: &Machine, title: &str, minute: u32) -> CardId {
    machine
        .store
        .update(|board| {
            board.post(
                NewCard {
                    kind: Some(CardKind::Task),
                    title: title.to_string(),
                    assignee: Some("Sam".to_string()),
                    ..NewCard::default()
                },
                at(minute),
            )
        })
        .unwrap()
        .id()
}

fn titles(machine: &Machine) -> Vec<String> {
    let mut titles: Vec<String> = machine
        .store
        .load()
        .unwrap()
        .cards
        .into_iter()
        .map(|c| c.title)
        .collect();
    titles.sort();
    titles
}

#[test]
fn a_card_posted_on_one_machine_reaches_the_other() {
    let world = world();
    let id = post(&world.a, "decide the name", 0);
    assert_eq!(id, CardId::new("A", 1));

    let sent = sync_with_git(&world.a.store).unwrap();
    assert_eq!(sent.committed, ["A-1.md"]);
    assert!(sent.pushed);
    assert_eq!(
        git(&world.a.repo, &["log", "-1", "--format=%s"]).trim(),
        "Update the shared board: A-1"
    );

    let taken = sync_with_git(&world.b.store).unwrap();
    assert_eq!(taken.received, 1);
    assert!(!taken.pushed);
    assert_eq!(titles(&world.b), ["decide the name"]);

    let quiet = sync_with_git(&world.b.store).unwrap();
    assert!(!quiet.changed_anything(), "{quiet:?}");
}

#[test]
fn only_the_board_folder_is_committed() {
    let world = world();
    let repo = &world.a.repo;
    // Somebody else's work in progress: a modified file and a staged one.
    fs::write(repo.join("README.md"), "the vault, edited\n").unwrap();
    fs::write(repo.join("staged.md"), "half done\n").unwrap();
    git(repo, &["add", "staged.md"]);
    post(&world.a, "one", 0);

    sync_with_git(&world.a.store).unwrap();
    let files = git(repo, &["show", "--name-only", "--format=", "HEAD"]);
    assert_eq!(files.trim(), "Board/A-1.md");
    let status = git(repo, &["status", "--porcelain=v1"]);
    assert!(status.contains(" M README.md"), "{status}");
    assert!(status.contains("A  staged.md"), "{status}");
}

#[test]
fn two_machines_editing_one_card_keep_the_newer_edit() {
    let world = world();
    let id = post(&world.a, "merge the release?", 0);
    sync_with_git(&world.a.store).unwrap();
    sync_with_git(&world.b.store).unwrap();

    // B raises the priority first; A resolves it later. Neither has synced.
    world
        .b
        .store
        .update(|board| board.set_priority(&id, Priority::Critical, at(5)))
        .unwrap();
    world
        .a
        .store
        .update(|board| board.resolve(&id, Some("human"), Some("shipped"), at(10)))
        .unwrap();
    // B posts a card of its own too, so its side has more than the conflict.
    post(&world.b, "from b", 6);

    sync_with_git(&world.a.store).unwrap();
    let settled = sync_with_git(&world.b.store).unwrap();
    assert_eq!(settled.settled, ["A-1.md"], "{settled:?}");
    assert!(settled.pushed);
    sync_with_git(&world.a.store).unwrap();

    for machine in [&world.a, &world.b] {
        let board = machine.store.load().unwrap();
        let card = board.card(&id).unwrap();
        assert!(!card.is_open(), "the newer edit (the resolve) won");
        assert_eq!(card.resolution.as_deref(), Some("shipped"));
        assert!(board.card(CardId::new("B", 1)).is_some());
    }
    assert_eq!(
        git(&world.a.repo, &["rev-parse", "HEAD"]),
        git(&world.b.repo, &["rev-parse", "HEAD"]),
        "both machines end on the same commit"
    );
}

#[test]
fn a_conflict_outside_the_board_is_undone_and_reported() {
    let world = world();
    for (machine, text) in [(&world.a, "from a\n"), (&world.b, "from b\n")] {
        fs::write(machine.repo.join("README.md"), text).unwrap();
        git(&machine.repo, &["commit", "-q", "-am", "Edit the readme"]);
    }
    git(
        &world.a.repo,
        &["push", "-q", "origin", "HEAD:refs/heads/main"],
    );
    post(&world.b, "one", 0);

    let err = sync_with_git(&world.b.store).unwrap_err();
    let err = format!("{err:#}");
    assert!(err.contains("README.md") && err.contains("undone"), "{err}");
    assert!(
        !world.b.repo.join(".git/MERGE_HEAD").exists(),
        "the merge was aborted"
    );
    assert_eq!(
        fs::read_to_string(world.b.repo.join("README.md")).unwrap(),
        "from b\n"
    );
}

#[test]
fn uncommitted_work_in_the_way_is_never_overwritten() {
    let world = world();
    fs::write(world.b.repo.join("README.md"), "pushed by b\n").unwrap();
    git(&world.b.repo, &["commit", "-q", "-am", "Edit the readme"]);
    git(
        &world.b.repo,
        &["push", "-q", "origin", "HEAD:refs/heads/main"],
    );
    fs::write(world.a.repo.join("README.md"), "a, not committed\n").unwrap();

    let err = sync_with_git(&world.a.store).unwrap_err();
    assert!(format!("{err:#}").contains("could not take"), "{err:#}");
    assert_eq!(
        fs::read_to_string(world.a.repo.join("README.md")).unwrap(),
        "a, not committed\n"
    );
}

#[test]
fn a_repository_mid_merge_is_left_alone() {
    let world = world();
    post(&world.a, "one", 0);
    let head = git(&world.a.repo, &["rev-parse", "HEAD"]);
    fs::write(world.a.repo.join(".git/MERGE_HEAD"), &head).unwrap();
    let err = sync_with_git(&world.a.store).unwrap_err();
    assert!(format!("{err:#}").contains("middle of a merge"), "{err:#}");
    assert_eq!(
        git(&world.a.repo, &["rev-parse", "HEAD"]),
        head,
        "nothing was committed"
    );
}

#[test]
fn a_folder_outside_git_or_without_upstream_is_explained() {
    let tmp = tempfile::tempdir().unwrap();
    let loose = BoardStore::folder(&tmp.path().join("Board"), tmp.path(), "A");
    let err = sync_with_git(&loose).unwrap_err();
    assert!(
        format!("{err:#}").contains("not inside a git repository"),
        "{err:#}"
    );

    let repo = tmp.path().join("repo");
    git(
        tmp.path(),
        &["init", "-q", "-b", "main", repo.to_str().unwrap()],
    );
    let lonely = BoardStore::folder(&repo.join("Board"), tmp.path(), "A");
    let err = sync_with_git(&lonely).unwrap_err();
    assert!(format!("{err:#}").contains("no upstream"), "{err:#}");

    let document = BoardStore::new(tmp.path());
    let err = sync_with_git(&document).unwrap_err();
    assert!(format!("{err:#}").contains("not a folder"), "{err:#}");
}

#[test]
fn the_newer_note_wins_and_a_change_beats_a_delete() {
    let note = |minute: u32, title: &str| {
        let mut board = crate::human_board::Board {
            prefix: "A".to_string(),
            ..Default::default()
        };
        board
            .post(
                NewCard {
                    kind: Some(CardKind::Task),
                    title: title.to_string(),
                    ..NewCard::default()
                },
                at(minute),
            )
            .unwrap();
        markdown::render(&board.cards[0]).into_bytes()
    };
    let old = note(1, "old");
    let new = note(2, "new");
    assert_eq!(
        newer_note("A-1.md", Some(&old), Some(&new)),
        Some(new.clone())
    );
    assert_eq!(
        newer_note("A-1.md", Some(&new), Some(&old)),
        Some(new.clone())
    );
    // A tie settles the same way whichever side is "ours".
    let other = note(2, "other");
    assert_eq!(
        newer_note("A-1.md", Some(&new), Some(&other)),
        newer_note("A-1.md", Some(&other), Some(&new))
    );
    assert_eq!(newer_note("A-1.md", None, Some(&old)), Some(old.clone()));
    assert_eq!(newer_note("A-1.md", Some(&old), None), Some(old.clone()));
    assert_eq!(newer_note("A-1.md", None, None), None);
    // A side that cannot be read loses to one that can.
    assert_eq!(
        newer_note("A-1.md", Some(b"garbage"), Some(&old)),
        Some(old.clone())
    );
}

#[test]
fn porcelain_paths_and_the_commit_message() {
    let raw = b" M Board/A-1.md\0?? Board/A-2.md\0R  Board/A-3.md\0Board/old.md\0D  Board/A-4.md\0";
    assert_eq!(
        porcelain_paths(raw),
        [
            "Board/A-1.md",
            "Board/A-2.md",
            "Board/A-3.md",
            "Board/A-4.md"
        ]
    );
    let names: Vec<String> = (1..=8).map(|n| format!("A-{n}.md")).collect();
    assert_eq!(
        commit_message(&names),
        "Update the shared board: A-1, A-2, A-3, A-4, A-5, A-6 and 2 more"
    );
}

#[test]
fn sync_modes_parse() {
    assert_eq!(SyncMode::parse("GIT"), Some(SyncMode::Git));
    assert_eq!(SyncMode::parse(""), Some(SyncMode::Off));
    assert_eq!(SyncMode::parse("off"), Some(SyncMode::Off));
    assert_eq!(SyncMode::parse("dropbox"), None);
}

#[test]
fn the_report_says_what_moved() {
    let quiet = SyncReport::default();
    assert!(quiet.summary().contains("nothing changed"));
    let busy = SyncReport {
        committed: vec!["A-1.md".to_string()],
        received: 2,
        pushed: true,
        settled: vec!["A-1.md".to_string()],
    };
    let summary = busy.summary();
    assert!(
        summary.contains("committed 1 changed card note,"),
        "{summary}"
    );
    assert!(summary.contains("took 2 commits"), "{summary}");
    assert!(summary.contains("pushed"), "{summary}");
    assert!(summary.contains("newer edit"), "{summary}");
}

static SYNCS: AtomicUsize = AtomicUsize::new(0);

fn counting_sync(_store: &BoardStore) -> Result<SyncReport> {
    SYNCS.fetch_add(1, Ordering::SeqCst);
    Ok(SyncReport::default())
}

#[test]
fn the_syncer_runs_at_once_and_soon_after_a_poke() {
    let tmp = tempfile::tempdir().unwrap();
    let store = BoardStore::folder(&tmp.path().join("Board"), tmp.path(), "A");
    let syncer = BoardSyncer::spawn_with(
        store,
        Duration::from_secs(3600),
        Duration::from_millis(50),
        counting_sync,
    )
    .unwrap();
    let wait = Duration::from_secs(5);
    assert!(syncer.next_within(wait).unwrap().result.is_ok());
    let after_first = SYNCS.load(Ordering::SeqCst);
    // Several pokes together are one sync.
    syncer.poke();
    syncer.poke();
    syncer.poke();
    assert!(syncer.next_within(wait).is_some());
    assert!(syncer.next_within(Duration::from_millis(300)).is_none());
    assert_eq!(SYNCS.load(Ordering::SeqCst), after_first + 1);
}
