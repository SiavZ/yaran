-- Mirror of the Phase 04 tables the provisioning engine touches (04 §12, migrations/0001_init.sql).
-- Used only until 04's migrations/ directory exists; d1.ts then loads the real migrations instead.
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
  instance_id               TEXT NOT NULL,
  owner_user_id             TEXT NOT NULL REFERENCES users(id),
  name                      TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 32 AND name NOT GLOB '*[^a-z0-9-]*'),
  slug                      TEXT NOT NULL CHECK (length(slug) BETWEEN 1 AND 32 AND slug NOT GLOB '*[^a-z0-9-]*'),
  hostname                  TEXT UNIQUE,
  public_key                BLOB NOT NULL CHECK (length(public_key) = 32),
  origin_port               INTEGER NOT NULL DEFAULT 3890 CHECK (origin_port BETWEEN 1 AND 65535),
  ingress_origin_port       INTEGER CHECK (ingress_origin_port BETWEEN 1 AND 65535),
  yaran_version             TEXT CHECK (length(yaran_version) <= 40),
  reported_protocol         INTEGER,
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
  revoked_by                TEXT,
  revoke_reason             TEXT CHECK (revoke_reason IN
                              ('user_unpair','admin_revoke','machine_logout','user_disabled','stale','provision_failed'))
);
CREATE TABLE audit_log (
  id           TEXT PRIMARY KEY,
  at           INTEGER NOT NULL,
  actor_kind   TEXT NOT NULL CHECK (actor_kind IN ('user','admin','machine','system','setup')),
  actor_id     TEXT,
  action       TEXT NOT NULL,
  target_kind  TEXT CHECK (target_kind IS NULL OR target_kind IN ('org','user','machine','device','settings')),
  target_id    TEXT,
  outcome      TEXT NOT NULL CHECK (outcome IN ('ok','denied','failed')),
  error_code   TEXT,
  request_id   TEXT,
  ip           TEXT,
  country      TEXT CHECK (country IS NULL OR length(country) = 2),
  detail       TEXT CHECK (detail IS NULL OR (json_valid(detail) AND length(detail) <= 2048))
);
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
CREATE TABLE cf_orphans (
  resource_kind  TEXT NOT NULL CHECK (resource_kind IN ('tunnel','dns_record','access_app','access_policy')),
  resource_id    TEXT NOT NULL,
  marker         TEXT NOT NULL,
  first_seen_at  INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,
  seen_count     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (resource_kind, resource_id)
) WITHOUT ROWID;
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
