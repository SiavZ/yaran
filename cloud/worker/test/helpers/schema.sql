-- Test-only subset of Phase 04's migrations/0001_init.sql (04 plan §D1 schema): the
-- tables and columns Phase 07's queries read. Replace with 04's real migrations on merge.
CREATE TABLE settings (
  key TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 64),
  value TEXT NOT NULL CHECK (json_valid(value)),
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
  slug TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  access_sub TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);
CREATE TABLE machines (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user','admin','machine','system','setup')),
  actor_id TEXT,
  action TEXT NOT NULL,
  target_kind TEXT,
  target_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok','denied','failed')),
  error_code TEXT,
  request_id TEXT,
  ip TEXT,
  country TEXT,
  detail TEXT
);
