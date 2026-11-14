/**
 * The G11 fallback runtime migrator: an empty database is migrated, a concurrent run
 * waits on the lease, a wrangler-migrated database is left alone, and a failing statement
 * records nothing and surfaces as 503 through the entry point.
 *
 * <module-headers:begin>
 * Uses:
 * test/migrate-runtime.test.ts
 * ├── src/db/client.ts
 * ├── src/db/migrate-runtime.ts
 * ├── src/index.ts
 * └── src/log/logger.ts
 * External: cloudflare:test, vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { createExecutionContext, env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, run } from "../src/db/client.ts";
import { migrate, MIGRATIONS, splitSql } from "../src/db/migrate-runtime.ts";
import worker from "../src/index.ts";
import { createLogger } from "../src/log/logger.ts";

const log = createLogger();
const now = () => 1_800_000_000;
const tables = async () => (await all<{ name: string }>(env.DB,
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name")).map((r) => r.name);

async function dropEverything(): Promise<void> {
  await run(env.DB, "PRAGMA foreign_keys = OFF");
  for (const t of await tables()) await run(env.DB, `DROP TABLE IF EXISTS "${t}"`);
  await run(env.DB, "PRAGMA foreign_keys = ON");
}

describe("runtime migrator", () => {
  it("bundles exactly the migration files wrangler applies", () => {
    expect(MIGRATIONS.map((m) => m.name)).toEqual(env.TEST_MIGRATIONS.map((m) => m.name));
    expect(MIGRATIONS.map((m) => splitSql(m.sql))).toEqual(env.TEST_MIGRATIONS.map((m) => m.queries.map((q) => splitSql(q)[0])));
  });
  it("splits SQL without tripping on comments or quoted semicolons", () => {
    expect(splitSql("-- a; b\nCREATE TABLE t (x TEXT DEFAULT ';'); -- c\nSELECT 1;")).toEqual(["CREATE TABLE t (x TEXT DEFAULT ';')", "SELECT 1"]);
  });
  it("leaves a wrangler-migrated database unchanged", async () => {
    expect(await migrate(env.DB, log, now)).toEqual([]);
  });
  it("migrates an empty database once, even with two concurrent runs", async () => {
    await dropEverything();
    const results = await Promise.all([migrate(env.DB, log, now, MIGRATIONS, 20), migrate(env.DB, log, now, MIGRATIONS, 20)]);
    expect(results.flat()).toEqual(["0001_init.sql"]);
    expect(await tables()).toEqual(expect.arrayContaining(["users", "machines", "audit_log", "schema_migrations"]));
    expect(await all(env.DB, "SELECT version FROM schema_migrations")).toEqual([{ version: "0001_init.sql" }]);
  });
  it("records nothing when a statement fails", async () => {
    const bad = [...MIGRATIONS, { name: "0002_bad.sql", sql: "CREATE TABLE ok_table (x INTEGER); CREATE TABLE broken (" }];
    await expect(migrate(env.DB, log, now, bad)).rejects.toThrow();
    expect(await all(env.DB, "SELECT version FROM schema_migrations WHERE version = '0002_bad.sql' OR version = '~lease'")).toEqual([]);
    expect(await tables()).not.toContain("ok_table");
  });
  it("answers 503 unavailable through the entry point while migrating fails", async () => {
    const broken = { prepare: () => { throw new Error("d1 down"); } } as unknown as D1Database;
    const res = await worker.fetch(new Request("https://cp.example.com/v1/meta"), { ...env, DB: broken }, createExecutionContext());
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unavailable");
    expect(res.headers.get("Retry-After")).not.toBeNull();
  });
  it("serves through the entry point once migrated", async () => {
    const res = await SELF.fetch("https://cp.example.com/v1/meta");
    expect(res.headers.get("Yaran-Request-Id")).toBeTruthy();
    expect(res.status).toBe(404);
  });
});
