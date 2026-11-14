/**
 * Crash matrix: every Cloudflare-calling step × {transient before the call, crash after
 * success before recording, 429 with retry-after, permanent 4xx}. Each cell drives, injects,
 * re-drives until terminal, and checks exactly one resource of each kind (or none after
 * compensation or teardown), ids that match the fake, untouched foreign resources, no secret
 * in D1, and the D21 invariants after every call.
 *
 * <module-headers:begin>
 * Uses:
 * test/provisioning/crash-matrix.test.ts
 * ├── src/provisioning/engine.ts
 * ├── src/provisioning/index.ts
 * ├── src/provisioning/ops-store.ts
 * ├── src/reconcile/tasks.ts
 * ├── test/provisioning/fake-cloudflare/faults.ts
 * └── test/provisioning/helpers/world.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm run test:provisioning in cloud/worker)
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import { driveOp, INLINE_BUDGET, TEARDOWN_PLAN } from "../../src/provisioning/engine.ts";
import { startProvision, startTeardown } from "../../src/provisioning/index.ts";
import { startOp } from "../../src/provisioning/ops-store.ts";
import { runDriveOps } from "../../src/reconcile/tasks.ts";
import { on, type FaultKind } from "./fake-cloudflare/faults.ts";
import { expectNoSecretsInD1, machine, makeWorld, OTHER_INST, ops, seedMachine, type World } from "./helpers/world.ts";

const FAULTS: FaultKind[] = ["transient", "crash_after", "rate_limit", "permanent"];

const PROVISION_CALLS: Record<string, [string, RegExp]> = {
  preflight: ["GET", /dns_records$/],
  policy: ["POST", /access\/policies$/],
  app: ["POST", /access\/apps$/],
  tunnel: ["POST", /cfd_tunnel$/],
  ingress: ["PUT", /configurations$/],
  dns: ["POST", /dns_records$/],
};

const TEARDOWN_CALLS: Record<string, [string, RegExp]> = {
  unpublish_dns: ["DELETE", /dns_records\/[^/]+$/],
  invalidate: ["PATCH", /cfd_tunnel\/[^/]+$/],
  connections: ["DELETE", /\/connections$/],
  delete_tunnel: ["DELETE", /cfd_tunnel\/[^/]+$/],
  delete_app: ["DELETE", /access\/apps\/[^/]+$/],
  delete_policy: ["DELETE", /access\/policies\/[^/]+$/],
};

/** Another control plane's resources in the same account; they must survive every cell. */
function seedForeign(w: World): string {
  const id = "11111111-2222-4333-8444-555555555555";
  w.cf.state.policies.set("fp", { id: "fp", name: `yaran:${OTHER_INST}:owner:${id}`, decision: "allow", include: [] });
  w.cf.state.apps.set("fa", { id: "fa", aud: "faud", name: `yaran:${OTHER_INST}:m:${id}`, domain: "box-zed.example.com", policies: [{ id: "fp", precedence: 1 }] });
  w.cf.state.tunnels.set("ft", { id: "ft", name: `yaran-${OTHER_INST}-${id}`, secret: "foreign-tunnel-secret-0000000000", connectors: 1, rogue: false, status: "healthy", deleted_at: null, config: null, configVersion: 0, conns_active_at: null });
  w.cf.state.dns.set("fd", { id: "fd", type: "CNAME", name: "box-zed.example.com", content: "ft.cfargotunnel.com", proxied: true, ttl: 1, comment: `yaran:${OTHER_INST}:m:${id}` });
  return JSON.stringify([w.cf.state.policies.get("fp"), w.cf.state.apps.get("fa"), w.cf.state.tunnels.get("ft"), w.cf.state.dns.get("fd")]);
}

function foreignNow(w: World): string {
  return JSON.stringify([w.cf.state.policies.get("fp"), w.cf.state.apps.get("fa"), w.cf.state.tunnels.get("ft"), w.cf.state.dns.get("fd")]);
}

/** Ours = everything without the foreign ids. */
function ours(w: World) {
  return {
    policies: [...w.cf.state.policies.values()].filter((p) => p.id !== "fp"),
    apps: [...w.cf.state.apps.values()].filter((a) => a.id !== "fa"),
    tunnels: w.cf.state.liveTunnels().filter((t) => t.id !== "ft"),
    dns: [...w.cf.state.dns.values()].filter((r) => r.id !== "fd"),
  };
}

