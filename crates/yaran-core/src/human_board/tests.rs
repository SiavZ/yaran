use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

use chrono::{Duration as ChronoDuration, TimeZone};

use super::*;

fn at(minute: i64) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 11, 12, 0, 0).unwrap() + ChronoDuration::minutes(minute)
}

fn card(kind: CardKind, ticket: Option<&str>, title: &str) -> NewCard {
    NewCard {
        kind: Some(kind),
        assignee: None,
        priority: None,
        ticket: ticket.map(str::to_string),
        title: title.to_string(),
        detail: None,
        from: Some("orchestrator".to_string()),
    }
}

#[test]
fn kinds_parse_their_names_and_the_obvious_aliases() {
    for kind in CardKind::ALL {
        assert_eq!(CardKind::parse(kind.as_str()), Some(kind));
    }
    assert_eq!(CardKind::parse("Validation"), Some(CardKind::Validate));
    assert_eq!(CardKind::parse("APPROVE"), Some(CardKind::Confirm));
    assert_eq!(CardKind::parse("fyi"), Some(CardKind::Info));
    assert_eq!(CardKind::parse("decision"), Some(CardKind::Task));
    assert_eq!(CardKind::parse("urgent"), None);
}

#[test]
fn the_board_order_puts_what_waits_on_a_person_before_the_news() {
    assert_eq!(
        CardKind::ALL,
        [
            CardKind::Task,
            CardKind::Validate,
            CardKind::Confirm,
            CardKind::Info
        ]
    );
    assert!(CardKind::ALL[..3].iter().all(|k| k.waits_on_human()));
    assert!(!CardKind::Info.waits_on_human());
}

#[test]
fn posting_numbers_cards_from_one_and_never_reuses_a_number() {
    let mut board = Board::default();
    assert_eq!(
        board.post(card(CardKind::Task, None, "a"), at(0)).unwrap(),
        PostOutcome::Added(CardId::plain(1))
    );
    assert_eq!(
        board.post(card(CardKind::Info, None, "b"), at(1)).unwrap(),
        PostOutcome::Added(CardId::plain(2))
    );
    board.cards.retain(|c| c.id != 2);
    assert_eq!(
        board.post(card(CardKind::Info, None, "c"), at(2)).unwrap(),
        PostOutcome::Added(CardId::plain(3)),
        "a dropped card's number is not handed out again"
    );
}

#[test]
fn an_open_card_is_unique_per_ticket_and_kind() {
    let mut board = Board::default();
    board
        .post(card(CardKind::Validate, Some("#4812"), "check it"), at(0))
        .unwrap();
    // Same ticket, other kind: a second card.
    board
        .post(card(CardKind::Info, Some("4812"), "merged"), at(1))
        .unwrap();
    // Same ticket and kind: the first card is rewritten, not duplicated.
    let outcome = board
        .post(
            card(CardKind::Validate, Some("4812"), "check it again"),
            at(2),
        )
        .unwrap();
    assert_eq!(outcome, PostOutcome::Updated(CardId::plain(1)));
    assert_eq!(board.cards.len(), 2);
    let first = board.card(1).unwrap();
    assert_eq!(first.title, "check it again");
    assert_eq!(first.created_at, at(0));
    assert_eq!(first.updated_at, at(2));

    // Once resolved, the same ticket and kind starts a fresh card.
    board.resolve(1, Some("human"), None, at(3)).unwrap();
    let outcome = board
        .post(card(CardKind::Validate, Some("4812"), "regressed"), at(4))
        .unwrap();
    assert_eq!(outcome, PostOutcome::Added(CardId::plain(3)));
}

