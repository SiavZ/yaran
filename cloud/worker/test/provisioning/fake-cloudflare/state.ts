/**
 * In-memory state of the fake Cloudflare account and zone, with id minting, account limits
 * and the D21 safety invariants checked after every call.
 *
 * - Tunnels are soft-deleted (`deleted_at`), as the real API reports them.
 * - Limits: 1,000 tunnels, 500 Access apps, 500 reusable policies (account-limits page).
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * test/provisioning/fake-cloudflare/state.ts
 * ├── test/provisioning/fake-cloudflare/access.ts
 * ├── test/provisioning/fake-cloudflare/dns.ts
 * ├── test/provisioning/fake-cloudflare/index.ts
 * └── test/provisioning/fake-cloudflare/tunnels.ts
 * <module-headers:end>
 */

export interface FakeTunnel {
  id: string;
  name: string;
  secret: string;
  connectors: number;
  /** A rogue connector reconnects after eviction until the secret changes. */
  rogue: boolean;
  status: "inactive" | "degraded" | "healthy" | "down";
  deleted_at: string | null;
  config: unknown;
  configVersion: number;
  conns_active_at: string | null;
}

export interface FakeDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
  comment: string | null;
}

export interface FakeApp {
  id: string;
  aud: string;
  [k: string]: unknown;
}

export interface FakePolicy {
  id: string;
  name: string;
  decision: string;
  include: unknown[];
}

export const LIMITS = { tunnels: 1000, apps: 500, policies: 500 };

export class FakeState {
  tunnels = new Map<string, FakeTunnel>();
  dns = new Map<string, FakeDnsRecord>();
  apps = new Map<string, FakeApp>();
  policies = new Map<string, FakePolicy>();
  violations: string[] = [];
  /** Every token the fake ever handed out, for the "never persisted" scan. */
  issued: string[] = [];
  private seq = 0;

  hex(n: number): string {
    this.seq++;
    let out = "";
    let x = this.seq * 2654435761;
    while (out.length < n) {
      x = (x * 1103515245 + 12345) % 2147483648;
      out += x.toString(16).padStart(8, "0");
    }
    return out.slice(0, n);
  }

  uuid(): string {
    const h = this.hex(32);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  }

  liveTunnels(): FakeTunnel[] {
    return [...this.tunnels.values()].filter((t) => !t.deleted_at);
  }

  appCount(policyId: string): number {
    return [...this.apps.values()].filter((a) => ((a["policies"] as Array<{ id: string }> | undefined) ?? []).some((p) => p.id === policyId)).length;
  }

  /**
   * D21: no DNS record points at a tunnel unless an Access app protects its hostname, and no
   * marked tunnel exists without its marked Access app.
   */
  checkInvariants(after: string): void {
    const domains = new Set([...this.apps.values()].map((a) => String(a["domain"])));
    for (const r of this.dns.values()) {
      if (r.content.endsWith(".cfargotunnel.com") && !domains.has(r.name)) {
        this.violations.push(`${after}: DNS ${r.name} points at a tunnel with no Access app`);
      }
    }
    const appNames = new Set([...this.apps.values()].map((a) => String(a["name"])));
    for (const t of this.liveTunnels()) {
      const m = /^yaran-([0-9a-f]{8})-(.+)$/.exec(t.name);
      if (m && !appNames.has(`yaran:${m[1]}:m:${m[2]}`)) this.violations.push(`${after}: tunnel ${t.name} exists without its Access app`);
    }
  }
}
