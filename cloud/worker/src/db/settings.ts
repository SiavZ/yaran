/**
 * The settings schema: every key the `settings` table may hold, its type, default,
 * validator and owning phase, plus validated reads and writes.
 *
 * Contract keys are exactly the top-level keys of Phase 02's `Settings` (W26), validated by
 * 02's schema through `@yaran/protocol` with 02's defaults; 07 renders and writes them.
 * Internal keys have no admin API (02 §6 note): setup state, Cloudflare identifiers,
 * generated keys and operational knobs. A phase adds an internal key by adding one line to
 * `InternalSettings` and one row to `INTERNAL`.
 *
 * - A missing key falls back to its default (null when it has none).
 * - An invalid stored value is a loud error naming the key, never a silent default.
 * - An unknown key is refused.
 *
 * <module-headers:begin>
 * Uses:
 * src/db/settings.ts
 * ├── @yaran/protocol:src/index.ts
 * └── src/db/client.ts
 * External: none
 *
 * Used by:
 * src/db/settings.ts
 * ├── src/auth/access-jwt.ts
 * ├── src/http/pipeline.ts
 * ├── src/scheduled/purge.ts
 * ├── src/security/data-key.ts
 * ├── test/data-key.test.ts
 * ├── test/helpers/seed.ts
 * ├── test/purge.test.ts
 * └── test/settings.test.ts
 * <module-headers:end>
 */
import { validate, type Settings } from "@yaran/protocol";
import { all, run, stmt } from "./client.ts";

export interface DataKeyState {
  version: number;
  check: string;
  previous_check: string | null;
}

export interface InternalSettings {
  setup_state: "open" | "closed";
  instance_id: string;
  account_id: string;
  zone_id: string;
  zone_name: string;
  control_plane_host: string;
  team_domain: string;
  control_plane_app_id: string;
  control_plane_aud: string;
  jwt_clock_tolerance_s: number;
  orphan_grace_minutes: number;
  vapid_public_key: string;
  vapid_private_key_enc: string;
  data_key_state: DataKeyState;
}

export type SettingValues = Settings & InternalSettings;
export type SettingKey = keyof SettingValues;

/** 02's defaults for the contract keys (see the `Settings` schema description). */
export const DEFAULT_SETTINGS: Settings = {
  org_name: "yaran",
  session_duration: "24h",
  pairing_policy: { mode: "everyone", emails: [], domains: [], access_group_ids: [] },
  machine_cap_per_user: 10,
  device_cap_per_user: 10,
  push: { enabled: true, detail: "names", ttl_seconds: 3600, relay_allowed: true, allowed_relays: [] },
  stale_machine_policy: { notify_after_days: 30, revoke_after_days: null },
  audit_retention_days: 365,
  quota_limits: { access_apps: 500, access_policies: 500, tunnels: 1000 },
  orphan_cleanup: "delete",
  deployer_repo_url: null,
};

interface Spec {
  default: unknown;
  valid(value: unknown): boolean;
  owner: string;
}

const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const TEAM_DOMAIN_RE = /^[a-z0-9-]+\.(?:fed\.)?cloudflareaccess\.com$/;
const B64URL_22 = /^[A-Za-z0-9_-]{22}$/;
const str = (max: number) => (v: unknown) => typeof v === "string" && v.length >= 1 && v.length <= max;
const int = (min: number, max: number) => (v: unknown) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const re = (r: RegExp) => (v: unknown) => typeof v === "string" && r.test(v);