#[test]
fn card_text_is_sanitized_flattened_and_bounded() {
    let mut board = Board::default();
    let long = "x".repeat(MAX_TITLE_CHARS + 50);
    board
        .post(
            NewCard {
                kind: Some(CardKind::Task),
                assignee: None,
                priority: None,
                ticket: Some("  #42  ".to_string()),
                title: format!("\x1b]0;pwned\x07 two\n lines {long}"),
                detail: Some("keep\nthe lines\x1b[2J".to_string()),
                from: Some("   ".to_string()),
            },
            at(0),
        )
        .unwrap();
    let card = board.card(1).unwrap();
    assert!(!card.title.contains('\x1b'), "{:?}", card.title);
    assert!(
        !card.title.contains('\n'),
        "a title is one row: {:?}",
        card.title
    );
    assert!(card.title.starts_with("\\x1b]0;pwned\\x07 two lines"));
    assert_eq!(card.title.chars().count(), MAX_TITLE_CHARS);
    assert!(card.title.ends_with('\u{2026}'));
    assert_eq!(card.ticket.as_deref(), Some("42"));
    assert_eq!(card.detail.as_deref(), Some("keep\nthe lines\\x1b[2J"));
    assert_eq!(card.from, None, "a blank poster is no poster");
}

#[test]
fn a_post_needs_a_kind_and_a_title() {
    let mut board = Board::default();
    let mut no_kind = card(CardKind::Task, None, "x");
    no_kind.kind = None;
    assert!(board.post(no_kind, at(0)).is_err());
    assert!(
        board
            .post(card(CardKind::Task, None, " \n "), at(0))
            .is_err()
    );
    assert!(board.cards.is_empty());
}

#[test]
fn the_board_refuses_cards_past_its_open_limit() {
    let mut board = Board::default();
    for n in 0..MAX_OPEN_CARDS {
        board
            .post(card(CardKind::Info, None, &format!("card {n}")), at(0))
            .unwrap();
    }
    let err = board
        .post(card(CardKind::Info, None, "one too many"), at(1))
        .unwrap_err();
    assert!(format!("{err}").contains("limit"), "{err}");
    // Updating an existing card is still allowed at the limit.
    board.cards[0].ticket = Some("t".to_string());
    assert!(
        board
            .post(card(CardKind::Info, Some("t"), "updated"), at(2))
            .is_ok()
    );
}

#[test]
fn resolve_and_reopen_round_trip() {
    let mut board = Board::default();
    board
        .post(card(CardKind::Confirm, None, "merge?"), at(0))
        .unwrap();
    assert!(board.resolve(1, Some("human"), Some("yes"), at(5)).unwrap());
    assert!(!board.resolve(1, Some("human"), None, at(6)).unwrap());
    let resolved = board.card(1).unwrap();
    assert_eq!(resolved.resolved_at, Some(at(5)));
    assert_eq!(resolved.resolved_by.as_deref(), Some("human"));
    assert_eq!(resolved.resolution.as_deref(), Some("yes"));
    assert_eq!(board.waiting_count(), 0);

    assert!(board.reopen(1, at(7)).unwrap());
    assert!(!board.reopen(1, at(8)).unwrap());
    let reopened = board.card(1).unwrap();
    assert!(reopened.is_open());
    assert_eq!(reopened.resolved_by, None);
    assert_eq!(board.waiting_count(), 1);

    assert!(board.resolve(9, None, None, at(9)).is_err());
    assert!(board.reopen(9, at(9)).is_err());
}

#[test]
fn open_cards_follow_the_column_order_newest_first() {
    let mut board = Board::default();
    board
        .post(card(CardKind::Info, None, "news"), at(0))
        .unwrap();
    board
        .post(card(CardKind::Validate, None, "old check"), at(1))
        .unwrap();
    board
        .post(card(CardKind::Task, None, "decide"), at(2))
        .unwrap();
    board
        .post(card(CardKind::Validate, None, "new check"), at(3))
        .unwrap();
    board
        .post(card(CardKind::Confirm, None, "done?"), at(4))
        .unwrap();
    board.resolve(5, None, None, at(5)).unwrap();
    let titles: Vec<&str> = board
        .open_cards()
        .iter()
        .map(|c| c.title.as_str())
        .collect();
    assert_eq!(titles, ["decide", "new check", "old check", "news"]);
    assert_eq!(board.waiting_count(), 3);
    assert_eq!(board.recently_resolved(5)[0].title, "done?");
}

