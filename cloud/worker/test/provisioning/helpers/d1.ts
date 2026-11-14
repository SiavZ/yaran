/**
 * A D1 stand-in over `node:sqlite`, so the provisioning tests run real SQL (partial unique
 * index, conditional updates, `batch()` transactions) without the Workers pool.
 *
 * - `batch()` is one transaction; `failNextBatch()` makes the next batch throw before it
 *   commits, which is how the crash matrix simulates a Worker dying after an API call.
 * - Binding `undefined` throws, as D1 does.
 * - The schema is the Worker's own `migrations/*.sql`, applied in order.
 *
 * <module-headers:begin>
 * Uses:
 * test/provisioning/helpers/d1.ts
 * └── src/provisioning/ports.ts
 * External: node:fs, node:path, node:sqlite, node:url
 *
 * Used by:
 * test/provisioning/helpers/d1.ts
 * ├── test/provisioning/budget.test.ts
 * ├── test/provisioning/client.test.ts
 * ├── test/provisioning/helpers/world.ts
 * └── test/provisioning/paginate.test.ts
 * <module-headers:end>
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { D1Like, D1Result, D1Stmt } from "../../../src/provisioning/ports.ts";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "../../../migrations");

/** The Worker's own D1 migrations, in apply order: the stand-in runs the real schema. */
export function schemaSql(): string {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
    .join("\n");
}

type Param = string | number | bigint | null | Uint8Array;

class Stmt implements D1Stmt {
  constructor(
    readonly db: FakeD1,
    readonly sql: string,
    readonly params: Param[] = [],
  ) {}
  bind(...values: unknown[]): D1Stmt {
    for (const v of values) if (v === undefined) throw new Error(`D1_TYPE_ERROR: undefined bound in ${this.sql}`);
    return new Stmt(this.db, this.sql, values as Param[]);
  }
  exec(): D1Result {
    const st = this.db.sqlite.prepare(this.sql);
    if (st.columns().length > 0) return { results: st.all(...this.params) as Record<string, unknown>[], meta: { changes: 0 } };
    const r = st.run(...this.params);
    return { results: [], meta: { changes: Number(r.changes) } };
  }
  async first<T>(): Promise<T | null> {
    this.db.queries++;
    return ((this.exec().results[0] as T | undefined) ?? null);
  }
  async all<T>(): Promise<D1Result<T>> {
    this.db.queries++;
    return this.exec() as D1Result<T>;
  }
  async run(): Promise<D1Result> {
    this.db.queries++;
    return this.exec();
  }
}

export class FakeD1 implements D1Like {
  readonly sqlite = new DatabaseSync(":memory:");
  queries = 0;
  private crashNext = false;

  constructor() {
    this.sqlite.exec("PRAGMA foreign_keys = ON;");
    this.sqlite.exec(schemaSql());
  }

  prepare(sql: string): D1Stmt {
    return new Stmt(this, sql);
  }

  failNextBatch(): void {
    this.crashNext = true;
  }

  async batch(stmts: D1Stmt[]): Promise<D1Result[]> {
    this.queries++;
    if (this.crashNext) {
      this.crashNext = false;
      throw new Error("simulated crash: the Worker died before this D1 batch committed");
    }
    this.sqlite.exec("BEGIN");
    try {
      const out = stmts.map((s) => (s as Stmt).exec());
      this.sqlite.exec("COMMIT");
      return out;
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
  }

  /** Every text value in every table, for the "no token in D1" scan. */
  allText(): string {
    const tables = this.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    return tables.map((t) => JSON.stringify(this.sqlite.prepare(`SELECT * FROM "${t.name}"`).all())).join("\n");
  }
}