const INTERNAL: { [K in keyof InternalSettings]: Spec } = {
  setup_state: { default: "open", valid: (v) => v === "open" || v === "closed", owner: "04/07" },
  instance_id: { default: null, valid: re(/^[0-9a-f]{8}$/), owner: "07" },
  account_id: { default: null, valid: str(64), owner: "07" },
  zone_id: { default: null, valid: str(64), owner: "07" },
  zone_name: { default: null, valid: re(HOST_RE), owner: "07" },
  control_plane_host: { default: null, valid: re(HOST_RE), owner: "07" },
  team_domain: { default: null, valid: re(TEAM_DOMAIN_RE), owner: "07" },
  control_plane_app_id: { default: null, valid: str(64), owner: "07" },
  control_plane_aud: { default: null, valid: str(128), owner: "07" },
  jwt_clock_tolerance_s: { default: 60, valid: int(0, 300), owner: "04" },
  orphan_grace_minutes: { default: 120, valid: int(1, 100_000), owner: "05" },
  vapid_public_key: { default: null, valid: re(/^[A-Za-z0-9_-]{87}$/), owner: "08" },
  vapid_private_key_enc: { default: null, valid: re(/^k[1-9][0-9]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/), owner: "08" },
  data_key_state: {
    default: null,
    valid: (v) => {
      const s = v as DataKeyState;
      return typeof s === "object" && s !== null && Number.isInteger(s.version) && s.version >= 1 &&
        B64URL_22.test(s.check) && (s.previous_check === null || B64URL_22.test(s.previous_check));
    },
    owner: "04",
  },
};

const CONTRACT_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];

function specOf(key: string): Spec {
  if ((CONTRACT_KEYS as string[]).includes(key)) {
    const k = key as keyof Settings;
    return { default: DEFAULT_SETTINGS[k], valid: (v) => validate("Settings", { ...DEFAULT_SETTINGS, [k]: v }).valid, owner: "02/07" };
  }
  const spec = (INTERNAL as Record<string, Spec>)[key];
  if (!spec) throw new Error(`unknown settings key ${key}`);
  return spec;
}

export function isSettingKey(key: string): key is SettingKey {
  return (CONTRACT_KEYS as string[]).includes(key) || key in INTERNAL;
}

function decode(key: string, raw: string | undefined): unknown {
  const spec = specOf(key);
  if (raw === undefined) return spec.default;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`settings key ${key} holds invalid JSON`);
  }
  if (!spec.valid(value)) throw new Error(`settings key ${key} holds an invalid value`);
  return value;
}

/** Several keys in one query; each falls back to its default (or null). */
export async function getSettings<K extends SettingKey>(db: D1Database, keys: readonly K[]): Promise<{ [P in K]: SettingValues[P] | null }> {
  for (const k of keys) specOf(k);
  const rows = await all<{ key: string; value: string }>(
    db, `SELECT key, value FROM settings WHERE key IN (${keys.map(() => "?").join(",")})`, ...keys,
  );
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = decode(k, byKey.get(k));
  return out as { [P in K]: SettingValues[P] | null };
}

export async function getSetting<K extends SettingKey>(db: D1Database, key: K): Promise<SettingValues[K] | null> {
  return (await getSettings(db, [key]))[key];
}

/** The whole contract `Settings` object (07's `settings.read()`). */
export async function readContractSettings(db: D1Database): Promise<Settings> {
  return (await getSettings(db, CONTRACT_KEYS)) as Settings;
}

/** The write as a statement, so callers can batch it with related writes. */
export function settingStatement<K extends SettingKey>(
  db: D1Database, key: K, value: SettingValues[K], updatedBy: string | null, now: number,
): D1PreparedStatement {
  if (!specOf(key).valid(value)) throw new Error(`refusing an invalid value for settings key ${key}`);
  return stmt(db, "INSERT OR REPLACE INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)",
    key, JSON.stringify(value), now, updatedBy);
}

export async function setSetting<K extends SettingKey>(
  db: D1Database, key: K, value: SettingValues[K], updatedBy: string | null, now: number,
): Promise<void> {
  await settingStatement(db, key, value, updatedBy, now).run();
}

/** Conditional write: only when the stored JSON still equals `expected` (or is absent when null). */
export async function compareAndSetSetting<K extends SettingKey>(
  db: D1Database, key: K, expected: SettingValues[K] | null, value: SettingValues[K], now: number,
): Promise<boolean> {
  if (!specOf(key).valid(value)) throw new Error(`refusing an invalid value for settings key ${key}`);
  if (expected === null) {
    return (await run(db, "INSERT OR IGNORE INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, 'system')",
      key, JSON.stringify(value), now)) === 1;
  }
  return (await run(db, "UPDATE settings SET value = ?, updated_at = ?, updated_by = 'system' WHERE key = ? AND value = ?",
    JSON.stringify(value), now, key, JSON.stringify(expected))) === 1;
}
