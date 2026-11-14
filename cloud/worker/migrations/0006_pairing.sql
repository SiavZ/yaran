-- Phase 06: the columns and table machine pairing, the control-plane handoff and the
-- device registry need beyond 04's baseline (0001_init.sql). Applied once by the D1
-- migrations table, so it is idempotent in the D1 sense; append-only after the first
-- yaran-cloud-v* tag (04 design §12).

-- Pair requests: the state is kept sealed (purpose pair_state) beside 04's state_hash,
-- because the confirm POST must redirect to the loopback callback with it; the confirm
-- page's csrf is stored hashed; the code lives 120 s inside the request's 10 minutes.
ALTER TABLE pair_requests ADD COLUMN state_enc TEXT;
ALTER TABLE pair_requests ADD COLUMN yaran_version TEXT CHECK (yaran_version IS NULL OR length(yaran_version) <= 40);
ALTER TABLE pair_requests ADD COLUMN replaces_machine_id TEXT REFERENCES machines(id);
ALTER TABLE pair_requests ADD COLUMN csrf_hash BLOB CHECK (csrf_hash IS NULL OR length(csrf_hash) = 32);
ALTER TABLE pair_requests ADD COLUMN code_expires_at INTEGER;
CREATE INDEX pair_requests_by_user ON pair_requests(user_id, status);

-- The machine a Replace pairing superseded points at its successor.
ALTER TABLE machines ADD COLUMN replaced_by TEXT REFERENCES machines(id);

-- Device push state and mutes, in Phase 08's design (08 owns their delivery semantics;
-- 06 writes push_state on registration and the mutes on PATCH /v1/me/devices/{id}).
-- 0008_push.sql adds the delivery counters 08 alone uses.
-- active | gone (subscription cleared, row kept) | auth_failed (VAPID mismatch) |
-- failing (5 exhausted pushes in a row) | none (no subscription).
ALTER TABLE devices ADD COLUMN push_state TEXT NOT NULL DEFAULT 'none'
  CHECK (push_state IN ('active','gone','auth_failed','failing','none'));
-- Last 2xx from the push service; served as Device.push.last_success_at.
ALTER TABLE devices ADD COLUMN last_push_ok_at INTEGER;
-- Per-org mutes (02 DevicePatch): indefinite, and timed (Unix seconds, NULL = not muted).
ALTER TABLE devices ADD COLUMN mute_all INTEGER NOT NULL DEFAULT 0 CHECK (mute_all IN (0, 1));
ALTER TABLE devices ADD COLUMN muted_until INTEGER;

-- Per-machine mutes (02 muted_machine_ids, at most 100 per device, enforced by 06).
CREATE TABLE device_machine_mutes (
  device_id   TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  machine_id  TEXT NOT NULL,
  PRIMARY KEY (device_id, machine_id)
) WITHOUT ROWID;

-- One row per consent page the handoff GET rendered: the csrf token (hashed) bound to the
-- request's state, pk and dk plus the GET's device-signature verdict (D24). Single use,
-- 10 minutes, purged by the pairing sweep.
CREATE TABLE handoff_csrf (
  token_hash      BLOB PRIMARY KEY CHECK (length(token_hash) = 32),
  state_hash      BLOB NOT NULL CHECK (length(state_hash) = 32),
  pk_thumbprint   TEXT NOT NULL CHECK (length(pk_thumbprint) = 43),
  dk_fingerprint  TEXT NOT NULL CHECK (length(dk_fingerprint) = 29),
  verified        INTEGER NOT NULL CHECK (verified IN (0, 1)),
  user_id         TEXT NOT NULL REFERENCES users(id),
  expires_at      INTEGER NOT NULL,
  used_at         INTEGER
) WITHOUT ROWID;
CREATE INDEX handoff_csrf_by_expiry ON handoff_csrf(expires_at);
