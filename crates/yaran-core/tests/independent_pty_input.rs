//! Phone input keeps the shared desktop grid and the terminal query gate.
use yaran_core::pty_owners::PtySizeOwners;

#[test]
fn an_independent_views_typing_preserves_the_holder_and_query_reply_gate() {
    use yaran_core::pty::PtyWriteKind;
    let owners = PtySizeOwners::default();
    let desktop = owners.next_conn_id();
    let phone = owners.next_conn_id();
    owners.claim("s1-slot", desktop).unwrap();
    let before = owners.current_owner("s1-slot");
    let verdict = owners.note_write_preserving_size("s1-slot", phone, PtyWriteKind::Typing);
    assert!(verdict.forward);
    assert!(verdict.epoch.is_none() && verdict.grids.is_empty());
    assert_eq!(owners.current_owner("s1-slot"), before);
    assert!(
        !owners
            .note_write_preserving_size("s1-slot", phone, PtyWriteKind::QueryReply)
            .forward
    );
    assert!(
        !owners
            .note_write_preserving_size("s1-slot", phone, PtyWriteKind::Ignored)
            .forward
    );
    owners.release("s1-slot", desktop);
    assert!(
        owners
            .note_write_preserving_size("s1-slot", phone, PtyWriteKind::Typing)
            .forward
    );
    assert!(owners.current_owner("s1-slot").0.is_none());
}