async function untilTerminal(w: World, machineId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 40; i++) {
    const live = ops(w, machineId).find((o) => ["pending", "running", "compensating"].includes(o["state"] as string));
    if (!live) return ops(w, machineId).at(-1)!;
    w.clock.now += 7200;
    await runDriveOps(w.fresh());
  }
  throw new Error("op never reached a terminal state");
}

async function attempt(p: Promise<unknown>): Promise<void> {
  try {
    await p;
  } catch (err) {
    if (!(err instanceof Error) || !/simulated crash/.test(err.message)) throw err;
  }
}

function expectOneEach(w: World, id: string): void {
  const o = ours(w);
  const m = machine(w, id);
  expect([o.policies.length, o.apps.length, o.tunnels.length, o.dns.length]).toEqual([1, 1, 1, 1]);
  expect(m).toMatchObject({ access_policy_id: o.policies[0]!.id, access_app_id: o.apps[0]!.id, tunnel_id: o.tunnels[0]!.id, dns_record_id: o.dns[0]!.id });
  expect(m["access_app_aud"]).toBe(o.apps[0]!.aud);
}

function expectNone(w: World): void {
  const o = ours(w);
  expect([o.policies.length, o.apps.length, o.tunnels.length, o.dns.length]).toEqual([0, 0, 0, 0]);
}

describe("crash matrix: provision", () => {
  for (const [step, [method, path]] of Object.entries(PROVISION_CALLS)) {
    for (const fault of FAULTS) {
      it(`${step} × ${fault}`, async () => {
        const w = makeWorld();
        const foreign = seedForeign(w);
        const id = seedMachine(w);
        w.cf.faults.push({ kind: fault, when: on(method, path) });
        await attempt(startProvision(w.ctx, id));
        const final = await untilTerminal(w, id);
        if (fault === "permanent") {
          expect(final["state"]).toBe("compensated");
          expect(machine(w, id)).toMatchObject({ status: "failed", hostname: null });
          expectNone(w);
        } else {
          expect(final["state"]).toBe("succeeded");
          expect(machine(w, id)["status"]).toBe("awaiting_claim");
          expectOneEach(w, id);
        }
        expect(w.cf.faults[0]?.times, "the fault fired").toBe(0);
        expect(foreignNow(w)).toBe(foreign);
        expect(w.cf.state.violations).toEqual([]);
        expectNoSecretsInD1(w);
      });
    }
  }
});

describe("crash matrix: teardown", () => {
  for (const [step, [method, path]] of Object.entries(TEARDOWN_CALLS)) {
    for (const fault of FAULTS) {
      it(`${step} × ${fault}`, async () => {
        const w = makeWorld();
        const foreign = seedForeign(w);
        const id = seedMachine(w);
        await startProvision(w.ctx, id);
        w.db.sqlite.prepare("UPDATE machines SET status = 'active' WHERE id = ?").run(id);
        const before = machine(w, id);
        w.cf.faults.push({ kind: fault, when: on(method, path) });
        await attempt(startTeardown(w.fresh(), id, "admin_revoke"));
        let final = await untilTerminal(w, id);
        if (final["state"] === "failed") {
          // A permanent refusal leaves the machine revoking for the admin's retry (07).
          expect(machine(w, id)["status"]).toBe("revoking");
          await startTeardown(w.fresh(), id, "admin_revoke");
          final = await untilTerminal(w, id);
        }
        expect(final["state"]).toBe("succeeded");
        expect(machine(w, id)["status"]).toBe("revoked");
        expectNone(w);
        // Run the teardown a second time over the same ids: idempotent.
        w.db.sqlite
          .prepare("UPDATE machines SET status = 'revoking', tunnel_id = ?, dns_record_id = ?, access_app_id = ?, access_policy_id = ? WHERE id = ?")
          .run(before["tunnel_id"] as string, before["dns_record_id"] as string, before["access_app_id"] as string, before["access_policy_id"] as string, id);
        const { op } = await startOp(w.db, { machineId: id, kind: "teardown", params: { plan: TEARDOWN_PLAN, intent: {} }, requestedBy: "t", now: w.clock.now });
        expect((await driveOp(w.fresh(), op.id, INLINE_BUDGET)).op.state).toBe("succeeded");
        expectNone(w);
        expect(w.cf.faults[0]?.times, "the fault fired").toBe(0);
        expect(foreignNow(w)).toBe(foreign);
        expect(w.cf.state.violations).toEqual([]);
        expectNoSecretsInD1(w);
      });
    }
  }
});
