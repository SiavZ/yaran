/**
 * The Phase 07 test world: the real `Phase07Deps` over the test D1 database, with only
 * Cloudflare faked. 07's setup fake answers the wizard's endpoints and hands everything
 * else (tunnels, DNS, session revocation) to 05's fake, both served to the Worker's global
 * `fetch` through msw.
 *
 * - `audits` records what 07's own code audited through `deps.audit` (a spy over 04's
 *   real writer); `dispatch` runs a request through 04's real pipeline at the world's clock.
 * - A request for a signed-in identity carries an Access JWT minted for the org's team
 *   domain and control-plane AUD as stored in D1.
 *
 * <module-headers:begin>
 * Uses:
 * test/helpers/deps.ts
 * ├── src/admin/ports.ts
 * ├── src/admin/settings-store.ts
 * ├── src/admin/setup-settings.ts
 * ├── src/cloudflare/errors.ts
 * ├── src/console/route-types.ts
 * ├── src/db/settings.ts
 * ├── src/http/context.ts
 * ├── src/http/routes.ts
 * ├── src/log/logger.ts
 * ├── src/routes/phase07-context.ts
 * ├── test/helpers/access.ts
 * ├── test/helpers/fake-cf.ts
 * ├── test/helpers/seed.ts
 * ├── test/helpers/worker.ts
 * ├── test/provisioning/fake-cloudflare/index.ts
 * └── test/setup.ts
 * External: cloudflare:test, msw
 *
 * Used by:
 * test/helpers/deps.ts
 * ├── test/admin-services.test.ts
 * ├── test/console.test.ts
 * ├── test/setup-flow.test.ts
 * ├── test/setup-gate.test.ts
 * ├── test/setup-steps.test.ts
 * └── test/update-checker.test.ts
 * <module-headers:end>
 */
import { env } from "cloudflare:test";
import { http, HttpResponse } from "msw";
import type { AuditInput, Identity } from "../../src/admin/ports.ts";
import { API_TOKEN_AAD, API_TOKEN_KEY } from "../../src/admin/setup-settings.ts";
import { writeKeys } from "../../src/admin/settings-store.ts";
import { CfApiError } from "../../src/cloudflare/errors.ts";
import type { Phase07Deps, RouteRow } from "../../src/console/route-types.ts";
import { getSettings } from "../../src/db/settings.ts";
import type { AppContext } from "../../src/http/context.ts";
import { ROUTES } from "../../src/http/routes.ts";
import { createLogger } from "../../src/log/logger.ts";
import { phase07Deps } from "../../src/routes/phase07-context.ts";
import { createFakeCloudflare, FAKE_BASE, type FakeCloudflare as ProvisioningFake } from "../provisioning/fake-cloudflare/index.ts";
import { network } from "../setup.ts";
import { mintJwt, serveJwks } from "./access.ts";
import { AUD, TEAM } from "./seed.ts";
import { FakeCloudflare } from "./fake-cf.ts";
import { handler } from "./worker.ts";

export const SETUP_CODE = "correct-horse-battery-staple-xyz";
export const CP_HOST = "cp.example.org";

export interface TestWorld {
  deps: Phase07Deps;
  /** 07's setup fake (accounts, zones, Access org, apps, policies, IdPs, Worker domains). */
  cf: FakeCloudflare;
  /** 05's fake, for what provisioning reaches (tunnels, DNS, session revocation). */
  prov: ProvisioningFake;
  audits: AuditInput[];
  /** Signs every dispatched request in as this identity unless the request names one. */
  identity: { email: string; sub: string } | null;
  clock: { now: Date };
  db: D1Database;
  /** The environment requests run with; a test may break a secret. */
  env: Cloudflare.Env;
}

const KNOWN: Record<string, string> = { "ada@example.org": "00000000-0000-4000-8000-0000000000a1", "bob@example.org": "00000000-0000-4000-8000-0000000000b2" };
/** A stable UUID per test email. */
export function uid(email: string): string {
  return KNOWN[email] ?? "00000000-0000-4000-8000-0000000000ff";
}

export const MACHINE_ID = "00000000-0000-4000-8000-000000000101";
export const DEVICE_ID = "00000000-0000-4000-8000-000000000201";

/** 07's fake as HTTP: a fake error becomes its status, an unknown path goes to 05's fake. */
function serve(w: TestWorld): void {
  network.use(http.all(`${FAKE_BASE}/*`, async ({ request }) => {
    const path = new URL(request.url).pathname.replace(new URL(FAKE_BASE).pathname, "") + new URL(request.url).search;
    const text = request.method === "GET" || request.method === "DELETE" ? "" : await request.text();
    try {
      const result = await w.cf.handle(request.method, path, text ? JSON.parse(text) : undefined);
      return HttpResponse.json({ success: true, errors: [], messages: [], result });
    } catch (e) {
      if (e instanceof CfApiError) return HttpResponse.json({ success: false, errors: [{ code: 10000, message: e.message }], messages: [], result: null }, { status: e.status ?? 400 });
      if (!(e instanceof Error) || !e.message.startsWith("fake Cloudflare has no route")) throw e;
      return w.prov.fetch(request.url, { method: request.method, headers: request.headers, ...(text ? { body: text } : {}) });
    }
  }));
}

/** Child tables first: D1 enforces foreign keys. */
const TABLES = ["device_machine_mutes", "devices", "provisioning_ops", "handoff_csrf", "pair_requests", "machine_nonces", "machines", "users",
  "settings", "audit_log", "rate_counters", "scheduled_tasks", "cf_orphans", "cf_api_budget"];

