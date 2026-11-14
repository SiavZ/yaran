/**
 * Endpoint modules against the fake Cloudflare: one case per function family, including the
 * token present/absent fallback, `connections` absent, app domain+exact, and policy paging.
 *
 * <module-headers:begin>
 * Uses:
 * test/provisioning/endpoints.test.ts
 * ├── src/cloudflare/access.ts
 * ├── src/cloudflare/dns.ts
 * ├── src/cloudflare/tunnels.ts
 * └── test/provisioning/helpers/world.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm run test:provisioning in cloud/worker)
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import * as access from "../../src/cloudflare/access.ts";
import * as dns from "../../src/cloudflare/dns.ts";
import * as tunnels from "../../src/cloudflare/tunnels.ts";
import { makeWorld } from "./helpers/world.ts";

const P = "interactive" as const;

describe("tunnels", () => {
  it.each([true, false])("create/rotate return a usable token (token in response: %s)", async (tokenInResponse) => {
    const w = makeWorld({ tokenInResponse });
    const t = await tunnels.createTunnel(w.ctx.cf, "acct-1", "yaran-a1b2c3d4-x", P);
    expect(t.token !== undefined).toBe(tokenInResponse);
    const before = w.cf.calls.length;
    const tok = await tunnels.rotateTunnelSecret(w.ctx.cf, "acct-1", t.id, tunnels.randomTunnelSecret(), P);
    expect(JSON.parse(atob(tok))).toMatchObject({ t: t.id });
    expect(w.cf.calls.length - before).toBe(tokenInResponse ? 1 : 2);
    expect(await tunnels.getTunnelToken(w.ctx.cf, "acct-1", t.id, P)).toBe(tok);
  });

  it("get/list/find work without a connections field; 409 on a live duplicate", async () => {
    const w = makeWorld();
    const t = await tunnels.createTunnel(w.ctx.cf, "acct-1", "yaran-a1b2c3d4-y", P);
    const got = await tunnels.getTunnel(w.ctx.cf, "acct-1", t.id, P);
    expect(got).not.toHaveProperty("connections");
    expect((await tunnels.findTunnelByName(w.ctx.cf, "acct-1", t.name, P))?.id).toBe(t.id);
    expect((await tunnels.listTunnels(w.ctx.cf, "acct-1", { include_prefix: "yaran-a1b2c3d4-", per_page: 1000, maxPages: 1 }, P)).total).toBe(1);
    await expect(tunnels.createTunnel(w.ctx.cf, "acct-1", t.name, P)).rejects.toMatchObject({ kind: "conflict" });
  });

  it("config round trip, eviction and delete refusal while connected", async () => {
    const w = makeWorld();
    const t = await tunnels.createTunnel(w.ctx.cf, "acct-1", "n", P);
    const v = await tunnels.putTunnelConfig(w.ctx.cf, "acct-1", t.id, { ingress: [{ service: "http_status:404" }] }, P);
    expect(v).toBe(1);
    expect((await tunnels.getTunnelConfig(w.ctx.cf, "acct-1", t.id, P)).config?.ingress).toHaveLength(1);
    w.cf.state.tunnels.get(t.id)!.connectors = 2;
    await expect(tunnels.deleteTunnel(w.ctx.cf, "acct-1", t.id, P)).rejects.toMatchObject({ kind: "invalid" });
    await tunnels.deleteTunnelConnections(w.ctx.cf, "acct-1", t.id, P);
    await tunnels.deleteTunnel(w.ctx.cf, "acct-1", t.id, P);
    expect(await tunnels.findTunnelByName(w.ctx.cf, "acct-1", "n", P)).toBeNull();
  });
});

describe("dns", () => {
  it("create, find by name, list by comment prefix, patch, delete; same-name conflict", async () => {
    const w = makeWorld();
    const body = { type: "CNAME" as const, name: "a.example.com", content: "t.cfargotunnel.com", proxied: true, ttl: 1, comment: "yaran:a1b2c3d4:m:x" };
    w.cf.state.apps.set("app", { id: "app", aud: "x", domain: "a.example.com", name: "n" });
    const r = await dns.createDnsRecord(w.ctx.cf, "zone-1", body, P);
    expect((await dns.findDnsByName(w.ctx.cf, "zone-1", "A.EXAMPLE.COM", P))[0]?.id).toBe(r.id);
    expect((await dns.listDnsByCommentPrefix(w.ctx.cf, "zone-1", "yaran:a1b2c3d4:m:", P)).items).toHaveLength(1);
    expect((await dns.patchDnsRecord(w.ctx.cf, "zone-1", r.id, { content: "u.cfargotunnel.com" }, P)).content).toBe("u.cfargotunnel.com");
    await expect(dns.createDnsRecord(w.ctx.cf, "zone-1", body, P)).rejects.toMatchObject({ kind: "conflict" });
    await dns.deleteDnsRecord(w.ctx.cf, "zone-1", r.id, P);
    await expect(dns.getDnsRecord(w.ctx.cf, "zone-1", r.id, P)).rejects.toMatchObject({ kind: "not_found" });
  });
});

describe("access", () => {
  it("finds apps by exact domain only", async () => {
    const w = makeWorld();
    await access.createApp(w.ctx.cf, "acct-1", { name: "a", domain: "m.example.com" }, P);
    await access.createApp(w.ctx.cf, "acct-1", { name: "b", domain: "m.example.com.evil" }, P);
    const found = await access.findAppsByDomain(w.ctx.cf, "acct-1", "m.example.com", P);
    expect(found.map((a) => a.name)).toEqual(["a"]);
    expect(w.cf.calls.at(-1)?.query).toContain("exact=true");
  });

  it("pages policies and refuses deleting an attached policy", async () => {
    const w = makeWorld();
    for (let i = 0; i < 5; i++) await access.createPolicy(w.ctx.cf, "acct-1", { name: `p${i}`, decision: "allow", include: [] }, P);
    const page1 = await access.listPolicies(w.ctx.cf, "acct-1", P, 1);
    expect(page1).toMatchObject({ total: 5 });
    expect(page1.items).toHaveLength(1);
    expect((await access.listPolicies(w.ctx.cf, "acct-1", P)).items).toHaveLength(5);
    const pol = page1.items[0]!;
    const app = await access.createApp(w.ctx.cf, "acct-1", { name: "a", domain: "d", policies: [{ id: pol.id, precedence: 1 }] }, P);
    expect((await access.getPolicy(w.ctx.cf, "acct-1", pol.id, P)).app_count).toBe(1);
    await expect(access.deletePolicy(w.ctx.cf, "acct-1", pol.id, P)).rejects.toMatchObject({ kind: "invalid" });
    await access.replaceApp(w.ctx.cf, "acct-1", app.id, { name: "a", domain: "d", policies: [] }, P);
    await access.deletePolicy(w.ctx.cf, "acct-1", pol.id, P);
    await access.deleteApp(w.ctx.cf, "acct-1", app.id, P);
    expect((await access.listApps(w.ctx.cf, "acct-1", P)).total).toBe(0);
  });
});
