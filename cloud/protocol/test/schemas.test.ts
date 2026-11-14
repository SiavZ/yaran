/**
 * Proves the JSON Schemas and the API fixtures agree (Phase 02 work item 2).
 *
 * Every `$defs` type compiles under @cfworker/json-schema draft 2020-12, type names are
 * unique across schema files, every type has `fixtures/api/<Type>.json` and every fixture
 * names a real type, every valid value validates, and every invalid value is rejected
 * with the keyword its fixture names. The Rust suite reads the same files, so the two
 * languages are tied through these fixtures.
 *
 * - Reads fixtures relative to this file (the prose.test.tsx pattern).
 *
 * <module-headers:begin>
 * Uses:
 * test/schemas.test.ts
 * └── src/validate.ts
 * External: node:fs, node:path, node:url, vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/protocol and cloud-protocol.yml)
 * <module-headers:end>
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SCHEMA_FILES, schemaTypeNames, validate } from "../src/validate.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const apiDir = join(root, "fixtures/api");

interface ApiFixture {
  type: string;
  schema: string;
  valid: { name: string; value: unknown }[];
  invalid: { name: string; keyword: string; value: unknown }[];
}

const fixtures: ApiFixture[] = readdirSync(apiDir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(apiDir, f), "utf8")) as ApiFixture);

describe("schemas", () => {
  it("define every type name exactly once across files", () => {
    const seen = new Map<string, string>();
    for (const file of SCHEMA_FILES) {
      for (const name of Object.keys(file.$defs)) {
        expect(seen.get(name), `${name} is defined in ${seen.get(name)} and ${file.$id}`).toBeUndefined();
        seen.set(name, file.$id);
      }
    }
    expect(seen.size).toBe(schemaTypeNames().length);
  });

  it("compile every type", () => {
    for (const name of schemaTypeNames()) expect(() => validate(name, null)).not.toThrow();
  });

  it("give every type a fixture file and every fixture a real type", () => {
    const fixtureTypes = new Set(fixtures.map((f) => f.type));
    expect([...schemaTypeNames()].sort()).toEqual([...fixtureTypes].sort());
    for (const f of fixtures) {
      expect(f.schema.endsWith(`#/$defs/${f.type}`)).toBe(true);
      expect(f.valid.length, `${f.type} has no valid value`).toBeGreaterThan(0);
      expect(f.invalid.length, `${f.type} has no invalid value`).toBeGreaterThan(0);
    }
  });

  it("reject Meta that says setup is closed but omits org", () => {
    const meta = fixtures.find((f) => f.type === "Meta")!;
    const closed = structuredClone(meta.valid.find((v) => v.name === "closed")!.value) as Record<string, unknown>;
    delete closed.org;
    expect(validate("Meta", closed).valid).toBe(false);
  });
});

describe.each(fixtures)("fixtures/api/$type.json", (fixture) => {
  it.each(fixture.valid)("accepts $name", ({ value }) => {
    const result = validate(fixture.type, value);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it.each(fixture.invalid)("rejects $name with $keyword", ({ value, keyword }) => {
    const result = validate(fixture.type, value);
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.keyword)).toContain(keyword);
  });
});
