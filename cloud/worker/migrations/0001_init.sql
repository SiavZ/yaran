-- Phase 04 initial schema for the yaran control-plane D1 database.
-- Editable until the first yaran-cloud-v* tag; after that, migrations are append-only and
-- immutable (later phases add 000N_*.sql). Timestamps are Unix seconds; ids are lowercase
-- UUID v4 text minted in code. Foreign keys are enforced by D1 by default.

-- Settings: one row per key, value is validated JSON (schema in src/db/settings.ts).
CREATE TABLE settings (
  key         TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 64),
  value       TEXT NOT NULL CHECK (json_valid(value)),
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT
);

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 320),
  slug          TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 1 AND 24 AND slug NOT GLOB '*[^a-z0-9-]*'),
  role          TEXT NOT NULL DEFAULT 'user'   CHECK (role IN ('user','admin')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  access_sub    TEXT,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER
);

CREATE TABLE machines (
  id                        TEXT PRIMARY KEY,
  instance_id               TEXT NOT NULL,          -- settings.instance_id at creation (05 resource markers)
  owner_user_id             TEXT NOT NULL REFERENCES users(id),
  name                      TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 32 AND name NOT GLOB '*[^a-z0-9-]*'),  -- 02 MachineName (full pattern checked in code)
  slug                      TEXT NOT NULL CHECK (length(slug) BETWEEN 1 AND 32 AND slug NOT GLOB '*[^a-z0-9-]*'),
  hostname                  TEXT UNIQUE,            -- NULL once released after revoke
  public_key                BLOB NOT NULL CHECK (length(public_key) = 32),
  origin_port               INTEGER NOT NULL DEFAULT 3890 CHECK (origin_port BETWEEN 1 AND 65535),  -- desired (02 OriginPort)
  ingress_origin_port       INTEGER CHECK (ingress_origin_port BETWEEN 1 AND 65535),             -- port the live ingress targets (05 P4)
  yaran_version             TEXT CHECK (length(yaran_version) <= 40),                            -- from W4 claim (06)
  reported_protocol         INTEGER,                                                             -- last verified Yaran-Protocol (§5)
  status                    TEXT NOT NULL CHECK (status IN
                              ('provisioning','awaiting_claim','active','revoking','revoked','failed')),
  access_policy_id          TEXT,
  access_app_id             TEXT,
  access_app_aud            TEXT,
  tunnel_id                 TEXT UNIQUE,
  dns_record_id             TEXT,
  tunnel_secret_generation  INTEGER NOT NULL DEFAULT 1,
  ingress_version           INTEGER,
  cf_status                 TEXT CHECK (cf_status IN ('inactive','degraded','healthy','down','unknown')),
  cf_status_at              INTEGER,
  conns_active_at           TEXT,
  conns_inactive_at         TEXT,
  created_at                INTEGER NOT NULL,
  claimed_at                INTEGER,
  last_seen_at              INTEGER,
  revoked_at                INTEGER,
  revoked_by                TEXT,                   -- user id, 'system', or 'machine'
  revoke_reason             TEXT CHECK (revoke_reason IN
                              ('user_unpair','admin_revoke','machine_logout','user_disabled','stale','provision_failed'))
);
CREATE INDEX machines_by_owner  ON machines(owner_user_id, status);
CREATE INDEX machines_by_status ON machines(status);

-- Column semantics owned by 06; 06 may amend via a new migration before the first release.
CREATE TABLE pair_requests (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id),
  state_hash          BLOB NOT NULL CHECK (length(state_hash) = 32),
  code_hash           BLOB UNIQUE CHECK (code_hash IS NULL OR length(code_hash) = 32),
  code_challenge      TEXT NOT NULL CHECK (length(code_challenge) = 43),
  machine_public_key  BLOB NOT NULL CHECK (length(machine_public_key) = 32),
  machine_name        TEXT NOT NULL CHECK (length(machine_name) BETWEEN 1 AND 32),   -- 02 MachineName
  callback_port       INTEGER NOT NULL CHECK (callback_port BETWEEN 1024 AND 65535),
  origin_port         INTEGER NOT NULL DEFAULT 3890 CHECK (origin_port BETWEEN 1 AND 65535),  -- PairAuthorizeQuery.origin_port
  machine_id          TEXT REFERENCES machines(id),
  status              TEXT NOT NULL CHECK (status IN ('pending','confirmed','claimed','expired','cancelled')),
  created_at          INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL,
  claimed_at          INTEGER
);
CREATE INDEX pair_requests_by_expiry ON pair_requests(status, expires_at);

