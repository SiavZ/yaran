-- Phase 08: push delivery state, mutes, event dedupe and daily push counters.
-- Semantics are 08's (04 §12 devices comment); 06 writes push_state on registration and the
-- mutes on PATCH /v1/me/devices/{id}, the push module writes the delivery outcome.
-- Append-only after the first yaran-cloud-v* tag; applied once by the migrations table.

-- push_state, last_push_ok_at, mute_all, muted_until and device_machine_mutes are added by
-- 0006_pairing.sql (06 registers devices before this phase delivers to them), in this
-- phase's design; this migration adds only what delivery alone uses.

-- Exhausted pushes since the last success; 5 turns the device failing.
ALTER TABLE devices ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;

-- W6 event id dedupe for 24 h, purged by the push_purge_event_ids dispatcher task.
CREATE TABLE event_ids (
  machine_id  TEXT NOT NULL,
  id          TEXT NOT NULL,
  seen_at     INTEGER NOT NULL,
  PRIMARY KEY (machine_id, id)
) WITHOUT ROWID;
CREATE INDEX event_ids_by_seen ON event_ids(seen_at);

-- Daily counters for the admin console (07): pushes queued, delivered (2xx), failed
-- (dropped as a bug or exhausted) and gone (404/410). day is UTC YYYY-MM-DD.
CREATE TABLE push_stats (
  day        TEXT PRIMARY KEY CHECK (length(day) = 10),
  accepted   INTEGER NOT NULL DEFAULT 0,
  delivered  INTEGER NOT NULL DEFAULT 0,
  failed     INTEGER NOT NULL DEFAULT 0,
  gone       INTEGER NOT NULL DEFAULT 0
);
