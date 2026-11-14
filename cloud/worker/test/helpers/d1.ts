/**
 * A D1-shaped database over node:sqlite for the Phase 07 suites.
 *
 * Implements just the `D1Like` subset (prepare/bind/all/first/run/batch) on an in-memory
 * SQLite database seeded with the test copy of 04's schema, so the real SQL this phase
 * writes runs against real SQLite in Node.
 *
 * - `batch` runs inside one transaction, like D1's.
 *
 * <module-headers:begin>
 * Uses:
 * test/helpers/d1.ts
 * └── src/admin/ports.ts
 * External: node:fs, node:sqlite
 *
 * Used by:
 * test/helpers/d1.ts
 * ├── test/helpers/deps.ts
 * ├── test/setup-gate.test.ts
 * └── test/update-checker.test.ts
 * <module-headers:end>
 */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { D1Like, D1Stmt } from "../../src/admin/ports.ts";

type Value = string | number | null | bigint | Uint8Array;

class Stmt implements D1Stmt {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    private readonly values: Value[] = [],
  ) {}
  bind(...values: unknown[]): D1Stmt {
    return new Stmt(this.db, this.sql, values.map((v) => (typeof v === "boolean" ? Number(v) : (v ?? null)) as Value));
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...this.values) as T[] };
  }
  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.values) as T | undefined) ?? null;
  }
  async run(): Promise<{ meta: { changes: number } }> {
    return { meta: { changes: Number(this.db.prepare(this.sql).run(...this.values).changes) } };
  }
}

export function testDb(): D1Like & { raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  raw.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  return {
    raw,
    prepare: (sql) => new Stmt(raw, sql),
    async batch(statements) {
      raw.exec("BEGIN");
      try {
        const out = [];
        for (const s of statements) out.push(await s.run());
        raw.exec("COMMIT");
        return out;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
  };
}
