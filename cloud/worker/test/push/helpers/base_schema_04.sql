-- Stand-in for the tables of Phase 04's migrations/0001_init.sql that the push module
-- touches, copied from the Phase 04 plan §12. The integrator replaces it with 04's real
-- migration when cloud/worker lands; nothing outside this harness reads it.
CREATE TABLE settings (
  key         TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 64),
  value       TEXT NOT NULL CHECK (json_valid(value)),
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT
);
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  slug          TEXT NOT NULL UNIQUE,
  role          TEXT NOT NULL DEFAULT 'user'   CHECK (role IN ('user','admin')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  access_sub    TEXT,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER
);
CREATE TABLE devices (
  id                     TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL REFERENCES users(id),
  install_id             TEXT NOT NULL,
  platform               TEXT NOT NULL CHECK (platform IN ('android','ios')),
  flavor                 TEXT NOT NULL CHECK (flavor IN ('foss','play','appstore','dev')),
  form_factor            TEXT NOT NULL CHECK (form_factor IN ('phone','tablet')),
  locale                 TEXT CHECK (locale IS NULL OR length(locale) <= 35),
  push_kind              TEXT NOT NULL CHECK (push_kind IN ('unifiedpush','fcm_embedded','apns_relay','fcm_relay','none')),
  push_distributor       TEXT CHECK (push_distributor IS NULL OR length(push_distributor) <= 128),
  endpoint_enc           TEXT,
  endpoint_host          TEXT,
  p256dh                 BLOB,
  auth_enc               TEXT,
  push_vapid_public_key  BLOB CHECK (push_vapid_public_key IS NULL OR length(push_vapid_public_key) = 65),
  device_key             BLOB NOT NULL CHECK (length(device_key) = 65),
  device_key_fingerprint TEXT NOT NULL CHECK (length(device_key_fingerprint) = 29),
  app_version            TEXT NOT NULL CHECK (length(app_version) <= 48),
  label                  TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 64),
  created_at             INTEGER NOT NULL,
  last_seen_at           INTEGER,
  revoked_at             INTEGER,
  revoked_by             TEXT,
  UNIQUE (user_id, install_id)
);
CREATE INDEX devices_by_user ON devices(user_id, revoked_at);
