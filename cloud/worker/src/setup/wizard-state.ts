/**
 * Setup wizard state machine: a pure reducer over the persisted `settings.setup` record.
 *
 * The wizard walks locked → token → org → zone → access → domain → idp → keys → claim →
 * closed. Every step's facts are recorded on the record as it advances, so a reload resumes
 * at the step it left and every step can be re-run idempotently. `closed` is terminal: no
 * event moves out of it, which is what keeps the pre-Access setup window shut for good.
 *
 * - Pure: no I/O, no clock. Callers persist the returned record.
 * - One exhaustive switch over the step; an event that does not belong to the current step
 *   is refused, never silently applied.
 *
 * <module-headers:begin>
 * Uses:
 * src/setup/wizard-state.ts
 * └── src/admin/ports.ts
 * External: none
 *
 * Used by:
 * src/setup/wizard-state.ts
 * ├── src/setup/pages-steps.tsx
 * ├── src/setup/pages.tsx
 * ├── src/setup/routes.ts
 * ├── src/setup/steps/access.ts
 * ├── src/setup/steps/claim.ts
 * ├── src/setup/steps/common.ts
 * ├── src/setup/steps/domain.ts
 * ├── src/setup/steps/idp.ts
 * ├── src/setup/steps/keys.ts
 * ├── src/setup/steps/org.ts
 * ├── src/setup/steps/zone.ts
 * ├── test/setup-steps.test.ts
 * └── test/wizard-state.test.ts
 * <module-headers:end>
 */
import { assertNever } from "../admin/ports.ts";

export type SetupStep = "locked" | "token" | "org" | "zone" | "access" | "domain" | "idp" | "keys" | "claim" | "closed";

export const SETUP_STEPS: readonly SetupStep[] = ["locked", "token", "org", "zone", "access", "domain", "idp", "keys", "claim", "closed"];

/** Facts each step records. A field is set once its step has passed. */
export interface SetupRecord {
  step: SetupStep;
  account_id?: string;
  admin_email?: string;
  script_name?: string;
  team_domain?: string;
  zone_id?: string;
  zone_name?: string;
  cp_label?: string;
  cp_host?: string;
  policy_id?: string;
  access_app_id?: string;
  access_aud?: string;
  /** "overrides" (G8 primary) or "bypass_apps" (G8 fallback). */
  public_paths_mode?: "overrides" | "bypass_apps";
  bypass_app_ids?: string[];
  domain_mode?: "api" | "dashboard";
  idp_ids?: string[];
  vapid_public_key?: string;
  closed_at?: string;
  workers_dev_disabled?: boolean;
}

export type SetupEvent =
  | { kind: "code_ok" }
  | { kind: "probe_ok"; account_id: string; admin_email: string; script_name: string }
  | { kind: "team_domain"; team_domain: string }
  | { kind: "hostname_chosen"; zone_id: string; zone_name: string; cp_label: string }
  | {
      kind: "access_ready";
      policy_id: string;
      access_app_id: string;
      access_aud: string;
      public_paths_mode: "overrides" | "bypass_apps";
      bypass_app_ids: string[];
    }
  | { kind: "domain_attached"; domain_mode: "api" | "dashboard" }
  | { kind: "idp_ready"; idp_ids: string[] }
  | { kind: "keys_ready"; vapid_public_key: string }
  | { kind: "admin_claimed"; closed_at: string; workers_dev_disabled: boolean };

export type Transition = { ok: true; record: SetupRecord } | { ok: false; reason: string };

export const INITIAL_SETUP: SetupRecord = { step: "locked" };

function refuse(record: SetupRecord, event: SetupEvent): Transition {
  return { ok: false, reason: `${event.kind} does not apply at step ${record.step}` };
}

/** Applies one event. Pure; the caller persists `record` on success. */
export function reduce(record: SetupRecord, event: SetupEvent): Transition {
  switch (record.step) {
    case "locked":
      return event.kind === "code_ok" ? { ok: true, record: { ...record, step: "token" } } : refuse(record, event);
    case "token":
      if (event.kind !== "probe_ok") return refuse(record, event);
      return {
        ok: true,
        record: { ...record, step: "org", account_id: event.account_id, admin_email: event.admin_email.toLowerCase(), script_name: event.script_name },
      };
    case "org":
      return event.kind === "team_domain"
        ? { ok: true, record: { ...record, step: "zone", team_domain: event.team_domain } }
        : refuse(record, event);
    case "zone":
      if (event.kind !== "hostname_chosen") return refuse(record, event);
      return {
        ok: true,
        record: {
          ...record,
          step: "access",
          zone_id: event.zone_id,
          zone_name: event.zone_name,
          cp_label: event.cp_label,
          cp_host: `${event.cp_label}.${event.zone_name}`,
        },
      };
    case "access":
      if (event.kind !== "access_ready") return refuse(record, event);
      return {
        ok: true,
        record: {
          ...record,
          step: "domain",
          policy_id: event.policy_id,
          access_app_id: event.access_app_id,
          access_aud: event.access_aud,
          public_paths_mode: event.public_paths_mode,
          bypass_app_ids: event.bypass_app_ids,
        },
      };
    case "domain":
      return event.kind === "domain_attached"
        ? { ok: true, record: { ...record, step: "idp", domain_mode: event.domain_mode } }
        : refuse(record, event);
    case "idp":
      if (event.kind !== "idp_ready") return refuse(record, event);
      if (event.idp_ids.length === 0) return { ok: false, reason: "at least one usable identity provider is required" };
      return { ok: true, record: { ...record, step: "keys", idp_ids: event.idp_ids } };
    case "keys":
      return event.kind === "keys_ready"
        ? { ok: true, record: { ...record, step: "claim", vapid_public_key: event.vapid_public_key } }
        : refuse(record, event);
    case "claim":
      if (event.kind !== "admin_claimed") return refuse(record, event);
      return { ok: true, record: { ...record, step: "closed", closed_at: event.closed_at, workers_dev_disabled: event.workers_dev_disabled } };
    case "closed":
      return { ok: false, reason: "setup is closed for good" };
    default:
      return assertNever(record.step);
  }
}

/** Whether setup is finished (the `Meta.setup` value). */
export function setupPhase(record: SetupRecord): "open" | "closed" {
  return record.step === "closed" ? "closed" : "open";
}
