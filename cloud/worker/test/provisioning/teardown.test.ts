/**
 * Teardown: D21 order, idempotence, revoke reasons, the T3/T4 loop, tunnel_delete_blocked,
 * and superseding a live op.
 *
 * <module-headers:begin>
 * Uses:
 * test/provisioning/teardown.test.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/provisioning/engine.ts
 * ├── src/provisioning/index.ts
 * ├── src/provisioning/machine-rows.ts
 * ├── src/provisioning/ops-store.ts
 * ├── test/provisioning/fake-cloudflare/faults.ts
 * └── test/provisioning/helpers/world.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm run test:provisioning in cloud/worker)
 * <module-headers:end>
 */
import { validate } from "@yaran/protocol";
import { describe, expect, it } from "vitest";
import { driveOp, INLINE_BUDGET, TEARDOWN_PLAN } from "../../src/provisioning/engine.ts";
import { startProvision, startTeardown } from "../../src/provisioning/index.ts";
import type { RevokeReason } from "../../src/provisioning/machine-rows.ts";
import { startOp } from "../../src/provisioning/ops-store.ts";
import { on } from "./fake-cloudflare/faults.ts";
import { callLines, expectNoSecretsInD1, machine, makeWorld, ops, seedMachine, setSetting, type World } from "./helpers/world.ts";

async function provisioned(w: World): Promise<string> {
  const id = seedMachine(w);
  await startProvision(w.ctx, id);
  w.db.sqlite.prepare("UPDATE machines SET status = 'active' WHERE id = ?").run(id);
  w.cf.calls.length = 0;
  return id;
}

const mutations = (w: World) => callLines(w).filter((l) => !l.startsWith("GET ")).map((l) => l.replace(/\/[0-9a-f-]{32,36}/g, "/{id}"));

