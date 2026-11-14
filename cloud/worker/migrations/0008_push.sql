-- Phase 08: push delivery state, mutes, event dedupe and daily push counters.
-- Semantics are 08's (04 §12 devices comment); 06 writes push_state on registration and the
-- mutes on PATCH /v1/me/devices/{id}, the push module writes the delivery outcome.

-- active | gone (subscription cleared, row kept) | auth_failed (VAPID mismatch) |
-- failing (5 exhausted pushes in a row) | none (no subscription).
ALTER TABLE devices ADD COLUMN push_state TEXT NOT NULL DEFAULT 'none'
  CHECK (push_state IN ('active','gone','auth_failed','failing','none'));
-- Last 2xx from the push service, written at most hourly; served as Device.push.last_success_at.
ALTER TABLE devices ADD COLUMN last_push_ok_at INTEGER;
-- Exhausted pushes since the last success; 5 turns the device failing.
ALTER TABLE devices ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
-- Per-org mutes (02 DevicePatch): indefinite, and timed (Unix seconds, NULL = not muted).
ALTER TABLE devices ADD COLUMN mute_all INTEGER NOT NULL DEFAULT 0 CHECK (mute_all IN (0, 1));
ALTER TABLE devices ADD COLUMN muted_until INTEGER;

-- A device registered before this migration with a live subscription is active.
UPDATE devices SET push_state = 'active'
  WHERE push_kind <> 'none' AND endpoint_enc IS NOT NULL AND revoked_at IS NULL;

-- Per-machine mutes (02 muted_machine_ids, at most 100 per device, enforced by 06).
CREATE TABLE device_machine_mutes (
  device_id   TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  machine_id  TEXT NOT NULL,
  PRIMARY KEY (device_id, machine_id)
) WITHOUT ROWID;

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
