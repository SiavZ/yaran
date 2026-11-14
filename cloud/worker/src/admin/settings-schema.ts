/**
 * The org settings form, rendered from exactly 02's `Settings` schema.
 *
 * One descriptor per leaf of `Settings`, adding only the default, the range and the help
 * text the form shows as each field's hint, so the page documents itself. Reading fills
 * missing rows with defaults; parsing a submitted form rebuilds a whole `Settings` object
 * and 02's validator is the only judge of it (no second copy of the rules lives here).
 *
 * - `readSettings` is the `settings.read()` 06 and 08 call.
 * - A test walks 02's `fixtures/api/Settings.json` through parse+validate, so the form
 *   cannot drift from the contract.
 *
 * <module-headers:begin>
 * Uses:
 * src/admin/settings-schema.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/admin/ports.ts
 * └── src/admin/settings-store.ts
 * External: none
 *
 * Used by:
 * src/admin/settings-schema.ts
 * ├── src/admin-api/routes.ts
 * ├── src/admin/health.ts
 * ├── src/admin/scheduled-jobs.ts
 * ├── src/admin/settings-apply.ts
 * ├── src/console/admin-pages-2.tsx
 * ├── src/console/admin-routes.ts
 * ├── src/console/routes.ts
 * ├── src/phase07.ts
 * ├── src/setup/routes.ts
 * └── test/admin-services.test.ts
 * <module-headers:end>
 */
import { validate, type Settings, type ValidationResult } from "@yaran/protocol";
import type { D1Like } from "./ports.ts";
import { readKeys } from "./settings-store.ts";

export type FieldKind = "text" | "number" | "nullable_number" | "checkbox" | "select" | "lines";

export interface SettingField {
  /** Dotted path into `Settings`, e.g. `push.ttl_seconds`. */
  path: string;
  label: string;
  hint: string;
  kind: FieldKind;
  options?: readonly string[];
}

export const SETTINGS_FIELDS: readonly SettingField[] = [
  { path: "org_name", label: "Organization name", hint: "Shown on every console page and to phones as the org name.", kind: "text" },
  { path: "session_duration", label: "Sign-in session length", hint: "How long an Access sign-in lasts, from 15m to 720h (for example 24h). Saving re-applies it to the control plane and every machine.", kind: "text" },
  { path: "pairing_policy.mode", label: "Who may sign in and pair", hint: "allowlist admits only the emails, email domains and Access groups below; everyone admits any identity your sign-in methods accept, and is refused while One-time PIN is on.", kind: "select", options: ["allowlist", "everyone"] },
  { path: "pairing_policy.emails", label: "Allowed emails", hint: "One email address per line.", kind: "lines" },
  { path: "pairing_policy.domains", label: "Allowed email domains", hint: "One domain per line, for example example.org.", kind: "lines" },
  { path: "pairing_policy.access_group_ids", label: "Allowed Access groups", hint: "One Access group id per line, from Zero Trust, Access, Access groups.", kind: "lines" },
  { path: "machine_cap_per_user", label: "Machines per user", hint: "From 1 to 50.", kind: "number" },
  { path: "device_cap_per_user", label: "Phones per user", hint: "From 1 to 20.", kind: "number" },
  { path: "push.enabled", label: "Push notifications", hint: "Off stops every push to every phone.", kind: "checkbox" },
  { path: "push.detail", label: "Push detail", hint: "names includes the project and agent label in a notification; minimal leaves them out.", kind: "select", options: ["names", "minimal"] },
  { path: "push.ttl_seconds", label: "Push lifetime (seconds)", hint: "How long an undelivered push waits, from 60 to 86400.", kind: "number" },
  { path: "push.relay_allowed", label: "Allow push relays", hint: "Off refuses relay channels, which turns push off on iPhones.", kind: "checkbox" },
  { path: "push.allowed_relays", label: "Allowed relays", hint: "One https relay URL per line; empty allows any https relay.", kind: "lines" },
  { path: "stale_machine_policy.notify_after_days", label: "Flag machines offline for (days)", hint: "Puts a badge on machines offline this long; empty turns it off.", kind: "nullable_number" },
  { path: "stale_machine_policy.revoke_after_days", label: "Revoke machines offline for (days)", hint: "Revokes machines offline this long; empty turns it off.", kind: "nullable_number" },
  { path: "audit_retention_days", label: "Keep audit log for (days)", hint: "From 30 to 3650; older rows are deleted daily.", kind: "number" },
  { path: "quota_limits.access_apps", label: "Access application limit", hint: "Raise only after Cloudflare raises your account limit; a lower value is a soft cap.", kind: "number" },
  { path: "quota_limits.access_policies", label: "Access policy limit", hint: "Raise only after Cloudflare raises your account limit.", kind: "number" },
  { path: "quota_limits.tunnels", label: "Tunnel limit", hint: "Raise only after Cloudflare raises your account limit.", kind: "number" },
  { path: "orphan_cleanup", label: "Orphaned Cloudflare objects", hint: "delete removes objects yaran created but no longer tracks; report only lists them on Health.", kind: "select", options: ["delete", "report"] },
  { path: "deployer_repo_url", label: "Your deploy repository", hint: "The https URL of the repository the Deploy button created, so Updates can link its update workflow. Empty for none.", kind: "text" },
];