describe("teardown", () => {
  it("runs DNS → invalidate → connections → tunnel → app → policy and releases the machine", async () => {
    const w = makeWorld();
    const id = await provisioned(w);
    const ref = await startTeardown(w.ctx, id, "user_unpair");
    expect(ref).toMatchObject({ state: "complete", kind: "teardown", created: true });
    expect(mutations(w)).toEqual([
      "DELETE /zones/zone-1/dns_records/{id}",
      "PATCH /accounts/acct-1/cfd_tunnel/{id}",
      "DELETE /accounts/acct-1/cfd_tunnel/{id}/connections",
      "DELETE /accounts/acct-1/cfd_tunnel/{id}",
      "DELETE /accounts/acct-1/access/apps/{id}",
      "DELETE /accounts/acct-1/access/policies/{id}",
    ]);
    expect(callLines(w).some((l) => l.includes("cascade")) || w.cf.calls.some((c) => c.query.includes("cascade"))).toBe(false);
    expect(machine(w, id)).toMatchObject({ status: "revoked", hostname: null, tunnel_id: null, dns_record_id: null, access_app_id: null, access_app_aud: null, access_policy_id: null, revoke_reason: "user_unpair" });
    expect(w.cf.state.dns.size + w.cf.state.liveTunnels().length + w.cf.state.apps.size + w.cf.state.policies.size).toBe(0);
    expect(w.cf.state.violations).toEqual([]);
    expect(w.audits.at(-1)?.action).toBe("teardown.done");
    expectNoSecretsInD1(w);
  });

  it("is idempotent: a second teardown over already-deleted resources converges", async () => {
    const w = makeWorld();
    const id = await provisioned(w);
    const before = machine(w, id);
    await startTeardown(w.ctx, id, "admin_revoke");
    // Put the old ids back and run the whole teardown again: every step meets a 404.
    w.db.sqlite
      .prepare("UPDATE machines SET status = 'revoking', tunnel_id = ?, dns_record_id = ?, access_app_id = ?, access_policy_id = ? WHERE id = ?")
      .run(before["tunnel_id"] as string, before["dns_record_id"] as string, before["access_app_id"] as string, before["access_policy_id"] as string, id);
    const { op } = await startOp(w.db, { machineId: id, kind: "teardown", params: { plan: TEARDOWN_PLAN, intent: {} }, requestedBy: "t", now: w.clock.now });
    const r = await driveOp(w.ctx, op.id, INLINE_BUDGET);
    expect(r.op.state).toBe("succeeded");
    expect(machine(w, id)["status"]).toBe("revoked");
  });

  it.each<[RevokeReason, "user" | "admin" | "machine" | "system", string]>([
    ["machine_logout", "machine", "machine"],
    ["user_unpair", "user", "user-1"],
    ["admin_revoke", "admin", "admin-1"],
    ["user_disabled", "admin", "admin-1"],
    ["stale", "system", "system"],
  ])("records revoke_reason %s and answers TeardownStarted", async (reason, kind, revokedBy) => {
    const w = makeWorld();
    const id = await provisioned(w);
    w.ctx.actor = { kind, id: kind === "user" ? "user-1" : kind === "admin" ? "admin-1" : null };
    await startTeardown(w.ctx, id, reason);
    expect(machine(w, id)).toMatchObject({ revoke_reason: reason, revoked_by: revokedBy, status: "revoked" });
    const body = { machine_id: id, state: "tearing_down" };
    expect(validate("TeardownStarted", body).valid).toBe(true);
  });

  it("loops T3→T4 while the tunnel refuses deletion, then succeeds", async () => {
    const w = makeWorld();
    const id = await provisioned(w);
    w.cf.faults.push({ kind: "permanent", when: on("DELETE", /cfd_tunnel\/[^/]+$/), times: 2 });
    const ref = await startTeardown(w.ctx, id, "admin_revoke");
    expect(ref.state).toBe("complete");
    expect(mutations(w).filter((l) => l.endsWith("/connections"))).toHaveLength(3);
    expect(w.cf.state.violations).toEqual([]);
  });

  it("fails tunnel_delete_blocked after the full backoff, leaving the app and policy in place", async () => {
    const w = makeWorld();
    setSetting(w, "provision_max_attempts", 2);
    const id = await provisioned(w);
    w.cf.faults.push({ kind: "permanent", when: on("DELETE", /cfd_tunnel\/[^/]+$/), times: 999 });
    let ref = await startTeardown(w.ctx, id, "admin_revoke");
    expect(ref.state).toBe("in_progress");
    w.clock.now += 31;
    const opId = ref.op_id;
    const r = await driveOp(w.fresh(), opId, INLINE_BUDGET);
    expect(r.op).toMatchObject({ state: "failed", last_error_code: "tunnel_delete_blocked" });
    expect(machine(w, id)["status"]).toBe("revoking");
    expect(w.cf.state.apps.size).toBe(1);
    expect(w.cf.state.policies.size).toBe(1);
    expect(w.cf.state.dns.size).toBe(0);
    expect(w.cf.state.violations).toEqual([]);
    // The admin's retry (07) starts a fresh teardown that finishes once Cloudflare relents.
    w.cf.faults.length = 0;
    ref = await startTeardown(w.fresh(), id, "admin_revoke");
    expect(ref).toMatchObject({ state: "complete", created: true });
    expect(machine(w, id)["status"]).toBe("revoked");
  });

  it("supersedes a pending provision op and tears down what it created", async () => {
    const w = makeWorld();
    const id = seedMachine(w);
    w.cf.faults.push({ kind: "transient", when: on("POST", /cfd_tunnel$/) });
    const p = await startProvision(w.ctx, id);
    expect(p.state).toBe("in_progress");
    const ref = await startTeardown(w.ctx, id, "user_unpair");
    expect(ref).toMatchObject({ kind: "teardown", state: "complete" });
    expect(ops(w, id).map((o) => `${o["kind"]}:${o["state"]}`)).toEqual(["provision:failed", "teardown:succeeded"]);
    expect(w.cf.state.apps.size + w.cf.state.policies.size).toBe(0);
    expect(machine(w, id)["status"]).toBe("revoked");
  });
});
