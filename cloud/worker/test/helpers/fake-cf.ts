/**
 * An in-memory fake of the Cloudflare API endpoints Phase 07 calls, behind 05's transport.
 *
 * Keeps accounts, zones, DNS records, Worker custom domains, the workers.dev subdomain,
 * the Zero Trust org, Access apps and policies, IdPs and tunnels, and records every call.
 * Faults are injected per "METHOD path-prefix" as a `CfApiError` kind, the way 05's client
 * would surface a refusal. Response shapes follow the API reference (and stay UNVERIFIED
 * where the gates have not recorded them).
 *
 * <module-headers:begin>
 * Uses:
 * test/helpers/fake-cf.ts
 * ├── src/admin/ports.ts
 * └── src/cloudflare/setup-endpoints.ts
 * External: none
 *
 * Used by:
 * test/helpers/fake-cf.ts
 * ├── test/helpers/deps.ts
 * └── test/setup-steps.test.ts
 * <module-headers:end>
 */
import type { CfErrorKind, CfTransport } from "../../src/admin/ports.ts";
import type { CfAccessApp, CfIdp, CfPolicy, CfWorkerDomain } from "../../src/cloudflare/setup-endpoints.ts";

export class FakeCfError extends Error {
  constructor(
    readonly kind: CfErrorKind,
    readonly status: number,
  ) {
    super(`fake ${kind}`);
  }
}

const STATUS: Record<CfErrorKind, number> = { auth: 403, not_found: 404, conflict: 409, invalid: 400, rate_limited: 429, transient: 503 };

export class FakeCloudflare {
  calls: string[] = [];
  bodies: { call: string; body: unknown }[] = [];
  faults = new Map<string, CfErrorKind>();
  accounts = [{ id: "acc1", name: "Example" }];
  zones = [{ id: "z1", name: "example.org" }];
  dns: { zone: string; name: string }[] = [];
  domains: CfWorkerDomain[] = [];
  subdomain = { enabled: true };
  org: { auth_domain: string } | null = { auth_domain: "team.cloudflareaccess.com" };
  apps: CfAccessApp[] = [];
  policies: CfPolicy[] = [];
  idps: CfIdp[] = [{ id: "idp-cf", name: "Cloudflare", type: "cloudflare" }];
  private seq = 0;

  fault(prefix: string, kind: CfErrorKind): this {
    this.faults.set(prefix, kind);
    return this;
  }

  transport(): CfTransport {
    return { request: (method, path, body) => this.handle(method, path, body) as never };
  }

  private id(p: string): string {
    return `${p}-${++this.seq}`;
  }

  async handle(method: string, path: string, body?: unknown): Promise<unknown> {
    const call = `${method} ${path.split("?")[0]}`;
    this.calls.push(call);
    if (body !== undefined) this.bodies.push({ call, body });
    for (const [prefix, kind] of this.faults) if (call.startsWith(prefix)) throw new FakeCfError(kind, STATUS[kind]);
    const b = (body ?? {}) as Record<string, unknown>;
    const q = new URLSearchParams(path.split("?")[1] ?? "");
    const p = path.split("?")[0]!.replace(/^\/accounts\/[^/]+/, "/acct");
    if (call === "GET /accounts") return this.accounts;
    if (p.endsWith("/tokens/verify")) return { status: "active" };
    if (p === "/zones") return this.zones;
    if (/^\/zones\/[^/]+\/dns_records$/.test(p)) return this.dns.filter((r) => !q.get("name") || r.name === q.get("name"));
    if (p === "/acct/access/organizations") {
      if (method === "POST") return (this.org = { auth_domain: String(b.auth_domain) });
      if (!this.org) throw new FakeCfError("not_found", 404);
      return this.org;
    }
    if (p === "/acct/workers/domains") {
      if (method === "PUT") {
        const d = { id: this.id("dom"), hostname: String(b.hostname), service: String(b.service), zone_id: String(b.zone_id) };
        this.domains.push(d);
        return d;
      }
      return this.domains.filter((d) => !q.get("hostname") || d.hostname === q.get("hostname"));
    }
    if (/^\/acct\/workers\/scripts\/[^/]+\/subdomain$/.test(p)) {
      if (method === "POST") this.subdomain = { enabled: Boolean(b.enabled) };
      return this.subdomain;
    }
    if (/^\/acct\/workers\/scripts\/[^/]+\/settings$/.test(p)) return { logpush: false };
    if (p === "/acct/cfd_tunnel") return [];
    if (p === "/acct/access/identity_providers") {
      if (method === "POST") {
        const idp = { id: this.id("idp"), name: String(b.name), type: String(b.type) };
        this.idps.push(idp);
        return idp;
      }
      return this.idps;
    }
    if (p === "/acct/access/groups") return [{ id: "grp-1", name: "Engineering" }];
    if (p.startsWith("/acct/access/policies")) return this.upsert(this.policies, method, p, b, "pol");
    if (p.startsWith("/acct/access/apps")) {
      if (method !== "GET") {
        const overrides = (b.destinations as { overrides?: unknown[] }[] | undefined)?.some((d) => d.overrides);
        if (overrides && this.faults.has("overrides")) throw new FakeCfError("invalid", 400);
      }
      return this.upsert(this.apps, method, p, b, "app");
    }
    throw new Error(`fake Cloudflare has no route for ${call}`);
  }

  private upsert<T extends { id: string }>(list: T[], method: string, p: string, b: Record<string, unknown>, prefix: string): unknown {
    if (method === "GET") return list;
    const id = p.split("/").pop()!;
    if (method === "PUT") {
      const i = list.findIndex((x) => x.id === id);
      list[i] = { ...list[i]!, ...b, id };
      return list[i];
    }
    const created = { ...b, id: this.id(prefix), aud: `aud-${this.seq}` } as unknown as T;
    list.push(created);
    return created;
  }
}
