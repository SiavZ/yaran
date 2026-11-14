/**
 * Generator for `fixtures/api/<Type>.json`: one file per `$defs` entry of every schema.
 *
 * Collects the case modules, refuses to run unless every schema type has exactly one
 * case entry, and writes `{ type, schema, valid: [{name, value}], invalid: [{name,
 * keyword, value}] }`. Each invalid value differs from a valid one in one place and names
 * the JSON Schema keyword that rejects it; `test/schemas.test.ts` proves that, and the
 * Rust suite round-trips the valid values of the types it owns.
 *
 * - Deterministic; reads only the schema files to list the types.
 *
 * <module-headers:begin>
 * Uses:
 * scripts/vectors/api.mjs
 * ├── scripts/vectors/api-cases-admin.mjs
 * ├── scripts/vectors/api-cases-common.mjs
 * ├── scripts/vectors/api-cases-handoff.mjs
 * └── scripts/vectors/api-cases-machine.mjs
 * External: node:fs, node:path, node:url
 *
 * Used by:
 * scripts/vectors/api.mjs
 * └── scripts/gen-vectors.mjs
 * <module-headers:end>
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cases as admin } from "./api-cases-admin.mjs";
import { cases as common } from "./api-cases-common.mjs";
import { cases as handoff } from "./api-cases-handoff.mjs";
import { cases as machine } from "./api-cases-machine.mjs";

const schemasDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "schemas");

export async function generate() {
  const fileOf = new Map();
  for (const file of readdirSync(schemasDir).filter((f) => f.endsWith(".schema.json")).sort()) {
    for (const name of Object.keys(JSON.parse(readFileSync(join(schemasDir, file), "utf8")).$defs)) fileOf.set(name, file);
  }
  const out = {};
  for (const c of [...common, ...machine, ...handoff, ...admin]) {
    if (fileOf.get(c.type) !== c.file) throw new Error(`api case ${c.type}: no such type in ${c.file}`);
    if (out[`api/${c.type}.json`]) throw new Error(`api case ${c.type} listed twice`);
    if (!c.valid.length || !c.invalid.length) throw new Error(`api case ${c.type} needs valid and invalid values`);
    out[`api/${c.type}.json`] = {
      type: c.type,
      schema: `${c.file}#/$defs/${c.type}`,
      valid: c.valid.map(([name, value]) => ({ name, value })),
      invalid: c.invalid.map(([name, keyword, value]) => ({ name, keyword, value })),
    };
  }
  const missing = [...fileOf.keys()].filter((t) => !out[`api/${t}.json`]);
  if (missing.length) throw new Error(`schema types without api fixtures: ${missing.join(", ")}`);
  return out;
}
