/**
 * The Phase 06 test world: the real foundation over the test D1 database, with only
 * Cloudflare faked (05's fake API, served to the Worker's global `fetch` through msw).
 *
 * - `settings` and `internal` are plain objects a test edits; `harness.dispatch` (and
 *   `flush`) writes them to D1 before a request, so the Worker reads them as stored rows.
 * - `audit` mirrors the rows this world wrote to `audit_log`; `dispatch` and `refresh`
 *   reload it.
 * - Requests run through 04's real pipeline at the world's clock (`harness.ts`).
 *
 * <module-headers:begin>
 * Uses:
 * test/phase06/fakes.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/db/client.ts
 * ├── src/db/settings.ts
 * ├── src/http/context.ts
 * ├── src/log/logger.ts
 * ├── src/routes/call.ts
 * ├── src/routes/phase06-context.ts
 * ├── test/helpers/access.ts
 * ├── test/helpers/seed.ts
 * ├── test/provisioning/fake-cloudflare/index.ts
 * └── test/setup.ts
 * External: cloudflare:test, msw
 *
 * Used by:
 * test/phase06/fakes.ts
 * ├── test/devices/device-params.test.ts
 * ├── test/devices/devices-repo.test.ts
 * ├── test/devices/devices-route.test.ts
 * ├── test/machine-api/claim.test.ts
 * ├── test/machine-api/machine-routes.test.ts
 * ├── test/me/machines-route.test.ts
 * ├── test/me/me-route.test.ts
 * ├── test/me/meta.test.ts
 * ├── test/pairing/audit-coverage.test.ts
 * ├── test/pairing/authorize-route.test.ts
 * ├── test/pairing/pair-helpers.ts
 * ├── test/pairing/pair-requests.test.ts
 * ├── test/phase06/harness.ts
 * ├── test/sessions/handoff-helpers.ts
 * ├── test/sessions/handoff-remembered.test.ts
 * ├── test/sessions/handoff-route.test.ts
 * └── test/sessions/revoke-sessions.test.ts
 * <module-headers:end>
 */
import type { Settings } from "@yaran/protocol";
import { env } from "cloudflare:test";
import { http } from "msw";
import { all } from "../../src/db/client.ts";
import { setSetting } from "../../src/db/settings.ts";
import type { AppContext } from "../../src/http/context.ts";
import { createLogger } from "../../src/log/logger.ts";
import type { AuditRecord, OrgSettings, Phase06Ctx } from "../../src/routes/call.ts";
import { phase06Ctx } from "../../src/routes/phase06-context.ts";
import { serveJwks } from "../helpers/access.ts";
import { AUD, TEAM as SEED_TEAM } from "../helpers/seed.ts";
import { createFakeCloudflare, FAKE_BASE, type FakeCloudflare } from "../provisioning/fake-cloudflare/index.ts";
import { network } from "../setup.ts";

export const CP_HOST = "cp.example.com";
export const ZONE = "example.com";
export const TEAM = SEED_TEAM;
export const CP_AUD = AUD;
export const APP_CALLBACK = "https://yaran.example/auth/callback";
export const INSTANCE_ID = "0123abcd";

export function defaultSettings(): Settings {
  return {
    org_name: "Example Org",
    session_duration: "24h",
    pairing_policy: { mode: "everyone", emails: [], domains: [], access_group_ids: [] },
    machine_cap_per_user: 10,
    device_cap_per_user: 10,
    push: { enabled: true, detail: "names", ttl_seconds: 3600, relay_allowed: true, allowed_relays: [] },
    stale_machine_policy: { notify_after_days: 30, revoke_after_days: null },
    audit_retention_days: 365,
    quota_limits: { access_apps: 500, access_policies: 500, tunnels: 1000 },
    orphan_cleanup: "delete",
    deployer_repo_url: null,
  };
}

export interface TestWorld {
  ctx: Phase06Ctx;
  /** The audit rows this world wrote, oldest first (reloaded by `refresh`). */
  audit: AuditRecord[];
  settings: Settings;
  internal: OrgSettings;
  /** Mutable clock, Unix seconds. */
  clock: { now: number };
  /** The fake Cloudflare API: its state, call log and fault queue. */
  cf: FakeCloudflare;
  /** The Worker environment requests run with (a test may swap DATA_KEY). */
  env: Cloudflare.Env;
  /** Writes `settings` and `internal` to D1. */
  flush(): Promise<void>;
  /** Reloads `audit` from D1. */
  refresh(): Promise<void>;
}

interface AuditDbRow {
  actor_kind: AuditRecord["actor"]["kind"];
  actor_id: string | null;
  action: AuditRecord["action"];
  target_kind: AuditRecord["target"]["kind"] | null;
  target_id: string | null;
  outcome: AuditRecord["outcome"];
  error_code: AuditRecord["errorCode"] | null;
  detail: string | null;
}

const toRecord = (r: AuditDbRow): AuditRecord => ({
  action: r.action,
  actor: { kind: r.actor_kind, id: r.actor_id },
  target: { kind: r.target_kind ?? "org", id: r.target_id },
  outcome: r.outcome,
  ...(r.error_code ? { errorCode: r.error_code } : {}),
  ...(r.detail ? { detail: JSON.parse(r.detail) as Record<string, unknown> } : {}),
});

