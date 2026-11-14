/**
 * Origin port changes (W4 claim, W32): no-op detection, P4-only repair, a change during a
 * live op, a claim on another port, and drift repair of a crash-left mismatch.
 *
 * <module-headers:begin>
 * Uses:
 * test/provisioning/origin-port.test.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/provisioning/engine.ts
 * ├── src/provisioning/index.ts
 * ├── src/reconcile/drift.ts
 * ├── src/reconcile/tasks.ts
 * ├── test/provisioning/fake-cloudflare/faults.ts
 * └── test/provisioning/helpers/world.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm run test:provisioning in cloud/worker)
 * <module-headers:end>
 */
import { validate } from "@yaran/protocol";
import { describe, expect, it } from "vitest";
import { driveOp, INLINE_BUDGET } from "../../src/provisioning/engine.ts";
import { rotateTunnelSecret, setOriginPort, startProvision, startRepair } from "../../src/provisioning/index.ts";
import { runCfDrift } from "../../src/reconcile/drift.ts";
import { runDriveOps } from "../../src/reconcile/tasks.ts";
import { on } from "./fake-cloudflare/faults.ts";
import { machine, makeWorld, ops, seedMachine, type World } from "./helpers/world.ts";

async function active(w: World, port = 3890): Promise<string> {
  const id = seedMachine(w, { originPort: port });
  await startProvision(w.ctx, id);
  w.db.sqlite.prepare("UPDATE machines SET status = 'active' WHERE id = ?").run(id);
  w.cf.calls.length = 0;
  return id;
}

const servicePort = (w: World, id: string) => {
  const t = w.cf.state.tunnels.get(machine(w, id)["tunnel_id"] as string)!;
  return (t.config as { ingress: Array<{ service: string }> }).ingress[0]!.service;
};

describe("setOriginPort", () => {
  it("same port: changed false and no API call", async () => {
    const w = makeWorld();
    const id = await active(w);
    const r = await setOriginPort(w.ctx, id, 3890);
    expect(r).toEqual({ changed: false, op: null });
    expect(validate("OriginUpdateResult", { origin_port: 3890, changed: r.changed }).valid).toBe(true);
    expect(w.cf.calls).toHaveLength(0);
  });

  it("new port: persists, audits, re-PUTs only the ingress and records ingress_origin_port", async () => {
    const w = makeWorld();
    const id = await active(w);
    const r = await setOriginPort(w.ctx, id, 4555);
    expect(r.changed).toBe(true);
    expect(r.op).toMatchObject({ kind: "repair", state: "complete" });
    expect(w.cf.calls.map((c) => `${c.method} ${c.path.replace(/[0-9a-f-]{36}/, "{id}")}`)).toEqual(["PUT /accounts/acct-1/cfd_tunnel/{id}/configurations"]);
    expect(machine(w, id)).toMatchObject({ origin_port: 4555, ingress_origin_port: 4555 });
    expect(servicePort(w, id)).toBe("http://127.0.0.1:4555");
    expect(w.audits.find((a) => a.action === "machine.origin_changed")?.detail).toEqual({ old_port: 3890, new_port: 4555 });
  });

  it("rejects an invalid port", async () => {
    const w = makeWorld();
    const id = await active(w);
    await expect(setOriginPort(w.ctx, id, 0)).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("a change while a repair op is live starts no second op and is applied when that op ends", async () => {
    const w = makeWorld();
    const id = await active(w);
    w.cf.faults.push({ kind: "transient", when: on("PUT", /configurations$/), times: 3 });
    const repair = await startRepair(w.ctx, id);
    expect(repair.state).toBe("in_progress");
    const r = await setOriginPort(w.ctx, id, 5000);
    expect(r).toEqual({ changed: true, op: null });
    expect(ops(w, id).filter((o) => o["state"] !== "succeeded")).toHaveLength(1);
    w.clock.now += 60;
    await driveOp(w.fresh(), repair.op_id, INLINE_BUDGET);
    expect(machine(w, id)).toMatchObject({ origin_port: 5000, ingress_origin_port: 5000 });
    expect(servicePort(w, id)).toBe("http://127.0.0.1:5000");
  });

  it("a change while a rotate op is live is applied by a P4-only repair when the rotate ends", async () => {
    const w = makeWorld();
    const id = await active(w);
    w.cf.faults.push({ kind: "transient", when: on("PATCH", /cfd_tunnel\/[^/]+$/) });
    await expect(rotateTunnelSecret(w.ctx, id, { evict: false })).rejects.toBeDefined();
    expect(await setOriginPort(w.ctx, id, 6000)).toEqual({ changed: true, op: null });
    w.clock.now += 60;
    await runDriveOps(w.fresh()); // finishes the rotate, whose end starts the P4-only repair
    await runDriveOps(w.fresh()); // the next tick drives it
    const kinds = ops(w, id).map((o) => `${o["kind"]}:${o["state"]}:${JSON.parse(o["params"] as string).plan.join(",")}`);
    expect(kinds).toEqual(["provision:succeeded:preflight,policy,app,tunnel,ingress,dns,finalize", "rotate:succeeded:rotate_secret,evict", "repair:succeeded:ingress"]);
    expect(servicePort(w, id)).toBe("http://127.0.0.1:6000");
  });

  it("a claim on another port than the authorize port ends with the ingress on the claimed port", async () => {
    const w = makeWorld();
    const id = seedMachine(w, { originPort: 3890 });
    await startProvision(w.ctx, id);
    // 06's W4 handler: ClaimRequest.origin_port is authoritative.
    const r = await setOriginPort(w.ctx, id, 7123);
    expect(r.changed).toBe(true);
    expect(servicePort(w, id)).toBe("http://127.0.0.1:7123");
  });

  it("cf_drift repairs an origin_port/ingress_origin_port mismatch a crash left behind", async () => {
    const w = makeWorld();
    const id = await active(w);
    w.db.sqlite.prepare("UPDATE machines SET origin_port = 8080 WHERE id = ?").run(id);
    await runCfDrift(w.fresh());
    expect(machine(w, id)).toMatchObject({ ingress_origin_port: 8080 });
    expect(servicePort(w, id)).toBe("http://127.0.0.1:8080");
    expect(w.audits.find((a) => a.action === "drift.repaired")?.detail?.["reasons"]).toContain("ingress.origin_port");
  });
});
