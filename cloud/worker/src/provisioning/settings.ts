/**
 * The settings the provisioning engine reads, with the Worker-internal rows it owns.
 *
 * Contract keys (`session_duration`, `quota_limits`, `orphan_cleanup`) are 02 `Settings`
 * values stored by 04 and written by 07. Internal keys have no admin API (02 §6 note); their
 * defaults and validators are declared here in `PROV_INTERNAL_SETTINGS` for 04's
 * `db/settings.ts` registry to absorb.
 *
 * - One `getMany` call per load.
 * - A missing Cloudflare identifier means setup has not finished: `setup_incomplete`.
 * - An invalid stored value is a loud error, never a silent default.
 *
 * <module-headers:begin>
 * Uses:
 * src/provisioning/settings.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/provisioning/ports.ts
 * └── src/provisioning/provision-error.ts
 * External: none
 *
 * Used by:
 * src/provisioning/settings.ts
 * ├── src/db/settings.ts
 * ├── src/provisioning/engine.ts
 * ├── src/provisioning/index.ts
 * ├── src/provisioning/quota.ts
 * ├── src/provisioning/steps-provision.ts
 * ├── src/reconcile/drift.ts
 * ├── src/reconcile/orphans.ts
 * ├── src/reconcile/status.ts
 * ├── test/provisioning/quota.test.ts
 * └── test/provisioning/registry.test.ts
 * <module-headers:end>
 */
import type { Settings } from "@yaran/protocol";
import { ProvisionError } from "./provision-error.ts";
import type { ProvCtx } from "./ports.ts";

export interface InternalSetting<T> {
  default: T;
  validate: (v: unknown) => v is T;
  owner: "05";
  doc: string;
}

const isInt = (min: number, max: number) => (v: unknown): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

/** Worker-internal settings rows added by Phase 05 (append to 04's settings schema). */
export const PROV_INTERNAL_SETTINGS = {
  api_background_reserve: {
    default: 600,
    validate: isInt(0, 1200),
    owner: "05",
    doc: "Cloudflare API calls (of 1,200 per 5 min) kept back from reconcile tasks for interactive work.",
  } satisfies InternalSetting<number>,
  drift_machines_per_run: {
    default: 5,
    validate: isInt(0, 8),
    owner: "05",
    doc: "Machines the cf_drift task checks per 5-minute run (4 API calls each); 0 disables drift repair.",
  } satisfies InternalSetting<number>,
  provision_max_attempts: {
    default: 24,
    validate: isInt(1, 200),
    owner: "05",
    doc: "Failed attempts after which a provisioning op stops retrying (backoff 30 s … hourly, 24 is about a day).",
  } satisfies InternalSetting<number>,
  machine_same_site: {
    default: "lax" as "lax" | "strict" | "none",
    validate: (v: unknown): v is "lax" | "strict" | "none" => v === "lax" || v === "strict" || v === "none",
    owner: "05",
    doc: "SameSite attribute of the Access cookie on machine apps; changed only if gate G1 needs it.",
  } satisfies InternalSetting<"lax" | "strict" | "none">,
  machine_managed_oauth: {
    default: false,
    validate: (v: unknown): v is boolean => typeof v === "boolean",
    owner: "05",
    doc: "Gate G1 fallback L2: add Access Managed OAuth to every machine app (off under L0 and L1).",
  } satisfies InternalSetting<boolean>,
  orphan_grace_minutes: {
    default: 120,
    validate: isInt(10, 10080),
    owner: "05",
    doc: "Minutes a marked orphan must have been seen before the orphan sweep may delete it.",
  } satisfies InternalSetting<number>,
};

export interface ProvSettings {
  instanceId: string;
  accountId: string;
  zoneId: string;
  zoneName: string;
  controlPlaneHost: string;
  teamDomain: string;
  sessionDuration: string;
  quotaLimits: Settings["quota_limits"];
  orphanCleanup: Settings["orphan_cleanup"];
  apiBackgroundReserve: number;
  driftMachinesPerRun: number;
  provisionMaxAttempts: number;
  machineSameSite: "lax" | "strict" | "none";
  machineManagedOauth: boolean;
  orphanGraceMinutes: number;
}

const REQUIRED = ["instance_id", "account_id", "zone_id", "zone_name", "control_plane_host", "team_domain"] as const;
const CONTRACT = ["session_duration", "quota_limits", "orphan_cleanup"] as const;
const CONTRACT_DEFAULTS = {
  session_duration: "24h",
  quota_limits: { access_apps: 500, access_policies: 500, tunnels: 1000 },
  orphan_cleanup: "delete",
} as const;

type Internal = typeof PROV_INTERNAL_SETTINGS;

function internal<K extends keyof Internal>(raw: Record<string, unknown>, key: K): Internal[K]["default"] {
  const spec = PROV_INTERNAL_SETTINGS[key] as InternalSetting<Internal[K]["default"]>;
  const v = raw[key];
  if (v === undefined) return spec.default;
  if (!spec.validate(v)) throw new Error(`setting ${key} holds an invalid value; fix it before provisioning runs`);
  return v;
}

function isQuota(v: unknown): v is Settings["quota_limits"] {
  const q = v as Record<string, unknown> | null;
  return !!q && ["access_apps", "access_policies", "tunnels"].every((k) => Number.isInteger(q[k]) && (q[k] as number) >= 1);
}

export async function loadProvSettings(ctx: ProvCtx): Promise<ProvSettings> {
  const keys = [...REQUIRED, ...CONTRACT, ...Object.keys(PROV_INTERNAL_SETTINGS)];
  const raw = await ctx.settings.getMany(keys);
  for (const k of REQUIRED) {
    if (typeof raw[k] !== "string" || raw[k] === "") {
      throw new ProvisionError("setup_incomplete", `setting ${k} is not set; finish the setup wizard before machines can be provisioned`);
    }
  }
  const instanceId = raw["instance_id"] as string;
  if (!/^[0-9a-f]{8}$/.test(instanceId)) throw new Error("setting instance_id must be 8 lowercase hex characters");
  const sessionDuration = (raw["session_duration"] ?? CONTRACT_DEFAULTS.session_duration) as string;
  if (!/^[1-9][0-9]{0,3}(m|h)$/.test(sessionDuration)) throw new Error("setting session_duration holds an invalid value");
  const quota = raw["quota_limits"] ?? CONTRACT_DEFAULTS.quota_limits;
  if (!isQuota(quota)) throw new Error("setting quota_limits holds an invalid value");
  const orphan = raw["orphan_cleanup"] ?? CONTRACT_DEFAULTS.orphan_cleanup;
  if (orphan !== "delete" && orphan !== "report") throw new Error("setting orphan_cleanup holds an invalid value");
  return {
    instanceId,
    accountId: raw["account_id"] as string,
    zoneId: raw["zone_id"] as string,
    zoneName: (raw["zone_name"] as string).toLowerCase(),
    controlPlaneHost: (raw["control_plane_host"] as string).toLowerCase(),
    teamDomain: (raw["team_domain"] as string).toLowerCase(),
    sessionDuration,
    quotaLimits: quota,
    orphanCleanup: orphan,
    apiBackgroundReserve: internal(raw, "api_background_reserve"),
    driftMachinesPerRun: internal(raw, "drift_machines_per_run"),
    provisionMaxAttempts: internal(raw, "provision_max_attempts"),
    machineSameSite: internal(raw, "machine_same_site"),
    machineManagedOauth: internal(raw, "machine_managed_oauth"),
    orphanGraceMinutes: internal(raw, "orphan_grace_minutes"),
  };
}
