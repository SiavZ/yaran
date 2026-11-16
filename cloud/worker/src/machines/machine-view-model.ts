/**
 * The machine view model: the one place a D1 `machines` row, 05's cached tunnel-health
 * columns and `last_seen_at` become 02's `MachineSummary` (and `AdminMachine` for 07).
 *
 * The lifecycle decides first; only an `active` row asks the tunnel. Both switches are
 * exhaustive, so a new status is a compile error here. The user API, both consoles and
 * the admin API reuse this module, so they cannot disagree about what "online" means.
 *
 * - Pure: no D1 and no Cloudflare call (a list never spends API budget; 05 keeps the
 *   columns fresh).
 * - Returns null for rows that are not listed: `revoked`, and a row 05 has not yet given
 *   a hostname (P0 runs inline at authorize, so that window is one request long; showing a
 *   made-up hostname would be a lie the console prints).
 *
 * <module-headers:begin>
 * Uses:
 * src/machines/machine-view-model.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/machines/machine-rows.ts
 * ├── src/routes/call.ts
 * └── src/shared/timestamp.ts
 * External: none
 *
 * Used by:
 * src/machines/machine-view-model.ts
 * ├── src/admin/pairing-service.ts
 * ├── src/me/machines-route.ts
 * └── test/machines/machine-view-model.test.ts
 * <module-headers:end>
 */
import { machineKeyFingerprint, type AdminMachine, type MachineStatus, type MachineSummary } from "@yaran/protocol";
import type { OpView } from "../routes/call.ts";
import { toNullableTimestamp, toTimestamp } from "../shared/timestamp.ts";
import type { MachineRow } from "./machine-rows.ts";

function assertNever(x: never): never {
  throw new Error(`unhandled value ${String(x)}`);
}

/** Tunnel health of an active machine, from 05's reconciliation cache. */
export function tunnelStatus(row: Pick<MachineRow, "cf_status" | "conns_active_at" | "conns_inactive_at">): MachineStatus {
  const cf = row.cf_status;
  if (cf === null) return "unknown";
  switch (cf) {
    case "healthy":
      return "online";
    case "degraded":
      return "degraded";
    case "down":
      return "offline";
    case "inactive":
      if (row.conns_inactive_at !== null) return "offline";
      return row.conns_active_at === null ? "never_connected" : "unknown";
    case "unknown":
      return "unknown";
    default:
      return assertNever(cf);
  }
}

/** The wire status, or null for a row that is never listed. */
export function machineStatus(row: MachineRow): MachineStatus | null {
  const s = row.status;
  switch (s) {
    case "provisioning":
    case "awaiting_claim":
      return "provisioning";
    case "revoking":
      return "tearing_down";
    case "failed":
      return "unknown";
    case "revoked":
      return null;
    case "active":
      return tunnelStatus(row);
    default:
      return assertNever(s);
  }
}

/** 02 `MachineSummary` for a row, or null when the row is not listed. */
export function machineSummary(row: MachineRow, now: number): MachineSummary | null {
  const status = machineStatus(row);
  if (status === null || row.hostname === null) return null;
  return {
    id: row.id,
    name: row.name,
    hostname: row.hostname,
    url: `https://${row.hostname}`,
    status,
    // No observation yet: the answer was computed now, from the lifecycle alone.
    status_checked_at: toTimestamp(row.cf_status_at ?? now),
    last_seen_at: toNullableTimestamp(row.last_seen_at),
    reported_protocol: row.reported_protocol,
    // Not claimed yet (provisioning, awaiting_claim): the pairing started at created_at.
    paired_at: toTimestamp(row.claimed_at ?? row.created_at),
    yaran_version: row.yaran_version,
  };
}

/** 02 `AdminMachine` (07's W20); null when the summary is null or 05 has not created the tunnel and app yet. */
export async function adminMachine(row: MachineRow, ownerEmail: string, op: OpView | null, now: number): Promise<AdminMachine | null> {
  const summary = machineSummary(row, now);
  if (summary === null || row.tunnel_id === null || row.access_app_id === null) return null;
  return {
    ...summary,
    owner_email: ownerEmail,
    key_fingerprint: await machineKeyFingerprint(new Uint8Array(row.public_key)),
    origin_port: row.origin_port,
    tunnel_id: row.tunnel_id,
    access_app_id: row.access_app_id,
    token_version: row.tunnel_secret_generation,
    provisioning: { state: op?.state ?? "complete", last_error_code: op?.errorCode ?? null },
  };
}