/** Empties every table (storage is shared by the tests of one file). */
export async function wipe(): Promise<void> {
  await env.DB.batch(TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
}

/** A fresh world on an empty database. */
export async function world(): Promise<TestWorld> {
  await wipe();
  const clock = { now: new Date("2026-11-14T12:00:00Z") };
  const workerEnv: Cloudflare.Env = { ...env, SETUP_CODE };
  const app: AppContext = {
    env: workerEnv, db: env.DB, log: createLogger(), now: () => Math.floor(clock.now.getTime() / 1000), requestId: "req-1",
    ip: null, country: null, actor: () => ({ kind: "system" }), waitUntil: () => {},
  };
  const w: TestWorld = {
    deps: phase07Deps(app),
    cf: new FakeCloudflare(),
    prov: createFakeCloudflare({ randomIds: true }),
    audits: [],
    identity: null,
    clock,
    db: env.DB,
    env: workerEnv,
  };
  const audit = w.deps.audit;
  w.deps.audit = async (e) => {
    await audit(e);
    w.audits.push(e);
  };
  serve(w);
  return w;
}

/** The org as a finished setup leaves it, on `cp.example.org`, with a sealed API token. */
export async function closedOrg(w: TestWorld): Promise<void> {
  await writeKeys(w.db, {
    setup_state: "closed", control_plane_host: CP_HOST, team_domain: TEAM, control_plane_aud: AUD,
    account_id: "acc1", zone_id: "z1", zone_name: "example.org", instance_id: "0123abcd",
    [API_TOKEN_KEY]: await w.deps.sealer.seal("cf_api_token", API_TOKEN_AAD, "cf-token"),
  }, "test", w.clock.now);
}

/** Runs one request through 04's pipeline and the production route table (`rows` is documentation). */
export async function dispatch(_rows: readonly RouteRow[], w: TestWorld, method: string, url: string, init: RequestInit & { identity?: Identity } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const who = init.identity ? { email: init.identity.email, sub: init.identity.user_id } : w.identity;
  if (who) {
    const s = await getSettings(w.db, ["team_domain", "control_plane_aud"]);
    serveJwks(s.team_domain ?? TEAM);
    headers.set("Cf-Access-Jwt-Assertion", await mintJwt({
      email: who.email, sub: who.sub, aud: s.control_plane_aud ?? AUD, iss: `https://${s.team_domain ?? TEAM}`,
      nbf: Math.floor(w.clock.now.getTime() / 1000) - 10, exp: Math.floor(w.clock.now.getTime() / 1000) + 3600,
    }));
  }
  if (!headers.has("Yaran-Protocol")) headers.set("Yaran-Protocol", "1");
  if (!headers.has("CF-Connecting-IP")) headers.set("CF-Connecting-IP", `203.0.113.${Math.floor(Math.random() * 250) + 1}`);
  const request = new Request(url, { ...init, method, headers, redirect: "manual" });
  return handler({ now: () => Math.floor(w.clock.now.getTime() / 1000) }, ROUTES)(request, w.env);
}

export async function seedUser(w: TestWorld, email: string, role: "user" | "admin" = "user", status = "active"): Promise<string> {
  const id = uid(email);
  await w.db.prepare("INSERT INTO users (id, email, slug, role, status, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, email, email.split("@")[0], role, status, 1_760_000_000, 1_760_000_100).run();
  return id;
}

/** Ada's provisioned laptop on port 8080; returns its public key. */
export async function seedMachine(w: TestWorld, owner = "ada@example.org"): Promise<Uint8Array> {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const tunnelId = crypto.randomUUID();
  // The tunnel exists in 05's fake, so a rotation of it succeeds.
  w.prov.state.tunnels.set(tunnelId, {
    id: tunnelId, name: `yaran-0123abcd-${MACHINE_ID}`, secret: "s", connectors: 1, rogue: false, status: "healthy", deleted_at: null,
    config: null, configVersion: 1, conns_active_at: null,
  });
  await w.db.prepare(
    `INSERT INTO machines (id, instance_id, owner_user_id, name, slug, hostname, public_key, origin_port, status, access_app_id, access_app_aud,
       tunnel_id, cf_status, cf_status_at, created_at, claimed_at, last_seen_at)
     VALUES (?, '0123abcd', ?, 'laptop', 'laptop', 'laptop-ada.example.org', ?, 8080, 'active', 'app-x', ?, ?, 'healthy', ?, 1761990000, 1761990000, ?)`,
  ).bind(MACHINE_ID, uid(owner), key, "b".repeat(64), tunnelId, Math.floor(w.clock.now.getTime() / 1000), Math.floor(w.clock.now.getTime() / 1000)).run();
  return key;
}

/** Ada's Pixel, whose push subscription expired (`push_state` gone). */
export async function seedDevice(w: TestWorld, owner = "ada@example.org"): Promise<void> {
  await w.db.prepare(
    `INSERT INTO devices (id, user_id, install_id, platform, flavor, form_factor, push_kind, device_key, device_key_fingerprint, app_version, label, created_at, last_seen_at, push_state)
     VALUES (?, ?, '9b8a7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d', 'android', 'foss', 'phone', 'unifiedpush', ?, 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF', '1.0.0', 'Pixel', 1761990000, 1763121600, 'gone')`,
  ).bind(DEVICE_ID, uid(owner), new Uint8Array(65)).run();
}