#[test]
fn prune_keeps_every_open_card_and_the_newest_history() {
    let mut board = Board::default();
    for n in 0..(RESOLVED_HISTORY as i64 + 10) {
        board
            .post(card(CardKind::Info, None, &format!("r{n}")), at(n))
            .unwrap();
        let id = board.cards.last().unwrap().id.clone();
        board.resolve(id, None, None, at(n)).unwrap();
    }
    board
        .post(card(CardKind::Task, None, "still open"), at(0))
        .unwrap();
    board.prune();
    assert_eq!(board.cards.len(), RESOLVED_HISTORY + 1);
    assert!(board.cards.iter().any(|c| c.title == "still open"));
    assert!(
        !board.cards.iter().any(|c| c.title == "r0"),
        "the oldest went"
    );
    assert!(
        board.cards.iter().any(|c| c.title == "r209"),
        "the newest stayed"
    );
}

#[test]
fn compact_ages() {
    assert_eq!(compact_age(at(0), at(0)), "now");
    assert_eq!(compact_age(at(0), at(5)), "5m");
    assert_eq!(compact_age(at(0), at(125)), "2h");
    assert_eq!(compact_age(at(0), at(60 * 50)), "2d");
    assert_eq!(
        compact_age(at(5), at(0)),
        "now",
        "a clock skew is not negative"
    );
}

#[test]
fn the_store_round_trips_and_writes_an_owner_only_file() {
    let dir = tempfile::tempdir().unwrap();
    let store = BoardStore::new(dir.path());
    assert_eq!(
        store.load().unwrap(),
        Board::default(),
        "no file is an empty board"
    );
    let id = store
        .update(|board| board.post(card(CardKind::Task, Some("1"), "a"), at(0)))
        .unwrap()
        .id();
    let board = store.load().unwrap();
    assert_eq!(board.version, BOARD_VERSION);
    assert_eq!(board.card(id).unwrap().title, "a");
    let mode = fs::metadata(store.path()).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
    let leftovers: Vec<_> = fs::read_dir(dir.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|name| name.contains(".tmp."))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

#[test]
fn a_failed_change_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let store = BoardStore::new(dir.path());
    store
        .update(|board| board.post(card(CardKind::Task, None, "a"), at(0)))
        .unwrap();
    let before = fs::read(store.path()).unwrap();
    let err = store.update(|board| {
        board.post(card(CardKind::Task, None, "b"), at(1))?;
        board.resolve(99, None, None, at(1))
    });
    assert!(err.is_err());
    assert_eq!(fs::read(store.path()).unwrap(), before);
}

#[test]
fn an_unreadable_board_is_an_error_and_is_never_overwritten() {
    let dir = tempfile::tempdir().unwrap();
    let store = BoardStore::new(dir.path());
    fs::write(store.path(), b"{ not json").unwrap();
    let err = store.load().unwrap_err();
    assert!(format!("{err:#}").contains("never overwritten"), "{err:#}");
    assert!(
        store
            .update(|board| board.post(card(CardKind::Task, None, "a"), at(0)))
            .is_err()
    );
    assert_eq!(fs::read(store.path()).unwrap(), b"{ not json");
}

#[test]
fn a_board_from_a_newer_yaran_is_read_but_not_rewritten() {
    let dir = tempfile::tempdir().unwrap();
    let store = BoardStore::new(dir.path());
    let newer = format!(
        "{{\"version\": {}, \"next_id\": 1, \"cards\": [], \"future\": true}}",
        BOARD_VERSION + 1
    );
    fs::write(store.path(), &newer).unwrap();
    assert!(store.load().is_ok());
    let err = store
        .update(|board| board.post(card(CardKind::Task, None, "a"), at(0)))
        .unwrap_err();
    assert!(format!("{err}").contains("newer yaran"), "{err}");
    assert_eq!(fs::read_to_string(store.path()).unwrap(), newer);
}