/** Defaults for a fresh org; setup overwrites org_name and the allowlist. */
export function defaultSettings(orgName = "yaran", adminEmail?: string): Settings {
  return {
    org_name: orgName,
    session_duration: "24h",
    pairing_policy: { mode: "allowlist", emails: adminEmail ? [adminEmail] : [], domains: [], access_group_ids: [] },
    machine_cap_per_user: 10,
    device_cap_per_user: 10,
    push: { enabled: true, detail: "names", ttl_seconds: 3600, relay_allowed: true, allowed_relays: [] },
    stale_machine_policy: { notify_after_days: 30, revoke_after_days: null },
    audit_retention_days: 365,
    quota_limits: { access_apps: 500, access_policies: 500, tunnels: 1000 },
    orphan_cleanup: "delete",
    deployer_repo_url: null,
  };
}

export const SETTINGS_KEYS = Object.keys(defaultSettings()) as (keyof Settings)[];

/** `settings.read()`: the stored contract settings, defaults filling missing rows. */
export async function readSettings(db: D1Like): Promise<Settings> {
  const stored = await readKeys(db, SETTINGS_KEYS);
  const merged: Record<string, unknown> = { ...defaultSettings() };
  for (const [k, v] of stored) merged[k] = v;
  return merged as unknown as Settings;
}

export function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let cur = obj;
  for (const k of keys.slice(0, -1)) cur = (cur[k] ??= {}) as Record<string, unknown>;
  cur[keys[keys.length - 1]!] = value;
}

/** Rebuilds a `Settings`-shaped object from a submitted form; validation is 02's job. */
export function parseSettingsForm(form: FormData): unknown {
  const out: Record<string, unknown> = {};
  for (const f of SETTINGS_FIELDS) {
    const raw = form.get(f.path);
    const text = typeof raw === "string" ? raw.trim() : "";
    switch (f.kind) {
      case "text":
        setPath(out, f.path, f.path === "deployer_repo_url" && text === "" ? null : text);
        break;
      case "number":
      case "nullable_number":
        // An empty or non-numeric entry becomes null, which 02's schema refuses where a number is required.
        setPath(out, f.path, text === "" || !Number.isFinite(Number(text)) ? null : Number(text));
        break;
      case "checkbox":
        setPath(out, f.path, raw !== null);
        break;
      case "select":
        setPath(out, f.path, text);
        break;
      case "lines":
        setPath(out, f.path, text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== ""));
        break;
    }
  }
  return out;
}

export function validateSettings(value: unknown): ValidationResult {
  return validate("Settings", value);
}
