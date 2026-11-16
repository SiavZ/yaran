/**
 * A test world: fake D1, fake Cloudflare, a controllable clock and a `ProvCtx` wired to them,
 * plus seeders for settings, users and machines.
 *
 * - The audit port writes real `audit_log` rows (so the "no token in D1" scan covers them)
 *   and keeps them in memory for assertions.
 * - `sanitize` stands in for 04's: it escapes C0/C1 controls the way `for_terminal` does.
 *
 * <module-headers:begin>
 * Uses:
 * test/provisioning/helpers/world.ts
 * ├── src/cloudflare/budget.ts
 * ├── src/cloudflare/client.ts
 * ├── src/provisioning/ports.ts
 * ├── test/provisioning/fake-cloudflare/index.ts
 * └── test/provisioning/helpers/d1.ts
 * External: none
 *
 * Used by:
 * test/provisioning/helpers/world.ts
 * ├── test/provisioning/client.test.ts
 * ├── test/provisioning/crash-matrix.test.ts
 * ├── test/provisioning/drift.test.ts
 * ├── test/provisioning/endpoints.test.ts
 * ├── test/provisioning/errors.test.ts
 * ├── test/provisioning/fixture-contract.test.ts
 * ├── test/provisioning/ops-store.test.ts
 * ├── test/provisioning/origin-port.test.ts
 * ├── test/provisioning/orphans.test.ts
 * ├── test/provisioning/provision.test.ts
 * ├── test/provisioning/quota.test.ts
 * ├── test/provisioning/registry.test.ts
 * ├── test/provisioning/rotate.test.ts
 * ├── test/provisioning/setup.ts
 * ├── test/provisioning/status.test.ts
 * ├── test/provisioning/tasks.test.ts
 * └── test/provisioning/teardown.test.ts
 * <module-headers:end>
 */
import { ApiBudget } from "../../../src/cloudflare/budget.ts";
import { CfClient } from "../../../src/cloudflare/client.ts";
import type { AuditEvent, ProvCtx } from "../../../src/provisioning/ports.ts";
import { createFakeCloudflare, FAKE_BASE, type FakeCloudflare } from "../fake-cloudflare/index.ts";
import { FakeD1 } from "./d1.ts";

export const INST = "a1b2c3d4";
export const OTHER_INST = "ffff0000";
export const TOKEN = "SENTINEL-CF-API-TOKEN-0123456789";

export interface World {
  db: FakeD1;
  cf: FakeCloudflare;
  ctx: ProvCtx;
  clock: { now: number };
  audits: AuditEvent[];
  logs: Array<{ level: string; event: string; fields?: Record<string, unknown> }>;
  /** Rebuilds the client (a new invocation: fresh budget and call counter). */
  fresh: () => ProvCtx;
}

export function sanitize(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => `\\u{${c.charCodeAt(0).toString(16)}}`);
}

export const DEFAULT_SETTINGS: Record<string, unknown> = {
  instance_id: INST,
  account_id: "acct-1",
  zone_id: "zone-1",
  zone_name: "example.com",
  control_plane_host: "yaran.example.com",
  team_domain: "acme.cloudflareaccess.com",
};

/** Every world made in the current test; the setup file scans each for secrets afterwards. */
const worlds: World[] = [];

export function drainWorlds(): World[] {
  return worlds.splice(0);
}