/// Many writers at once, as when several agents post in the same second:
/// every card lands, each with its own number.
#[test]
fn concurrent_writers_never_lose_a_card() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let handles: Vec<_> = (0..8)
        .map(|writer| {
            let root = root.clone();
            std::thread::spawn(move || {
                let store = BoardStore::new(&root);
                for n in 0..10 {
                    store
                        .update(|board| {
                            board.post(
                                card(CardKind::Info, None, &format!("w{writer} n{n}")),
                                Utc::now(),
                            )
                        })
                        .unwrap();
                }
            })
        })
        .collect();
    for handle in handles {
        handle.join().unwrap();
    }
    let board = BoardStore::new(&root).load().unwrap();
    assert_eq!(board.cards.len(), 80);
    let mut ids: Vec<u64> = board.cards.iter().map(|c| c.id.number()).collect();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), 80, "every card has its own number");
}

#[test]
fn the_watcher_reports_at_once_and_again_on_every_change() {
    let dir = tempfile::tempdir().unwrap();
    let store = BoardStore::new(dir.path());
    let watcher = BoardWatcher::spawn(store.clone(), Duration::from_millis(10)).unwrap();
    let wait = Duration::from_secs(5);

    let first = watcher.next_within(wait).unwrap();
    assert_eq!(first.board.unwrap(), Board::default());

    store
        .update(|board| board.post(card(CardKind::Task, None, "a"), at(0)))
        .unwrap();
    let second = watcher.next_within(wait).unwrap();
    assert_eq!(second.board.unwrap().cards.len(), 1);

    fs::write(store.path(), b"garbage").unwrap();
    let third = watcher.next_within(wait).unwrap();
    assert!(third.board.is_err());

    // Nothing changes, nothing is sent.
    assert!(watcher.next_within(Duration::from_millis(100)).is_none());
}

#[test]
fn latest_skips_to_the_newest_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let store = BoardStore::new(dir.path());
    let watcher = BoardWatcher::spawn(store.clone(), Duration::from_millis(5)).unwrap();
    for n in 0..3 {
        store
            .update(|board| board.post(card(CardKind::Info, None, &format!("{n}")), at(n)))
            .unwrap();
        std::thread::sleep(Duration::from_millis(40));
    }
    let latest = watcher.latest().expect("snapshots were sent");
    assert_eq!(latest.board.unwrap().cards.len(), 3);
    assert!(watcher.latest().is_none(), "nothing new since");
}

fn sample_card() -> Card {
    let mut board = Board::default();
    board
        .post(
            card(CardKind::Validate, Some("mvp-7"), "Check the signup page"),
            at(0),
        )
        .unwrap();
    board.cards.remove(0)
}

#[test]
fn a_reply_prompt_names_the_card_it_answers() {
    let card = sample_card();
    assert_eq!(
        render_reply(DEFAULT_REPLY_TEMPLATE, &card, "  looks good, ship it "),
        "Reply to board card #1 [mvp-7] (Check the signup page): looks good, ship it"
    );
    assert_eq!(render_reply("{ticket}: {reply}", &card, "ok"), "mvp-7: ok");
}

#[test]
fn a_reply_is_never_lost_to_the_template() {
    let card = sample_card();
    assert_eq!(render_reply("", &card, "just this"), "just this");
    assert_eq!(
        render_reply("About {card}", &card, "forgot the slot"),
        "About #1 [mvp-7] forgot the slot"
    );
    assert_eq!(
        render_reply("Line one\n{reply}\nend", &card, "x"),
        "Line one x end",
        "a prompt is one line"
    );
}

#[test]
fn a_long_title_is_cut_in_the_prompt() {
    let mut card = sample_card();
    card.title = "t".repeat(REPLY_TITLE_CHARS + 40);
    let prompt = render_reply("{title}|{reply}", &card, "r");
    let (title, reply) = prompt.split_once('|').unwrap();
    assert_eq!(title.chars().count(), REPLY_TITLE_CHARS);
    assert_eq!(reply, "r");
}

