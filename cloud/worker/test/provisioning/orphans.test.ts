/**
 * cf_orphans: grace and two sightings, report mode, D21 order across kinds, foreign and
 * unmarked resources untouched, quota observation refreshed.
 *
 * <module-headers:begin>
 * Uses:
 * test/provisioning/orphans.test.ts
 * ├── src/provisioning/index.ts
 * ├── src/provisioning/quota.ts
 * ├── src/reconcile/orphans.ts
 * ├── src/reconcile/status.ts
 * └── test/provisioning/helpers/world.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm run test:provisioning in cloud/worker)
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import { startProvision, startTeardown } from "../../src/provisioning/index.ts";
import { readOrphansCursor } from "../../src/provisioning/quota.ts";
import { ORPHAN_KINDS, runCfOrphans } from "../../src/reconcile/orphans.ts";
import { runCfStatus } from "../../src/reconcile/status.ts";
import { machine, makeWorld, OTHER_INST, setSetting, seedMachine, type World } from "./helpers/world.ts";

const DEAD = "0f0e0d0c-0b0a-4908-8706-050403020100";

/** Leaves a complete set of marked resources for a machine id that has no row. */
async function leaveOrphans(w: World): Promise<void> {
  const id = seedMachine(w);
  await startProvision(w.ctx, id);
  // Forget the row's knowledge of its resources: simulates a lost machine row.
  w.db.sqlite.prepare("UPDATE machines SET status = 'revoked', hostname = NULL, tunnel_id = NULL WHERE id = ?").run(id);
}

/** One full rotation of the four kinds. */
async function sweep(w: World): Promise<void> {
  for (let i = 0; i < ORPHAN_KINDS.length; i++) {
    await runCfStatus(w.fresh());
    await runCfOrphans(w.fresh());
  }
}

const counts = (w: World) => [w.cf.state.dns.size, w.cf.state.liveTunnels().length, w.cf.state.apps.size, w.cf.state.policies.size];

function seedUnownable(w: World): void {
  w.cf.state.apps.set("foreign", { id: "foreign", aud: "x", name: `yaran:${OTHER_INST}:m:${DEAD}`, domain: "f.example.com" });
  w.cf.state.apps.set("unmarked", { id: "unmarked", aud: "y", name: "HR portal", domain: "hr.example.com" });
  w.cf.state.policies.set("fpol", { id: "fpol", name: `yaran:${OTHER_INST}:owner:${DEAD}`, decision: "allow", include: [] });
}

describe("cf_orphans", () => {
  it("deletes marked orphans only after the grace period and two sightings, in D21 order", async () => {
    const w = makeWorld();
    await leaveOrphans(w);
    seedUnownable(w);
    expect(counts(w)).toEqual([1, 1, 3, 2]);
    await sweep(w);
    expect(counts(w)).toEqual([1, 1, 3, 2]);
    w.clock.now += 60;
    await sweep(w);
    // Seen twice, but the 120-minute grace has not passed.
    expect(counts(w)).toEqual([1, 1, 3, 2]);
    w.clock.now += 121 * 60;
    await sweep(w);
    expect(counts(w)).toEqual([0, 0, 2, 1]);
    expect([...w.cf.state.apps.keys()].sort()).toEqual(["foreign", "unmarked"]);
    expect([...w.cf.state.policies.keys()]).toEqual(["fpol"]);
    const deleted = w.audits.filter((a) => a.action === "orphan.deleted").map((a) => a.detail?.["resource_kind"]);
    expect(deleted).toEqual(["dns_record", "tunnel", "access_app", "access_policy"]);
    expect(w.audits.filter((a) => a.action === "orphan.found")).toHaveLength(4);
    expect(w.cf.state.violations).toEqual([]);
  });

  it("deletes nothing in report mode", async () => {
    const w = makeWorld({ settings: { orphan_cleanup: "report" } });
    await leaveOrphans(w);
    for (let i = 0; i < 3; i++) {
      await sweep(w);
      w.clock.now += 200 * 60;
    }
    expect(counts(w)).toEqual([1, 1, 1, 1]);
    expect(w.db.sqlite.prepare("SELECT count(*) AS n FROM cf_orphans").get()).toEqual({ n: 4 });
  });

  it("never treats a live machine's resources as orphans", async () => {
    const w = makeWorld();
    setSetting(w, "orphan_grace_minutes", 10);
    const id = seedMachine(w);
    await startProvision(w.ctx, id);
    for (let i = 0; i < 3; i++) {
      await sweep(w);
      w.clock.now += 3600;
    }
    expect(counts(w)).toEqual([1, 1, 1, 1]);
    expect(machine(w, id)["status"]).toBe("awaiting_claim");
    await startTeardown(w.fresh(), id, "admin_revoke");
    expect(counts(w)).toEqual([0, 0, 0, 0]);
  });

  it("refreshes the quota observation from the app and policy lists and the status cursor", async () => {
    const w = makeWorld();
    await leaveOrphans(w);
    seedUnownable(w);
    await sweep(w);
    const c = await readOrphansCursor(w.fresh());
    expect(c.quota).toMatchObject({ apps_total: 3, policies_total: 2, tunnels_total: 1, observed_at: w.clock.now });
  });
});
