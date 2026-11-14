/**
 * Provision: happy path, D21 order, golden ingress, conflicts, compensation and quota.
 *
 * <module-headers:begin>
 * Uses:
 * test/provisioning/provision.test.ts
 * ├── src/provisioning/index.ts
 * ├── test/provisioning/fake-cloudflare/faults.ts
 * └── test/provisioning/helpers/world.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm run test:provisioning in cloud/worker)
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import { startProvision } from "../../src/provisioning/index.ts";
import { on } from "./fake-cloudflare/faults.ts";
import { callLines, expectNoSecretsInD1, machine, makeWorld, OTHER_INST, ops, seedMachine, seedUser } from "./helpers/world.ts";

const creates = (lines: string[]) => lines.filter((l) => /^(POST|PUT) /.test(l));

describe("provision", () => {
  it("creates policy, app, tunnel, ingress and DNS in D21 order and awaits the claim", async () => {
    const w = makeWorld();
    const id = seedMachine(w, { userId: seedUser(w, "alice@example.org", "alice") });
    const ref = await startProvision(w.ctx, id);
    expect(ref.state).toBe("complete");
    expect(ref.created).toBe(true);
    const order = creates(callLines(w)).map((l) => l.replace(/\/[0-9a-f-]{36}/, "/{id}"));
    expect(order).toEqual([
      "POST /accounts/acct-1/access/policies",
      "POST /accounts/acct-1/access/apps",
      "POST /accounts/acct-1/cfd_tunnel",
      "PUT /accounts/acct-1/cfd_tunnel/{id}/configurations",
      "POST /zones/zone-1/dns_records",
    ]);
    const m = machine(w, id);
    expect(m["status"]).toBe("awaiting_claim");
    expect(m["hostname"]).toBe("laptop-alice.example.com");
    expect(m["ingress_origin_port"]).toBe(3890);
    expect(w.cf.state.violations).toEqual([]);
    expectNoSecretsInD1(w);
    const t = [...w.cf.state.tunnels.values()][0]!;
    expect(t.config).toEqual({
      ingress: [
        {
          hostname: "laptop-alice.example.com",
          service: "http://127.0.0.1:3890",
          originRequest: { access: { required: true, teamName: "acme", audTag: [m["access_app_aud"]] } },
        },
        { service: "http_status:404" },
      ],
      originRequest: {},
    });
  });

  it("is idempotent: a second start of a finished machine is refused, a live op is returned", async () => {
    const w = makeWorld();
    const id = seedMachine(w);
    await startProvision(w.ctx, id);
    await expect(startProvision(w.ctx, id)).rejects.toMatchObject({ code: "conflict" });
    const id2 = seedMachine(w);
    w.cf.faults.push({ kind: "transient", when: on("POST", /access\/apps$/) });
    const a = await startProvision(w.ctx, id2);
    const b = await startProvision(w.ctx, id2);
    expect(b).toMatchObject({ op_id: a.op_id, created: false });
  });

  it("skips hostnames held by foreign DNS, foreign apps, live machines and the control-plane label", async () => {
    const w = makeWorld({ settings: { control_plane_host: "laptop-bob.example.com" } });
    const bob = seedUser(w, "bob@example.org", "bob");
    w.cf.state.dns.set("r1", { id: "r1", type: "A", name: "laptop-bob-2.example.com", content: "1.2.3.4", proxied: true, ttl: 1, comment: null });
    w.cf.state.apps.set("a1", { id: "a1", aud: "x", name: "someone else", domain: "laptop-bob-3.example.com" });
    const held = seedMachine(w, { userId: bob, status: "active" });
    w.db.sqlite.prepare("UPDATE machines SET hostname = 'laptop-bob-4.example.com' WHERE id = ?").run(held);
    const id = seedMachine(w, { userId: bob });
    const ref = await startProvision(w.ctx, id);
    expect(ref.state).toBe("complete");
    expect(machine(w, id)["hostname"]).toBe("laptop-bob-5.example.com");
  });

  it("a foreign record at the hostname at P5 is a permanent conflict: compensates and releases the hostname", async () => {
    const w = makeWorld();
    const id = seedMachine(w, { userId: seedUser(w, "carol@example.org", "carol") });
    // Appears after preflight checked the name (a race with a dashboard edit).
    w.cf.faults.push({
      kind: "crash_after",
      when: on("PUT", /configurations$/),
    });
    w.cf.onCrash = () => {
      w.cf.state.dns.set("foreign", { id: "foreign", type: "CNAME", name: "laptop-carol.example.com", content: "elsewhere.example.net", proxied: true, ttl: 1, comment: `yaran:${OTHER_INST}:m:x` });
    };
    const ref = await startProvision(w.ctx, id);
    expect(ref).toMatchObject({ state: "failed", error_code: "hostname_conflict" });
    const m = machine(w, id);
    expect(m).toMatchObject({ status: "failed", revoke_reason: "provision_failed", hostname: null, tunnel_id: null, access_app_id: null, access_policy_id: null });
    expect(w.cf.state.liveTunnels()).toHaveLength(0);
    expect(w.cf.state.apps.size).toBe(0);
    expect(w.cf.state.policies.size).toBe(0);
    expect(w.cf.state.dns.get("foreign")).toBeDefined();
    expect(w.cf.state.violations).toEqual([]);
    expect(ops(w, id)[0]).toMatchObject({ state: "compensated", last_error_code: "hostname_conflict" });
  });

  it("refuses at the quota with a message naming it and how to raise it (and honors a soft cap, hook H5)", async () => {
    const w = makeWorld({ settings: { quota_limits: { access_apps: 2, access_policies: 500, tunnels: 1000 } } });
    for (let i = 0; i < 2; i++) w.cf.state.apps.set(`a${i}`, { id: `a${i}`, aud: "x", name: `other ${i}`, domain: `o${i}.example.net` });
    const id = seedMachine(w);
    const ref = await startProvision(w.ctx, id);
    expect(ref).toMatchObject({ state: "failed", error_code: "account_quota_reached" });
    const refused = w.audits.find((a) => a.action === "quota.refused");
    expect(refused?.detail).toEqual({ resource: "access_apps", used: 2, limit: 2 });
    const failed = w.audits.find((a) => a.action === "provision.failed");
    expect(String(failed?.detail?.["message"])).toMatch(/2 of 2 Access applications.*quota_limits\.access_apps/);
    expect(w.cf.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });
});
