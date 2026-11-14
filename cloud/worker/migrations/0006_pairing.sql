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

-- Device delivery health and mutes (06 registration; 08 writes delivery outcomes through
-- 06's devices repository). push_state 'none' is a registration without push.
ALTER TABLE devices ADD COLUMN push_state TEXT NOT NULL DEFAULT 'none'
  CHECK (push_state IN ('active','gone','auth_failed','failing','none'));
ALTER TABLE devices ADD COLUMN push_last_success_at INTEGER;
ALTER TABLE devices ADD COLUMN push_last_error_code TEXT CHECK (push_last_error_code IS NULL OR length(push_last_error_code) <= 64);
ALTER TABLE devices ADD COLUMN mute_all INTEGER NOT NULL DEFAULT 0 CHECK (mute_all IN (0, 1));
ALTER TABLE devices ADD COLUMN muted_until INTEGER;
ALTER TABLE devices ADD COLUMN muted_machine_ids TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(muted_machine_ids) AND json_type(muted_machine_ids) = 'array');

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
