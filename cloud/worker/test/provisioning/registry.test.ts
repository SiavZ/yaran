/**
 * Every audit action and error code this phase emits exists in 02's registries, and the
 * Worker-internal settings rows validate as declared.
 *
 * <module-headers:begin>
 * Uses:
 * test/provisioning/registry.test.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── cloud/protocol/registry/audit-actions.json
 * ├── src/provisioning/ports.ts
 * ├── src/provisioning/settings.ts
 * └── test/provisioning/helpers/world.ts
 * External: node:fs, node:path, node:url, vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { errorEntry } from "@yaran/protocol";
import registry from "@yaran/protocol/registry/audit-actions.json" with { type: "json" };
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ProvAuditAction } from "../../src/provisioning/ports.ts";
import { loadProvSettings, PROV_INTERNAL_SETTINGS } from "../../src/provisioning/settings.ts";
import { makeWorld, setSetting } from "./helpers/world.ts";

const ACTIONS = {
  "provision.step": true,
  "provision.done": true,
  "provision.failed": true,
  "teardown.step": true,
  "teardown.done": true,
  "teardown.failed": true,
  "machine.rotated": true,
  "machine.origin_changed": true,
  "machine.reconciled": true,
  "drift.repaired": true,
  "orphan.found": true,
  "orphan.deleted": true,
  "quota.refused": true,
  "cloudflare.rate_limited": true,
} satisfies Record<ProvAuditAction, true>;

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../../src");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith(".ts") ? [readFileSync(join(dir, e.name), "utf8")] : []));
}

describe("registries", () => {
  it("every audit action is in registry/audit-actions.json", () => {
    for (const a of Object.keys(ACTIONS)) expect(registry.actions, a).toContain(a);
  });

  it("every error code the engine can surface is in registry/errors.json", () => {
    const text = sources(SRC).join("\n");
    const thrown = [...text.matchAll(/new ProvisionError\(\s*(?:\(?[^"]*?)?"([a-z_]+)"/g)].map((m) => m[1]!);
    const literal = ["tunnel_delete_blocked", "provisioning_failed", "account_quota_reached", "hostname_conflict", "cloudflare_rate_limited", "cloudflare_unavailable", "cloudflare_permission_denied", "cloudflare_api_failed", "provisioning_in_progress", "internal"];
    expect(thrown.length).toBeGreaterThan(5);
    for (const code of new Set([...thrown, ...literal])) {
      const e = errorEntry(code);
      expect(e, code).toBeDefined();
      expect(e?.status, code).not.toBeNull();
    }
  });
});

describe("settings", () => {
  it("internal settings validate their defaults and reject bad values", () => {
    for (const [key, spec] of Object.entries(PROV_INTERNAL_SETTINGS)) {
      expect((spec.validate as (v: unknown) => boolean)(spec.default), key).toBe(true);
      expect((spec.validate as (v: unknown) => boolean)("nonsense"), key).toBe(false);
    }
    expect(PROV_INTERNAL_SETTINGS.drift_machines_per_run.validate(9)).toBe(false);
  });

  it("loads defaults, refuses an invalid stored value loudly, and needs setup to be done", async () => {
    const w = makeWorld();
    const s = await loadProvSettings(w.ctx);
    expect(s).toMatchObject({ apiBackgroundReserve: 600, driftMachinesPerRun: 5, provisionMaxAttempts: 24, machineSameSite: "lax", orphanGraceMinutes: 120, sessionDuration: "24h", orphanCleanup: "delete" });
    setSetting(w, "api_background_reserve", -1);
    await expect(loadProvSettings(w.ctx)).rejects.toThrow(/api_background_reserve/);
    const w2 = makeWorld({ settings: { zone_id: "" } });
    await expect(loadProvSettings(w2.ctx)).rejects.toMatchObject({ code: "setup_incomplete" });
  });
});
