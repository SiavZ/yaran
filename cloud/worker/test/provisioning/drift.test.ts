/**
 * cf_drift: per-resource drift repaired and audited, vanished resources start a repair, a new
 * tunnel bumps the generation, the cursor walks and wraps, and 0 disables it.
 *
 * <module-headers:begin>
 * Uses:
 * test/provisioning/drift.test.ts
 * ├── src/provisioning/index.ts
 * ├── src/reconcile/drift.ts
 * ├── src/reconcile/kit.ts
 * ├── src/reconcile/tasks.ts
 * └── test/provisioning/helpers/world.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm run test:provisioning in cloud/worker)
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import { startProvision } from "../../src/provisioning/index.ts";
import { DRIFT_TASK, runCfDrift } from "../../src/reconcile/drift.ts";
import { readTaskCursor } from "../../src/reconcile/kit.ts";
import { runDriveOps } from "../../src/reconcile/tasks.ts";
import { machine, makeWorld, ops, seedMachine, setSetting, type World } from "./helpers/world.ts";

async function active(w: World): Promise<string> {
  const id = seedMachine(w);
  await startProvision(w.ctx, id);
  w.db.sqlite.prepare("UPDATE machines SET status = 'active' WHERE id = ?").run(id);
  return id;
}

const reasons = (w: World) => w.audits.filter((a) => a.action === "drift.repaired").flatMap((a) => a.detail?.["reasons"] as string[]);

describe("cf_drift", () => {
  it("repairs drift on the policy, app, ingress and DNS record and audits the reasons", async () => {
    const w = makeWorld();
    const id = await active(w);
    const m = machine(w, id);
    w.cf.state.policies.get(m["access_policy_id"] as string)!.include = [{ everyone: {} }];
    w.cf.state.apps.get(m["access_app_id"] as string)!["enable_binding_cookie"] = true;
    const t = w.cf.state.tunnels.get(m["tunnel_id"] as string)!;
    (t.config as { originRequest: unknown }).originRequest = { access: { required: false } };
    w.cf.state.dns.get(m["dns_record_id"] as string)!.proxied = false;
    await runCfDrift(w.fresh());
    expect(reasons(w).sort()).toEqual(["app.enable_binding_cookie", "dns.proxied", "ingress.tunnel_origin_request", "policy.include"]);
    expect(w.cf.state.policies.get(m["access_policy_id"] as string)!.include).toEqual([{ email: { email: expect.any(String) } }]);
    expect(w.cf.state.apps.get(m["access_app_id"] as string)!["enable_binding_cookie"]).toBe(false);
    expect((t.config as { originRequest: unknown }).originRequest).toEqual({});
    expect(w.cf.state.dns.get(m["dns_record_id"] as string)!.proxied).toBe(true);
    w.audits.length = 0;
    await runCfDrift(w.fresh());
    expect(reasons(w)).toEqual([]);
  });

  it("starts a repair op for a vanished tunnel; the new tunnel bumps the generation", async () => {
    const w = makeWorld();
    const id = await active(w);
    const old = machine(w, id)["tunnel_id"] as string;
    w.cf.state.tunnels.get(old)!.deleted_at = "now";
    await runCfDrift(w.fresh());
    expect(ops(w, id).at(-1)).toMatchObject({ kind: "repair", state: "pending" });
    await runDriveOps(w.fresh());
    const m = machine(w, id);
    expect(m["tunnel_id"]).not.toBe(old);
    expect(m["tunnel_secret_generation"]).toBe(2);
    expect(m["status"]).toBe("active");
    expect(w.cf.state.dns.get(m["dns_record_id"] as string)!.content).toBe(`${m["tunnel_id"]}.cfargotunnel.com`);
  });

  it("recreates a vanished Access app through repair (and the ingress follows the new AUD)", async () => {
    const w = makeWorld();
    const id = await active(w);
    const m0 = machine(w, id);
    w.cf.state.apps.delete(m0["access_app_id"] as string);
    await runCfDrift(w.fresh());
    await runDriveOps(w.fresh());
    const m = machine(w, id);
    expect(m["access_app_id"]).not.toBe(m0["access_app_id"]);
    const cfg = w.cf.state.tunnels.get(m["tunnel_id"] as string)!.config as { ingress: Array<{ originRequest?: { access: { audTag: string[] } } }> };
    expect(cfg.ingress[0]!.originRequest!.access.audTag).toEqual([m["access_app_aud"]]);
  });

  it("walks machines with a cursor, wraps at the end, and skips machines with a live op", async () => {
    const w = makeWorld();
    setSetting(w, "drift_machines_per_run", 2);
    const ids = [await active(w), await active(w), await active(w)].sort();
    w.cf.calls.length = 0;
    await runCfDrift(w.fresh());
    expect((await readTaskCursor<{ after: string | null }>(w.ctx, DRIFT_TASK)).after).toBe(ids[1]);
    expect(w.cf.calls).toHaveLength(8);
    await runCfDrift(w.fresh());
    expect((await readTaskCursor<{ after: string | null }>(w.ctx, DRIFT_TASK)).after).toBeNull();
    expect(w.cf.calls).toHaveLength(12);
  });

  it("is disabled at drift_machines_per_run = 0", async () => {
    const w = makeWorld();
    setSetting(w, "drift_machines_per_run", 0);
    await active(w);
    w.cf.calls.length = 0;
    expect((await runCfDrift(w.fresh())).note).toMatch(/disabled/);
    expect(w.cf.calls).toHaveLength(0);
  });
});
