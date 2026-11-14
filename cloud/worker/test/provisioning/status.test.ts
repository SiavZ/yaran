/**
 * cf_status: changed rows only, one batch, missing tunnel → unknown + drift priority,
 * refreshMachineStatus dedup.
 *
 * <module-headers:begin>
 * Uses:
 * test/provisioning/status.test.ts
 * ├── src/provisioning/index.ts
 * ├── src/reconcile/drift.ts
 * ├── src/reconcile/kit.ts
 * ├── src/reconcile/status.ts
 * └── test/provisioning/helpers/world.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm run test:provisioning in cloud/worker)
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import { refreshMachineStatus, startProvision } from "../../src/provisioning/index.ts";
import { readTaskCursor } from "../../src/reconcile/kit.ts";
import { runCfStatus, STATUS_TASK, type StatusCursor } from "../../src/reconcile/status.ts";
import { DRIFT_TASK } from "../../src/reconcile/drift.ts";
import { machine, makeWorld, OTHER_INST, seedMachine, type World } from "./helpers/world.ts";

async function active(w: World): Promise<string> {
  const id = seedMachine(w);
  await startProvision(w.ctx, id);
  w.db.sqlite.prepare("UPDATE machines SET status = 'active' WHERE id = ?").run(id);
  return id;
}

describe("cf_status", () => {
  it("writes only changed rows, in one batch, from one list call", async () => {
    const w = makeWorld();
    const a = await active(w);
    const b = await active(w);
    const ta = w.cf.state.tunnels.get(machine(w, a)["tunnel_id"] as string)!;
    ta.status = "healthy";
    ta.conns_active_at = "2026-11-14T10:00:00Z";
    w.cf.calls.length = 0;
    const ctx = w.fresh();
    let batches = 0;
    const realBatch = w.db.batch.bind(w.db);
    w.db.batch = async (s) => (batches++, realBatch(s));
    const r = await runCfStatus(ctx);
    expect(r.ok).toBe(true);
    expect(w.cf.calls).toHaveLength(1);
    expect(w.cf.calls[0]?.query).toContain("include_prefix=yaran-a1b2c3d4-");
    expect(batches).toBe(1);
    expect(machine(w, a)).toMatchObject({ cf_status: "healthy", cf_status_at: w.clock.now, conns_active_at: "2026-11-14T10:00:00Z" });
    expect(machine(w, b)).toMatchObject({ cf_status: "inactive" });
    // Second run: nothing changed, no machine row written.
    w.clock.now += 60;
    await runCfStatus(w.fresh());
    expect(machine(w, a)["cf_status_at"]).toBe(w.clock.now - 60);
    ta.status = "down";
    await runCfStatus(w.fresh());
    expect(machine(w, a)).toMatchObject({ cf_status: "down", cf_status_at: w.clock.now });
  });

  it("marks a live machine whose tunnel vanished unknown and pulls it to the front of drift", async () => {
    const w = makeWorld();
    const id = await active(w);
    w.cf.state.tunnels.get(machine(w, id)["tunnel_id"] as string)!.deleted_at = "now";
    await runCfStatus(w.fresh());
    expect(machine(w, id)["cf_status"]).toBe("unknown");
    expect((await readTaskCursor<{ priority: string[] }>(w.ctx, DRIFT_TASK)).priority).toEqual([id]);
  });

  it("keeps marked tunnels no machine records (and only ours) for the orphan sweep", async () => {
    const w = makeWorld();
    await active(w);
    w.cf.state.tunnels.set("x", { id: "x", name: "yaran-a1b2c3d4-0f0e0d0c-0b0a-4908-8706-050403020100", secret: "seeded-secret-xxxxxxxxxxxxxxxxxx", connectors: 0, rogue: false, status: "down", deleted_at: null, config: null, configVersion: 0, conns_active_at: null });
    w.cf.state.tunnels.set("y", { id: "y", name: `yaran-${OTHER_INST}-0f0e0d0c-0b0a-4908-8706-050403020100`, secret: "seeded-secret-xxxxxxxxxxxxxxxxxx", connectors: 0, rogue: false, status: "down", deleted_at: null, config: null, configVersion: 0, conns_active_at: null });
    await runCfStatus(w.fresh());
    const c = await readTaskCursor<StatusCursor>(w.ctx, STATUS_TASK);
    expect(c.others?.map((t) => t.id)).toEqual(["x"]);
    expect(c.tunnels_total).toBe(2);
  });
});

describe("refreshMachineStatus", () => {
  it("does one GET when the cache is older than 60 s and none otherwise", async () => {
    const w = makeWorld();
    const id = await active(w);
    w.cf.calls.length = 0;
    const v = await refreshMachineStatus(w.fresh(), id);
    expect(v.cf_status).toBe("inactive");
    expect(w.cf.calls).toHaveLength(1);
    await refreshMachineStatus(w.fresh(), id);
    expect(w.cf.calls).toHaveLength(1);
    w.clock.now += 61;
    await refreshMachineStatus(w.fresh(), id);
    expect(w.cf.calls).toHaveLength(2);
  });
});