#[test]
fn priorities_parse_their_names_and_tracker_words() {
    for p in Priority::ALL {
        assert_eq!(Priority::parse(p.as_str()), Some(p));
    }
    assert_eq!(Priority::parse("Blocker"), Some(Priority::Critical));
    assert_eq!(Priority::parse("p0"), Some(Priority::Critical));
    assert_eq!(Priority::parse("URGENT"), Some(Priority::Critical));
    assert_eq!(Priority::parse("medium"), Some(Priority::Normal));
    assert_eq!(Priority::parse("minor"), Some(Priority::Low));
    assert_eq!(Priority::parse("whenever"), None);
    assert!(Priority::Critical < Priority::High && Priority::High < Priority::Normal);
    assert!(Priority::Critical.is_urgent() && Priority::High.is_urgent());
    assert!(!Priority::Normal.is_urgent() && !Priority::Low.is_urgent());
    assert_eq!(Priority::default(), Priority::Normal);
}

#[test]
fn urgent_cards_come_first_within_their_kind() {
    let mut board = Board::default();
    let mut post = |priority, title, minute| {
        let mut c = card(CardKind::Task, None, title);
        c.priority = priority;
        board.post(c, at(minute)).unwrap();
    };
    post(None, "plain old", 0);
    post(Some(Priority::Low), "low new", 1);
    post(Some(Priority::High), "high old", 2);
    post(None, "plain new", 3);
    post(Some(Priority::Critical), "critical", 4);
    post(Some(Priority::High), "high new", 5);
    let titles: Vec<&str> = board
        .open_cards()
        .iter()
        .map(|c| c.title.as_str())
        .collect();
    assert_eq!(
        titles,
        [
            "critical",
            "high new",
            "high old",
            "plain new",
            "plain old",
            "low new"
        ]
    );
    assert_eq!(board.urgent_count(), 3);
}

#[test]
fn a_repost_keeps_the_priority_unless_it_names_one() {
    let mut board = Board::default();
    let mut first = card(CardKind::Confirm, Some("9"), "merge?");
    first.priority = Some(Priority::High);
    board.post(first, at(0)).unwrap();
    board
        .post(card(CardKind::Confirm, Some("9"), "merge now?"), at(1))
        .unwrap();
    assert_eq!(board.card(1).unwrap().priority, Priority::High, "kept");
    let mut lowered = card(CardKind::Confirm, Some("9"), "merge whenever");
    lowered.priority = Some(Priority::Low);
    board.post(lowered, at(2)).unwrap();
    assert_eq!(board.card(1).unwrap().priority, Priority::Low);
    assert!(board.set_priority(1, Priority::Critical, at(3)).unwrap());
    assert!(!board.set_priority(1, Priority::Critical, at(4)).unwrap());
    assert_eq!(board.card(1).unwrap().updated_at, at(3));
    assert!(board.set_priority(7, Priority::Low, at(5)).is_err());
}

#[test]
fn a_board_without_priorities_reads_as_normal_and_normal_is_not_written() {
    let dir = tempfile::tempdir().unwrap();
    let store = BoardStore::new(dir.path());
    fs::write(
        store.path(),
        r#"{"version":1,"next_id":2,"cards":[{"id":1,"kind":"task","title":"old","created_at":"2026-10-11T12:00:00Z","updated_at":"2026-10-11T12:00:00Z"}]}"#,
    )
    .unwrap();
    let board = store.load().unwrap();
    assert_eq!(board.card(1).unwrap().priority, Priority::Normal);
    store
        .update(|board| {
            let mut c = card(CardKind::Task, None, "urgent one");
            c.priority = Some(Priority::Critical);
            board.post(c, at(0))
        })
        .unwrap();
    let text = fs::read_to_string(store.path()).unwrap();
    assert_eq!(
        text.matches("\"priority\"").count(),
        1,
        "only the critical card carries the field"
    );
    assert!(text.contains("\"priority\": \"critical\""));
}