export function makeWorld(opts: { tokenInResponse?: boolean; settings?: Record<string, unknown> } = {}): World {
  const db = new FakeD1();
  const cf = createFakeCloudflare(opts.tokenInResponse === undefined ? {} : { tokenInResponse: opts.tokenInResponse });
  cf.onCrash = () => db.failNextBatch();
  const clock = { now: 1_800_000_000 };
  const audits: AuditEvent[] = [];
  const logs: World["logs"] = [];
  for (const [k, v] of Object.entries({ ...DEFAULT_SETTINGS, ...opts.settings })) {
    db.sqlite.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, 0)").run(k, JSON.stringify(v));
  }
  const build = (): ProvCtx => {
    const now = () => clock.now;
    return {
      db,
      cf: new CfClient({
        fetch: cf.fetch,
        token: TOKEN,
        baseUrl: FAKE_BASE,
        budget: new ApiBudget(db, now),
        userAgent: "yaran-cloud/test",
        sleep: async () => {},
        random: () => 0,
      }),
      audit: async (e) => {
        audits.push(e);
        db.sqlite
          .prepare("INSERT INTO audit_log (id, at, actor_kind, action, target_kind, target_id, outcome, error_code, detail) VALUES (?, ?, 'system', ?, ?, ?, ?, ?, ?)")
          .run(crypto.randomUUID(), clock.now, e.action, e.target.kind, e.target.id, e.outcome, e.error_code ?? null, JSON.stringify(e.detail ?? {}).slice(0, 2048));
      },
      log: {
        info: (event, fields) => void logs.push({ level: "info", event, ...(fields ? { fields } : {}) }),
        warn: (event, fields) => void logs.push({ level: "warn", event, ...(fields ? { fields } : {}) }),
        error: (event, fields) => void logs.push({ level: "error", event, ...(fields ? { fields } : {}) }),
      },
      sanitize,
      settings: {
        getMany: async (keys) => {
          const out: Record<string, unknown> = {};
          for (const k of keys) {
            const row = db.sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(k) as { value: string } | undefined;
            if (row) out[k] = JSON.parse(row.value);
          }
          return out;
        },
      },
      actor: { kind: "system", id: null },
      now,
      sleep: async () => {},
      appCallbackUrls: ["https://app.example.org/cb"],
    };
  };
  const world: World = { db, cf, clock, audits, logs, ctx: build(), fresh: () => (world.ctx = build()) };
  worlds.push(world);
  return world;
}

export function setSetting(w: World, key: string, value: unknown): void {
  w.db.sqlite.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, 0)").run(key, JSON.stringify(value));
}

let userSeq = 0;

export function seedUser(w: World, email = `alice${++userSeq}@example.org`, slug?: string): string {
  const id = crypto.randomUUID();
  w.db.sqlite.prepare("INSERT INTO users (id, email, slug, created_at) VALUES (?, ?, ?, 0)").run(id, email, slug ?? email.split("@")[0]!.replace(/[^a-z0-9-]/g, "-"));
  return id;
}

export interface SeedMachine {
  userId?: string;
  name?: string;
  status?: string;
  originPort?: number;
}

export function seedMachine(w: World, o: SeedMachine = {}): string {
  const id = crypto.randomUUID();
  const userId = o.userId ?? seedUser(w);
  const name = o.name ?? "laptop";
  w.db.sqlite
    .prepare("INSERT INTO machines (id, instance_id, owner_user_id, name, slug, public_key, origin_port, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)")
    .run(id, INST, userId, name, name, new Uint8Array(32), o.originPort ?? 3890, o.status ?? "provisioning");
  return id;
}

export function machine(w: World, id: string): Record<string, unknown> {
  return w.db.sqlite.prepare("SELECT * FROM machines WHERE id = ?").get(id) as Record<string, unknown>;
}

export function ops(w: World, machineId: string): Array<Record<string, unknown>> {
  return w.db.sqlite.prepare("SELECT * FROM provisioning_ops WHERE machine_id = ? ORDER BY created_at, rowid").all(machineId) as Array<Record<string, unknown>>;
}

/** Asserts no API token, tunnel token or tunnel secret appears anywhere in D1. */
export function expectNoSecretsInD1(w: World): void {
  const text = w.db.allText();
  const secrets = [TOKEN, ...w.cf.state.issued, ...[...w.cf.state.tunnels.values()].map((t) => t.secret)];
  for (const s of secrets) if (text.includes(s)) throw new Error(`secret found in D1: ${s.slice(0, 12)}…`);
}

/** The call log as `METHOD path` lines, queries dropped. */
export function callLines(w: World): string[] {
  return w.cf.calls.map((c) => `${c.method} ${c.path}`);
}