-- Column semantics owned by 06 (registration, 02 DeviceRegistration) and 08 (delivery).
-- push_kind 'none' is wire push.kind = none; any other value is push.kind = webpush with that channel.
-- Delivery state (push_state, last success, failure counter) and mutes (mute_all, muted_until,
-- per-machine mutes) are added by 08's push migration, which owns their semantics.
CREATE TABLE devices (
  id                     TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL REFERENCES users(id),
  install_id             TEXT NOT NULL,   -- 02 InstallId; equals the Yaran-Install-Id header (W12)
  platform               TEXT NOT NULL CHECK (platform IN ('android','ios')),
  flavor                 TEXT NOT NULL CHECK (flavor IN ('foss','play','appstore','dev')),
  form_factor            TEXT NOT NULL CHECK (form_factor IN ('phone','tablet')),
  locale                 TEXT CHECK (locale IS NULL OR length(locale) <= 35),
  push_kind              TEXT NOT NULL CHECK (push_kind IN ('unifiedpush','fcm_embedded','apns_relay','fcm_relay','none')),
  push_distributor       TEXT CHECK (push_distributor IS NULL OR length(push_distributor) <= 128),
  endpoint_enc           TEXT,            -- data-key sealed (capability URL)
  endpoint_host          TEXT,            -- plain host for Device.push.endpoint_host
  p256dh                 BLOB,            -- public, stored plain
  auth_enc               TEXT,            -- data-key sealed
  push_vapid_public_key  BLOB CHECK (push_vapid_public_key IS NULL OR length(push_vapid_public_key) = 65),  -- org key at registration
  device_key             BLOB NOT NULL CHECK (length(device_key) = 65),   -- 02 §8.1 device key (public), fixed per install_id (D24)
  device_key_fingerprint TEXT NOT NULL CHECK (length(device_key_fingerprint) = 29),   -- 02 DeviceKeyFingerprint, kept after revocation
  app_version            TEXT NOT NULL CHECK (length(app_version) <= 48),   -- 02 SemVer
  label                  TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 64),
  created_at             INTEGER NOT NULL,
  last_seen_at           INTEGER,
  revoked_at             INTEGER,
  revoked_by             TEXT,
  UNIQUE (user_id, install_id)
);
CREATE INDEX devices_by_user ON devices(user_id, revoked_at);
CREATE INDEX devices_revoked_by_key ON devices(device_key_fingerprint) WHERE revoked_at IS NOT NULL;   -- 06 skip rule 5

CREATE TABLE audit_log (
  id           TEXT PRIMARY KEY,         -- Uuid (AuditEntry.id); pages ordered by (at, id)
  at           INTEGER NOT NULL,
  actor_kind   TEXT NOT NULL CHECK (actor_kind IN ('user','admin','machine','system','setup')),
  actor_id     TEXT,
  action       TEXT NOT NULL,            -- registry/audit-actions.json
  target_kind  TEXT CHECK (target_kind IS NULL OR target_kind IN ('org','user','machine','device','settings')),
  target_id    TEXT,
  outcome      TEXT NOT NULL CHECK (outcome IN ('ok','denied','failed')),
  error_code   TEXT,                     -- registry code when outcome <> 'ok'
  request_id   TEXT,
  ip           TEXT,
  country      TEXT CHECK (country IS NULL OR length(country) = 2),
  detail       TEXT CHECK (detail IS NULL OR (json_valid(detail) AND length(detail) <= 2048))
);
CREATE INDEX audit_by_time   ON audit_log(at);
CREATE INDEX audit_by_target ON audit_log(target_kind, target_id, at);
CREATE INDEX audit_by_actor  ON audit_log(actor_kind, actor_id, at);

CREATE TABLE machine_nonces (
  machine_id  TEXT NOT NULL,
  nonce       TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  PRIMARY KEY (machine_id, nonce)
) WITHOUT ROWID;
CREATE INDEX machine_nonces_by_expiry ON machine_nonces(expires_at);

-- Saga state (05). At most one live op per machine, enforced by the partial unique index.
CREATE TABLE provisioning_ops (
  id               TEXT PRIMARY KEY,
  machine_id       TEXT NOT NULL REFERENCES machines(id),
  kind             TEXT NOT NULL CHECK (kind IN ('provision','teardown','rotate','repair')),
  state            TEXT NOT NULL CHECK (state IN ('pending','running','succeeded','failed','compensating','compensated')),
  step             TEXT NOT NULL,
  attempt          INTEGER NOT NULL DEFAULT 0,
  params           TEXT CHECK (params IS NULL OR json_valid(params)),
  lease_owner      TEXT,
  lease_until      INTEGER,
  next_attempt_at  INTEGER NOT NULL,
  last_error_code  TEXT,
  last_error       TEXT CHECK (last_error IS NULL OR length(last_error) <= 1024),
  requested_by     TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE UNIQUE INDEX provisioning_ops_one_live ON provisioning_ops(machine_id)
  WHERE state IN ('pending','running','compensating');
CREATE INDEX provisioning_ops_due ON provisioning_ops(state, next_attempt_at);

-- Resources carrying this instance's marker but owned by no live machine (05).
CREATE TABLE cf_orphans (
  resource_kind  TEXT NOT NULL CHECK (resource_kind IN ('tunnel','dns_record','access_app','access_policy')),
  resource_id    TEXT NOT NULL,
  marker         TEXT NOT NULL,
  first_seen_at  INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,
  seen_count     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (resource_kind, resource_id)
) WITHOUT ROWID;

-- Last observed Cloudflare API budget (05), single row.
CREATE TABLE cf_api_budget (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  remaining      INTEGER,
  reset_at       INTEGER,
  blocked_until  INTEGER,
  observed_at    INTEGER NOT NULL
);

CREATE TABLE scheduled_tasks (
  task          TEXT PRIMARY KEY,
  next_run_at   INTEGER NOT NULL,
  cursor        TEXT,
  lease_until   INTEGER,
  last_ok_at    INTEGER,
  last_error    TEXT CHECK (last_error IS NULL OR length(last_error) <= 1024)
);

CREATE TABLE rate_counters (
  key           TEXT NOT NULL,
  window_start  INTEGER NOT NULL,
  count         INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
) WITHOUT ROWID;
