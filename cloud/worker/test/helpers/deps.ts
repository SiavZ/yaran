/**
 * Test doubles for `Phase07Deps`: a D1 shim, a fake Cloudflare, and recording fakes of the
 * 04/05/06 ports (sealer, audit, rate limit, Access identity, provisioning, pairing).
 *
 * <module-headers:begin>
 * Uses:
 * test/helpers/deps.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/admin/ports.ts
 * ├── src/console/route-types.ts
 * ├── test/helpers/d1.ts
 * └── test/helpers/fake-cf.ts
 * External: none
 *
 * Used by:
 * test/helpers/deps.ts
 * ├── test/admin-services.test.ts
 * ├── test/console.test.ts
 * ├── test/setup-flow.test.ts
 * └── test/setup-steps.test.ts
 * <module-headers:end>
 */
import type { AdminDevice, AdminMachine } from "@yaran/protocol";
import type { AuditInput } from "../../src/admin/ports.ts";
import type { Phase07Deps, RouteCtx, RouteRow } from "../../src/console/route-types.ts";
import { testDb } from "./d1.ts";
import { FakeCloudflare } from "./fake-cf.ts";

export const SETUP_CODE = "correct-horse-battery-staple-xyz";

export interface TestWorld {
  deps: Phase07Deps;
  cf: FakeCloudflare;
  audits: AuditInput[];
  calls: string[];
  machines: AdminMachine[];
  devices: AdminDevice[];
  identity: { email: string; sub: string } | null;
  clock: { now: Date };
  db: ReturnType<typeof testDb>;
}

const KNOWN: Record<string, string> = { "ada@example.org": "00000000-0000-4000-8000-0000000000a1", "bob@example.org": "00000000-0000-4000-8000-0000000000b2" };
/** A stable UUID per test email. */
export function uid(email: string): string {
  return KNOWN[email] ?? "00000000-0000-4000-8000-0000000000ff";
}

export function machine(over: Partial<AdminMachine> = {}): AdminMachine {
  return {
    id: "00000000-0000-4000-8000-000000000101",
    name: "laptop",
    hostname: "laptop-ada.example.org",
    url: "https://laptop-ada.example.org",
    status: "online",
    status_checked_at: "2026-11-14T10:00:00Z",
    last_seen_at: "2026-11-14T10:00:00Z",
    paired_at: "2026-11-01T10:00:00Z",
    reported_protocol: 1,
    owner_email: "ada@example.org",
    key_fingerprint: "ABCD-EFGH-IJKL-MNOP-QRST-UVWX",
    origin_port: 8080,
    tunnel_id: "00000000-0000-4000-8000-000000000001",
    access_app_id: "app-x",
    token_version: 1,
    provisioning: { state: "complete", last_error_code: null },
    ...over,
  } as AdminMachine;
}

export function device(over: Partial<AdminDevice> = {}): AdminDevice {
  return {
    id: "00000000-0000-4000-8000-000000000201",
    install_id: "9b8a7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d",
    device_key_fingerprint: "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF",
    platform: "android",
    flavor: "foss",
    form_factor: "phone",
    app_version: "1.0.0",
    label: "Pixel",
    push: { kind: "webpush", channel: "unifiedpush" },
    push_state: "gone",
    mute_all: false,
    muted_until: null,
    muted_machine_ids: [],
    created_at: "2026-11-01T10:00:00Z",
    last_seen_at: "2026-11-14T10:00:00Z",
    current: false,
    owner_email: "ada@example.org",
    ...over,
  } as AdminDevice;
}

export function world(): TestWorld {
  const db = testDb();
  const cf = new FakeCloudflare();
  const w = { cf, audits: [] as AuditInput[], calls: [] as string[], machines: [machine()], devices: [device()], identity: null as TestWorld["identity"], clock: { now: new Date("2026-11-14T12:00:00Z") }, db } as TestWorld;
  let n = 0;
  w.deps = {
    db,
    env: { SETUP_CODE, DATA_KEY: "a".repeat(64), CF_API_TOKEN: "cf-token" },
    sealer: { seal: async (p, aad, t) => `sealed:${p}:${aad}:${btoa(t)}`, open: async (_p, _a, s) => atob(s.split(":").pop()!) },
    dataKeyValid: (k) => k.length >= 43,
    audit: async (e) => void w.audits.push(e),
    rateLimit: async () => true,
    accessIdentity: async () => w.identity,
    cfFor: () => cf.transport(),
    provisioning: {
      startTeardown: async (id, reason) => void w.calls.push(`teardown ${id} ${reason}`),
      rotateTunnelSecret: async (id, o) => void w.calls.push(`rotate ${id} ${o.evict}`),
      reapplySessionDuration: async (d) => void w.calls.push(`session ${d}`),
      deriveUserSlug: (e) => e.split("@")[0]!.replace(/[^a-z0-9-]/g, "").slice(0, 24) || "user",
    },
    pairing: {
      listMachines: async (q) => ({ items: w.machines.filter((m) => !q.owner_user_id || q.owner_user_id === uid(m.owner_email)), next_cursor: null }),
      listDevices: async (q) => ({ items: w.devices.filter((d) => !q.owner_user_id || q.owner_user_id === uid(d.owner_email)), next_cursor: null }),
      getMachine: async (id) => w.machines.find((m) => m.id === id) ?? null,
      getDevice: async (id) => w.devices.find((d) => d.id === id) ?? null,
      unpairMachine: async (_u, id) => (w.calls.push(`unpair ${id}`), "started"),
      revokeDevice: async (id, o) => {
        w.calls.push(`revoke-device ${id} ${o.signOutEverywhere}`);
        const before = w.devices.length;
        w.devices = w.devices.filter((d) => d.id !== id);
        return before === w.devices.length ? "gone" : "revoked";
      },
      revokeAllDevices: async (u) => void w.calls.push(`revoke-all-devices ${u}`),
      revokeUserSessions: async (e) => void w.calls.push(`revoke-sessions ${e}`),
      phoneQrSvg: (url) => `<svg xmlns="http://www.w3.org/2000/svg" data-url="${url}"></svg>`,
    },
    fetch: async () => new Response("not stubbed", { status: 599 }),
    now: () => w.clock.now,
    newId: () => `id-${++n}`,
    workerVersion: "1.0.0",
  };
  return w;
}

/** Minimal stand-in for 04's router: matches `:param` paths and fills the context. */
export async function dispatch(rows: readonly RouteRow[], w: TestWorld, method: string, url: string, init: RequestInit & { identity?: RouteCtx["identity"] } = {}): Promise<Response> {
  const u = new URL(url);
  for (const row of rows) {
    if (row.method !== method) continue;
    const names: string[] = [];
    const re = new RegExp(`^${row.path.replace(/:[a-z_]+/g, (m) => (names.push(m.slice(1)), "([^/]+)"))}$`);
    const m = re.exec(u.pathname);
    if (!m) continue;
    const params = Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1]!)]));
    const request = new Request(url, { method, ...init });
    return row.handler({ request, url: u, params, identity: init.identity ?? null, deps: w.deps, requestId: "req-1" });
  }
  throw new Error(`no route for ${method} ${u.pathname}`);
}

export async function seedUser(w: TestWorld, email: string, role: "user" | "admin" = "user", status = "active"): Promise<string> {
  const id = uid(email);
  await w.db.prepare("INSERT INTO users (id, email, slug, role, status, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, email, email.split("@")[0], role, status, 1_760_000_000, 1_760_000_100).run();
  return id;
}
