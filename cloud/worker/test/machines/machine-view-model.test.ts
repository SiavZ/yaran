/**
 * The machine view model's exhaustive state mapping.
 *
 * One row per lifecycle status, tunnel status and timestamp combination, each validated against 02's MachineSummary.
 *
 * <module-headers:begin>
 * Uses:
 * test/machines/machine-view-model.test.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/machines/machine-rows.ts
 * └── src/machines/machine-view-model.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { validate } from "@yaran/protocol";
import { describe, expect, it } from "vitest";
import type { MachineRow } from "../../src/machines/machine-rows.ts";
import { adminMachine, machineSummary } from "../../src/machines/machine-view-model.ts";

const NOW = 1_800_000_000;
const base: MachineRow = {
  id: "11111111-1111-4111-8111-111111111111", owner_user_id: "u", name: "laptop", slug: "laptop", hostname: "laptop-ada.example.com",
  public_key: new Uint8Array(32).fill(7).buffer, origin_port: 3890, yaran_version: "1.2.3", reported_protocol: 1, status: "active",
  access_app_id: "app", access_app_aud: "aud", tunnel_id: "22222222-2222-4222-8222-222222222222", tunnel_secret_generation: 2,
  cf_status: null, cf_status_at: null, conns_active_at: null, conns_inactive_at: null, created_at: 1_700_000_000, claimed_at: 1_700_000_100,
  last_seen_at: 1_799_999_000, replaced_by: null,
};
const T = "2026-11-14T12:00:00Z";

// [lifecycle, cf_status, conns_active_at, conns_inactive_at, expected]
const table: [MachineRow["status"], MachineRow["cf_status"], string | null, string | null, string | null][] = [
  ["provisioning", null, null, null, "provisioning"],
  ["provisioning", "healthy", T, null, "provisioning"],
  ["awaiting_claim", null, null, null, "provisioning"],
  ["awaiting_claim", "inactive", null, null, "provisioning"],
  ["revoking", "healthy", T, null, "tearing_down"],
  ["revoking", null, null, null, "tearing_down"],
  ["failed", null, null, null, "unknown"],
  ["failed", "down", null, T, "unknown"],
  ["revoked", "healthy", T, null, null],
  ["active", "healthy", T, null, "online"],
  ["active", "healthy", null, null, "online"],
  ["active", "degraded", T, null, "degraded"],
  ["active", "down", T, T, "offline"],
  ["active", "down", null, null, "offline"],
  ["active", "inactive", null, T, "offline"],
  ["active", "inactive", T, T, "offline"],
  ["active", "inactive", null, null, "never_connected"],
  ["active", "inactive", T, null, "unknown"],
  ["active", "unknown", null, null, "unknown"],
  ["active", null, null, null, "unknown"],
];

describe("machine view model", () => {
  it.each(table)("%s / %s / active=%s inactive=%s → %s", (status, cf, a, i, expected) => {
    const s = machineSummary({ ...base, status, cf_status: cf, conns_active_at: a, conns_inactive_at: i, cf_status_at: cf ? NOW - 30 : null }, NOW);
    if (expected === null) return expect(s).toBeNull();
    expect(s?.status).toBe(expected);
    expect(validate("MachineSummary", s).errors).toEqual([]);
  });

  it("uses the cache time, falls back to now, and pairs at claim or creation", () => {
    expect(machineSummary({ ...base, cf_status: "healthy", cf_status_at: NOW - 60 }, NOW)?.status_checked_at).toBe("2027-01-15T07:59:00Z");
    const fresh = machineSummary({ ...base, status: "awaiting_claim", claimed_at: null }, NOW)!;
    expect(fresh.status_checked_at).toBe("2027-01-15T08:00:00Z");
    expect(fresh.paired_at).toBe("2023-11-14T22:13:20Z");
    expect(fresh.url).toBe("https://laptop-ada.example.com");
  });

  it("does not list a row 05 has not given a hostname", () => {
    expect(machineSummary({ ...base, status: "provisioning", hostname: null }, NOW)).toBeNull();
  });

  it("builds a schema-valid AdminMachine with the key fingerprint", async () => {
    const a = await adminMachine(base, "ada@example.org", { state: "failed", errorCode: "tunnel_delete_blocked" }, NOW);
    expect(validate("AdminMachine", a).errors).toEqual([]);
    expect(a?.key_fingerprint).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){5}$/);
    expect(a?.token_version).toBe(2);
    expect(a?.provisioning).toEqual({ state: "failed", last_error_code: "tunnel_delete_blocked" });
  });
});