export async function makeWorld(o: { now?: number } = {}): Promise<TestWorld> {
  const db = env.DB;
  const clock = { now: o.now ?? 1_800_000_000 };
  const settings = defaultSettings();
  const internal: OrgSettings = {
    setupState: "closed",
    controlPlaneHost: CP_HOST,
    teamDomain: TEAM,
    zoneName: ZONE,
    accountId: "acc123",
    vapidPublicKey: "BKUlPUj77ORqEFSElVaFE7fgXBWgwRjy9OY7egX9DUHtzQG-K868ewmuQi5l0U_0bpE5nHtwv8k3E789D7IHcoQ",
  };
  // Worlds in one file share D1, so each fake mints ids from its own sequence.
  const cf = createFakeCloudflare({ randomIds: true });
  network.use(http.all(`${FAKE_BASE}/*`, async ({ request }) => {
    const body = request.method === "GET" || request.method === "DELETE" ? undefined : await request.text();
    return cf.fetch(request.url, { method: request.method, headers: request.headers, ...(body ? { body } : {}) });
  }));
  serveJwks();
  const baseline = (await all<{ n: number | null }>(db, "SELECT max(rowid) AS n FROM audit_log"))[0]?.n ?? 0;
  const workerEnv: Cloudflare.Env = { ...env, APP_CALLBACK_URLS: APP_CALLBACK };
  const app: AppContext = {
    env: workerEnv, db, log: createLogger(), now: () => clock.now, requestId: "req-test-1", ip: null, country: null,
    actor: () => ({ kind: "system" }), waitUntil: () => {},
  };
  const w: TestWorld = {
    ctx: phase06Ctx(app),
    audit: [],
    settings,
    internal,
    clock,
    cf,
    env: workerEnv,
    flush: async () => {
      const put = (k: Parameters<typeof setSetting>[1], v: unknown) => (v === null ? Promise.resolve() : setSetting(db, k, v as never, "test", 0));
      for (const [k, v] of Object.entries(w.settings)) await put(k as keyof Settings, v);
      await db.prepare("DELETE FROM settings WHERE key = 'vapid_public_key'").run();
      await Promise.all([
        put("setup_state", w.internal.setupState), put("control_plane_host", w.internal.controlPlaneHost),
        put("team_domain", w.internal.teamDomain), put("zone_name", w.internal.zoneName), put("account_id", w.internal.accountId),
        put("vapid_public_key", w.internal.vapidPublicKey), put("control_plane_aud", CP_AUD), put("instance_id", INSTANCE_ID),
        put("zone_id", "zone123"),
      ]);
    },
    refresh: async () => {
      w.audit = (await all<AuditDbRow>(db,
        "SELECT actor_kind, actor_id, action, target_kind, target_id, outcome, error_code, detail FROM audit_log WHERE rowid > ? ORDER BY rowid", baseline))
        .map(toRecord);
    },
  };
  await w.flush();
  return w;
}

export interface SeededUser {
  id: string;
  email: string;
  slug: string;
}

export async function seedUser(db: D1Database, email: string, o: { role?: "user" | "admin"; status?: "active" | "disabled" } = {}): Promise<SeededUser> {
  const id = crypto.randomUUID();
  const slug = email.split("@")[0]!.replace(/[^a-z0-9]+/g, "-").slice(0, 20);
  await db
    .prepare("INSERT INTO users (id, email, slug, role, status, created_at) VALUES (?, ?, ?, ?, ?, 0)")
    .bind(id, email, slug, o.role ?? "user", o.status ?? "active")
    .run();
  return { id, email, slug };
}

/** The Access application AUD a seeded machine carries. */
export function fakeAud(machineId: string): string {
  return `aud-${machineId.replace(/-/g, "")}`;
}

export async function seedMachine(
  db: D1Database,
  owner: SeededUser,
  o: { name?: string; status?: string; publicKey?: Uint8Array; cfStatus?: string | null; claimedAt?: number | null } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  const name = o.name ?? "laptop";
  const status = o.status ?? "active";
  const live = status !== "revoked";
  await db
    .prepare(
      `INSERT INTO machines (id, instance_id, owner_user_id, name, slug, hostname, public_key, status, tunnel_id,
         access_app_aud, access_app_id, cf_status, created_at, claimed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .bind(
      id, INSTANCE_ID, owner.id, name, name,
      live ? `${name}-${owner.slug}-${id.slice(0, 4)}.${ZONE}` : null,
      o.publicKey ?? crypto.getRandomValues(new Uint8Array(32)),
      status,
      live ? crypto.randomUUID() : null,
      fakeAud(id), `app-${id}`,
      o.cfStatus ?? null,
      o.claimedAt === undefined ? 1_700_000_000 : o.claimedAt,
    )
    .run();
  return id;
}

/** An unsigned Access-shaped token; `harness.dispatch` signs its claims with the test key. */
export function fakeJwt(claims: Record<string, unknown>): string {
  const b = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b({ alg: "RS256", kid: "k1" })}.${b(claims)}.c2ln`;
}

/** The machine's live AUD as provisioning recorded it. */
export async function machineAud(w: TestWorld, machineId: string): Promise<string | null> {
  return (await w.ctx.db.prepare("SELECT access_app_aud FROM machines WHERE id = ?").bind(machineId).first<{ access_app_aud: string | null }>())?.access_app_aud ?? null;
}

/** The provisioning ops 05 ran for a machine, oldest first. */
export async function opsOf(w: TestWorld, machineId: string): Promise<Array<{ kind: string; state: string; params: string }>> {
  return (await w.ctx.db.prepare("SELECT kind, state, params FROM provisioning_ops WHERE machine_id = ? ORDER BY created_at, rowid").bind(machineId)
    .all<{ kind: string; state: string; params: string }>()).results;
}

export async function machineRow(w: TestWorld, id: string): Promise<Record<string, unknown>> {
  return (await w.ctx.db.prepare("SELECT * FROM machines WHERE id = ?").bind(id).first<Record<string, unknown>>())!;
}
