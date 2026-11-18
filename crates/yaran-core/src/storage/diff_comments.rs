//! The `session_diff_comments` table: diff comments queued per agent.
//!
//! One row per commented line, keyed by the agent and the whole anchor (file,
//! side, line number and line text), so editing a comment replaces its row
//! rather than adding a second one. The agent's own delete paths remove its
//! rows explicitly, including on soft deletion; the declared foreign-key
//! cascade also covers hard deletion when foreign keys are enabled.

use anyhow::{Context, Result};
use jiff::Timestamp;
use rusqlite::params;

use super::SessionStore;
use crate::diff_comments::{DiffAnchor, DiffComment, DiffSide};
use crate::timefmt::Rfc3339;

impl SessionStore {
    /// The diff-comments workstream's block of `migrate()`: create the table
    /// on a database that predates it, and drop rows whose agent is gone (an
    /// older binary's delete did not know about them). Idempotent.
    pub(super) fn migrate_diff_comments(&self) -> Result<()> {
        self.conn.execute_batch(
            r"
            create table if not exists session_diff_comments (
                session_id text not null,
                rel_path text not null,
                side text not null,
                line_number integer not null,
                line_content text not null,
                comment_text text not null,
                created_at text not null,
                updated_at text not null,
                primary key (session_id, rel_path, side, line_number, line_content),
                foreign key (session_id) references agent_sessions(id) on delete cascade
            );
            ",
        )?;
        self.conn
            .execute(
                "delete from session_diff_comments \
                 where session_id not in (select id from agent_sessions where deleted_at is null)",
                [],
            )
            .context("failed to sweep diff comments whose agent no longer exists")?;
        Ok(())
    }

    /// Queue `comment`, or replace the text of the one already on its line.
    ///
    /// # Errors
    ///
    /// Fails when the write is refused.
    pub fn upsert_diff_comment(&self, comment: &DiffComment) -> Result<()> {
        let now = Timestamp::now().to_rfc3339();
        let anchor = &comment.anchor;
        self.conn.execute(
            "insert into session_diff_comments \
                 (session_id, rel_path, side, line_number, line_content, comment_text, \
                  created_at, updated_at) \
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7) \
             on conflict(session_id, rel_path, side, line_number, line_content) do update set \
                 comment_text = excluded.comment_text, updated_at = excluded.updated_at",
            params![
                comment.session_id,
                anchor.rel_path,
                anchor.side.as_str(),
                i64::try_from(anchor.line_number).unwrap_or(i64::MAX),
                anchor.line_content,
                comment.text,
                now,
            ],
        )?;
        Ok(())
    }

    /// Drop the comment on one line of one agent's diff. Dropping one that is
    /// not there is a no-op.
    ///
    /// # Errors
    ///
    /// Fails when the write is refused.
    pub fn delete_diff_comment(&self, session_id: &str, anchor: &DiffAnchor) -> Result<()> {
        self.conn.execute(
            "delete from session_diff_comments where session_id = ?1 and rel_path = ?2 \
             and side = ?3 and line_number = ?4 and line_content = ?5",
            params![
                session_id,
                anchor.rel_path,
                anchor.side.as_str(),
                i64::try_from(anchor.line_number).unwrap_or(i64::MAX),
                anchor.line_content,
            ],
        )?;
        Ok(())
    }

    /// Drop every comment queued for one agent.
    ///
    /// # Errors
    ///
    /// Fails when the write is refused.
    pub fn delete_diff_comments_for_session(&self, session_id: &str) -> Result<()> {
        self.conn.execute(
            "delete from session_diff_comments where session_id = ?1",
            params![session_id],
        )?;
        Ok(())
    }

    /// Every queued comment, for every agent, in agent, file and line order.
    ///
    /// # Errors
    ///
    /// Fails when the read fails.
    pub fn load_diff_comments(&self) -> Result<Vec<DiffComment>> {
        let mut stmt = self.conn.prepare(
            "select session_id, rel_path, side, line_number, line_content, comment_text \
             from session_diff_comments \
             order by session_id, rel_path, line_number, side, line_content",
        )?;
        let rows = stmt.query_map([], |row| {
            let side: String = row.get(2)?;
            let line: i64 = row.get(3)?;
            Ok(DiffComment {
                session_id: row.get(0)?,
                anchor: DiffAnchor {
                    rel_path: row.get(1)?,
                    side: DiffSide::parse(&side),
                    line_number: usize::try_from(line).unwrap_or(0),
                    line_content: row.get(4)?,
                },
                text: row.get(5)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("failed to read the queued diff comments")
    }
}

#[cfg(test)]
mod tests {
    use super::super::{test_session, test_store};
    use super::*;

    fn comment(session_id: &str, line: usize, text: &str) -> DiffComment {
        DiffComment {
            session_id: session_id.to_string(),
            anchor: DiffAnchor {
                rel_path: "README.md".to_string(),
                side: DiffSide::New,
                line_number: line,
                line_content: "## title".to_string(),
            },
            text: text.to_string(),
        }
    }

    #[test]
    fn a_comment_round_trips_and_an_edit_replaces_it() {
        let store = test_store();
        let now = Timestamp::now();
        store.create_session(&test_session("s1", now, now)).unwrap();
        store
            .upsert_diff_comment(&comment("s1", 45, "Use an h4"))
            .unwrap();
        store
            .upsert_diff_comment(&comment("s1", 45, "Use h4 here"))
            .unwrap();
        let mut old_side = comment("s1", 45, "removed line");
        old_side.anchor.side = DiffSide::Old;
        store.upsert_diff_comment(&old_side).unwrap();

        let loaded = store.load_diff_comments().unwrap();
        assert_eq!(loaded.len(), 2, "the edit replaced its row: {loaded:?}");
        assert!(loaded.contains(&comment("s1", 45, "Use h4 here")));
        assert!(loaded.contains(&old_side));

        store.delete_diff_comment("s1", &old_side.anchor).unwrap();
        assert_eq!(store.load_diff_comments().unwrap().len(), 1);
        store.delete_diff_comments_for_session("s1").unwrap();
        assert_eq!(store.load_diff_comments().unwrap(), Vec::new());
    }

    #[test]
    fn every_way_an_agent_leaves_takes_its_comments() {
        let store = test_store();
        let now = Timestamp::now();
        for id in ["hard", "soft", "kept"] {
            store.create_session(&test_session(id, now, now)).unwrap();
            store.upsert_diff_comment(&comment(id, 1, "note")).unwrap();
        }
        store.delete_session("hard").unwrap();
        store.soft_delete_session("soft").unwrap();
        let left: Vec<String> = store
            .load_diff_comments()
            .unwrap()
            .into_iter()
            .map(|c| c.session_id)
            .collect();
        assert_eq!(left, vec!["kept".to_string()]);
    }

    #[test]
    fn the_migration_sweeps_orphans_and_is_idempotent() {
        let store = test_store();
        let now = Timestamp::now();
        store.create_session(&test_session("s1", now, now)).unwrap();
        store
            .upsert_diff_comment(&comment("s1", 1, "kept"))
            .unwrap();
        // An older binary deleted this agent without knowing about the table
        // (and on a connection that did not check the foreign key).
        store
            .conn
            .execute_batch("pragma foreign_keys = off;")
            .unwrap();
        store
            .upsert_diff_comment(&comment("gone", 1, "orphan"))
            .unwrap();
        store.migrate_diff_comments().unwrap();
        store.migrate_diff_comments().unwrap();
        let left = store.load_diff_comments().unwrap();
        assert_eq!(left, vec![comment("s1", 1, "kept")]);
    }
}
