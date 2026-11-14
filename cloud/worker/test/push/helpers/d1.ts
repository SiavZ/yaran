/**
 * An in-memory D1 stand-in over node:sqlite: prepare/bind/first/all/run and an atomic
 * batch, the subset of `D1Database` the push module uses (seams.ts D1Like).
 *
 * - Booleans bind as 0/1 and undefined as NULL, as D1 does; BLOBs come back as Uint8Array.
 * - `migrated()` loads 04's planned tables (base_schema_04.sql) and, unless told otherwise,
 *   this phase's migrations/0008_push.sql.
 *
 * <module-headers:begin>
 * Uses:
 * helpers/d1.ts
 * └── cloud/worker/src/push/seams.ts
 * External: node:fs, node:sqlite
 *
 * Used by:
 * helpers/d1.ts
 * ├── consumer.test.ts
 * ├── events_route.test.ts
 * ├── helpers/fakes.ts
 * └── migration.test.ts
 * <module-headers:end>
 */
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { D1Like, D1Result, D1Stmt } from "../../../src/push/seams.ts";

const here = (p: string) => new URL(p, import.meta.url);
export const BASE_SCHEMA = readFileSync(here("./base_schema_04.sql"), "utf8");
export const PUSH_MIGRATION = readFileSync(here("../../../migrations/0008_push.sql"), "utf8");

const norm = (v: unknown): SQLInputValue => (typeof v === "boolean" ? (v ? 1 : 0) : v === undefined ? null : (v as SQLInputValue));

class Stmt implements D1Stmt {
  constructor(
    private db: DatabaseSync,
    readonly sql: string,
    private params: SQLInputValue[] = [],
  ) {}
  bind(...values: unknown[]): D1Stmt {
    return new Stmt(this.db, this.sql, values.map(norm));
  }
  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.params) as T | undefined) ?? null;
  }
  async all<T>(): Promise<D1Result<T>> {
    return { results: this.db.prepare(this.sql).all(...this.params) as T[], meta: { changes: 0 } };
  }
  async run(): Promise<D1Result<unknown>> {
    return { results: [], meta: { changes: Number(this.db.prepare(this.sql).run(...this.params).changes) } };
  }
  exec(): D1Result<unknown> {
    if (/^\s*select/i.test(this.sql)) return { results: this.db.prepare(this.sql).all(...this.params), meta: { changes: 0 } };
    return { results: [], meta: { changes: Number(this.db.prepare(this.sql).run(...this.params).changes) } };
  }
}

export class TestD1 implements D1Like {
  readonly raw = new DatabaseSync(":memory:");
  prepare(sql: string): D1Stmt {
    return new Stmt(this.raw, sql);
  }
  async batch(statements: D1Stmt[]): Promise<D1Result<unknown>[]> {
    this.raw.exec("BEGIN");
    try {
      const out = statements.map((s) => (s as Stmt).exec());
      this.raw.exec("COMMIT");
      return out;
    } catch (err) {
      this.raw.exec("ROLLBACK");
      throw err;
    }
  }
  exec(sql: string): void {
    this.raw.exec(sql);
  }
}

export function migrated(withPush = true): TestD1 {
  const db = new TestD1();
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(BASE_SCHEMA);
  if (withPush) db.exec(PUSH_MIGRATION);
  return db;
}
