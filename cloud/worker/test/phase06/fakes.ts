/**
 * Test fakes for the seams Phase 06 consumes from 04, 05 and 07: an audit log, a
 * rate limiter, a data-key sealer, settings, a provisioning facade and a Cloudflare
 * client, assembled into a `Phase06Ctx` over the real test D1 database.
 *
 * - The fake 05 mutates the `machines` row the way 05's saga is documented to (P0 sets
 *   the hostname (with a suffix, as 05 does when a live row holds the plain one), P6 moves to awaiting_claim, teardown moves to revoking), so route code
 *   sees realistic state.
 * - The consent MAC key is 02's real derivation over the fixture DATA_KEY.
 *
 * <module-headers:begin>
 * Uses:
 * test/phase06/fakes.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/seams/console.ts
 * ├── src/seams/context.ts
 * ├── src/seams/foundation.ts
 * └── src/seams/provisioning.ts
 * External: cloudflare:workers
 *
 * Used by:
 * test/phase06/fakes.ts
 * ├── test/devices/device-params.test.ts
 * ├── test/devices/devices-repo.test.ts
 * ├── test/devices/devices-route.test.ts
 * ├── test/machine-api/claim.test.ts
 * ├── test/me/machines-route.test.ts
 * ├── test/me/me-route.test.ts
 * ├── test/me/meta.test.ts
 * ├── test/pairing/audit-coverage.test.ts
 * ├── test/pairing/authorize-route.test.ts
 * ├── test/pairing/pair-helpers.ts
 * ├── test/phase06/harness.ts
 * ├── test/sessions/handoff-helpers.ts
 * ├── test/sessions/handoff-remembered.test.ts
 * ├── test/sessions/handoff-route.test.ts
 * └── test/sessions/revoke-sessions.test.ts
 * <module-headers:end>
 */
import { b64urlDecode, workerConsentKey, type Settings, type TunnelCredentials } from "@yaran/protocol";
import { env } from "cloudflare:workers";
import type { InternalSettings } from "../../src/seams/console.ts";
import type { Phase06Ctx } from "../../src/seams/context.ts";
import { ApiError, type AuditRecord, type SealPurpose } from "../../src/seams/foundation.ts";
import type { OpView, RevokeReason } from "../../src/seams/provisioning.ts";

export const CP_HOST = "cp.example.com";
export const ZONE = "example.com";
export const TEAM = "acme.cloudflareaccess.com";
export const APP_CALLBACK = "https://yaran.example/auth/callback";

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

export interface FakeProvisioning {
  calls: { fn: string; args: unknown[] }[];
  /** What the next driveOp answers; default is a completed provision. */
  nextDrive: OpView;
  /** Make setOriginPort refuse as if another op were live. */
  originBusy: boolean;
}

export interface TestWorld {
  ctx: Phase06Ctx;
  audit: AuditRecord[];
  prov: FakeProvisioning;
  settings: Settings;
  internal: InternalSettings;
  /** Mutable clock, Unix seconds. */
  clock: { now: number };
  /** Mutable consent key version (bumped to simulate a DATA_KEY rotation). */
  keyState: { kv: number };
  cfCalls: { method: string; path: string; body?: unknown }[];
  cfFail: { next: boolean };
}

const PREFIX = "k1.";

