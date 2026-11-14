/**
 * Each purge task deletes only expired rows.
 *
 * <module-headers:begin>
 * Uses:
 * test/purge.test.ts
 * ├── src/db/client.ts
 * ├── src/db/settings.ts
 * ├── src/scheduled/purge.ts
 * ├── src/scheduled/tasks.ts
 * ├── test/helpers/app.ts
 * └── test/helpers/seed.ts
 * External: cloudflare:test, vitest
 *
 * Used by: entry point (vitest inside workerd, via npm test in cloud/worker)
 * <module-headers:end>
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, run } from "../src/db/client.ts";
import { setSetting } from "../src/db/settings.ts";
import { PURGE_TASKS } from "../src/scheduled/purge.ts";
import type { TaskContext } from "../src/scheduled/tasks.ts";
import { appCtx } from "./helpers/app.ts";
import { NOW, seedUser } from "./helpers/seed.ts";

const runTask = (name: string) => PURGE_TASKS.find((t) => t.name === name)!.run({ ...appCtx(), cursor: null, deadlineMs: Date.now() + 1000 } as TaskContext);
const count = async (sql: string) => (await all(env.DB, sql)).length;

describe("purges", () => {
  it("purge_nonces deletes expired nonces only", async () => {
    await run(env.DB, "INSERT INTO machine_nonces (machine_id, nonce, expires_at) VALUES ('m', 'old', ?), ('m', 'new', ?)", NOW - 1, NOW + 600);
    await runTask("purge_nonces");
    expect(await all(env.DB, "SELECT nonce FROM machine_nonces")).toEqual([{ nonce: "new" }]);
  });
  it("purge_pair_requests deletes requests expired over a day ago", async () => {
    const u = await seedUser();
    const ins = (id: string, expires: number) => run(env.DB,
      "INSERT INTO pair_requests (id, user_id, state_hash, code_challenge, machine_public_key, machine_name, callback_port, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, 'm', 4000, 'expired', ?, ?)",
      id, u.id, new Uint8Array(32), "c".repeat(43), new Uint8Array(32), expires - 600, expires);
    await ins("old", NOW - 86_401);
    await ins("recent", NOW - 10);
    await runTask("purge_pair_requests");
    expect(await all(env.DB, "SELECT id FROM pair_requests")).toEqual([{ id: "recent" }]);
  });
  it("purge_audit honours audit_retention_days", async () => {
    await setSetting(env.DB, "audit_retention_days", 30, null, NOW);
    await run(env.DB, "INSERT INTO audit_log (id, at, actor_kind, action, outcome) VALUES (?, ?, 'system', 'drift.repaired', 'ok'), (?, ?, 'system', 'drift.repaired', 'ok')",
      crypto.randomUUID(), NOW - 31 * 86_400, crypto.randomUUID(), NOW - 29 * 86_400);
    await runTask("purge_audit");
    expect(await count("SELECT 1 FROM audit_log")).toBe(1);
  });
  it("purge_rate_counters drops old windows and keeps setup locks", async () => {
    await run(env.DB, "INSERT INTO rate_counters (key, window_start, count) VALUES ('rl:ip:a', ?, 1), ('rl:ip:b', ?, 1), ('setup:lock:x', 0, 1)", NOW - 3 * 86_400, NOW - 60);
    await runTask("purge_rate_counters");
    expect(await all(env.DB, "SELECT key FROM rate_counters ORDER BY key")).toEqual([{ key: "rl:ip:b" }, { key: "setup:lock:x" }]);
  });
});