export async function makeWorld(o: { now?: number } = {}): Promise<TestWorld> {
  const db = env.DB;
  const audit: AuditRecord[] = [];
  const clock = { now: o.now ?? 1_800_000_000 };
  const keyState = { kv: 1 };
  const consentKey = await workerConsentKey(b64urlDecode(env.DATA_KEY.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""))!);
  const settings = defaultSettings();
  const internal: InternalSettings = {
    setupState: "closed",
    controlPlaneHost: CP_HOST,
    teamDomain: TEAM,
    zoneName: ZONE,
    accountId: "acc123",
    vapidPublicKey: "BKUlPUj77ORqEFSElVaFE7fgXBWgwRjy9OY7egX9DUHtzQG-K868ewmuQi5l0U_0bpE5nHtwv8k3E789D7IHcoQ",
  };
  const prov: FakeProvisioning = { calls: [], nextDrive: { state: "complete", errorCode: null }, originBusy: false };
  const counters = new Map<string, number>();
  const cfCalls: TestWorld["cfCalls"] = [];
  const cfFail = { next: false };
  const creds = async (id: string): Promise<TunnelCredentials> => {
    const row = await db.prepare("SELECT tunnel_id, tunnel_secret_generation FROM machines WHERE id = ?").bind(id).first<{ tunnel_id: string; tunnel_secret_generation: number }>();
    return { id: row!.tunnel_id, token: `tunnel-token-${id}-${row!.tunnel_secret_generation}`, token_version: row!.tunnel_secret_generation };
  };

  const ctx: Phase06Ctx = {
    db,
    now: () => clock.now,
    requestId: "req-test-1",
    audit: { record: async (r) => void audit.push(r) },
    rateLimit: async (bucket, key) => {
      const k = `${bucket}:${key}`;
      const n = (counters.get(k) ?? 0) + 1;
      counters.set(k, n);
      const max = bucket === "handoff" ? 20 : 10;
      return n > max ? { ok: false, retryAfterS: 60 } : { ok: true };
    },
    dataKey: {
      seal: async (purpose: SealPurpose, aad: string, plaintext: string) => PREFIX + btoa(`${purpose}|${aad}|${plaintext}`),
      open: async (purpose: SealPurpose, aad: string, sealed: string) => {
        const [p, a, ...rest] = atob(sealed.slice(PREFIX.length)).split("|");
        if (p !== purpose || a !== aad) throw new Error("open failed: wrong purpose or aad");
        return rest.join("|");
      },
      macKey: async () => ({ kv: keyState.kv, key: consentKey }),
    },
    provisioning: {
      startProvision: async (machineId) => {
        prov.calls.push({ fn: "startProvision", args: [machineId] });
        return { opId: `op-${machineId}` };
      },
      driveOp: async (opId, budget) => {
        prov.calls.push({ fn: "driveOp", args: [opId, budget] });
        const id = opId.slice(3);
        if (prov.nextDrive.state === "complete") {
          const m = await db.prepare("SELECT m.slug, u.slug AS us FROM machines m JOIN users u ON u.id = m.owner_user_id WHERE m.id = ?").bind(id).first<{ slug: string; us: string }>();
          await db
            .prepare("UPDATE machines SET status = 'awaiting_claim', hostname = ?, tunnel_id = ?, access_app_aud = ?, access_app_id = ? WHERE id = ? AND status = 'provisioning'")
            .bind(`${m!.slug}-${m!.us}-${id.slice(0, 4)}.${ZONE}`, crypto.randomUUID(), fakeAud(id), `app-${id}`, id)
            .run();
        }
        return prov.nextDrive;
      },
      startTeardown: async (machineId, reason: RevokeReason) => {
        prov.calls.push({ fn: "startTeardown", args: [machineId, reason] });
        await db.prepare("UPDATE machines SET status = 'revoking', revoke_reason = ? WHERE id = ? AND status NOT IN ('revoking','revoked')").bind(reason, machineId).run();
        return { opId: `op-t-${machineId}` };
      },
      rotateTunnelSecret: async (machineId, opts) => {
        prov.calls.push({ fn: "rotateTunnelSecret", args: [machineId, opts] });
        await db.prepare("UPDATE machines SET tunnel_secret_generation = tunnel_secret_generation + 1 WHERE id = ?").bind(machineId).run();
        return creds(machineId);
      },
      fetchTunnelToken: async (machineId) => {
        prov.calls.push({ fn: "fetchTunnelToken", args: [machineId] });
        return creds(machineId);
      },
      setOriginPort: async (machineId, port) => {
        prov.calls.push({ fn: "setOriginPort", args: [machineId, port] });
        if (prov.originBusy) throw new ApiError("provisioning_in_progress", "Another provisioning step is running for this machine.");
        const r = await db.prepare("UPDATE machines SET origin_port = ? WHERE id = ? AND origin_port <> ?").bind(port, machineId, port).run();
        return { changed: r.meta.changes > 0, op: null };
      },
    },
    cloudflare: {
      call: async <T>(req: { method: string; path: string; body?: unknown }) => {
        cfCalls.push(req);
        if (cfFail.next) throw new ApiError("cloudflare_permission_denied", "The API token lacks Access: Organizations write.");
        return { success: true } as T;
      },
    },
    settings: { read: async () => settings, internal: async () => internal },
    env: { APP_CALLBACK_URLS: APP_CALLBACK, WORKER_VERSION: "1.0.0" },
  };
  return { ctx, audit, prov, settings, internal, clock, keyState, cfCalls, cfFail };
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

/** Inserts a machine row in the given lifecycle state (05 columns filled for active ones). */
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
       VALUES (?, 'inst0001', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .bind(
      id, owner.id, name, name,
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

/** A schema-valid Access AUD (64 hex) derived from a machine id. */
export const fakeAud = (id: string) => id.replace(/-/g, "").repeat(2);

/** An unsigned JWT-shaped string; the fake requireUser decodes it without verifying. */
export function fakeJwt(claims: Record<string, unknown>): string {
  const b = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b({ alg: "RS256", kid: "k1" })}.${b(claims)}.c2ln`;
}
