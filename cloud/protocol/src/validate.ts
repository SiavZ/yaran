/**
 * Runtime validation of every protocol type against the JSON Schemas (the source of
 * truth), with one cached validator per type name.
 *
 * Uses `@cfworker/json-schema` (draft 2020-12, no eval), the validator that runs in
 * Workers, the relay and the shell alike. A type name is any `$defs` key in
 * `schemas/*.schema.json`; names are unique across files, which `schemas.test.ts` pins.
 *
 * - Request schemas are closed (`additionalProperties: false`); response schemas are
 *   open. Response enums are open on the wire: a client that validates a response
 *   must treat an enum failure from a newer server as "unknown", not as an attack.
 * - Integers that arrive in query strings or forms are coerced by the caller first.
 *
 * <module-headers:begin>
 * Uses:
 * src/validate.ts
 * ├── schemas/admin.schema.json
 * ├── schemas/common.schema.json
 * ├── schemas/devices.schema.json
 * ├── schemas/error.schema.json
 * ├── schemas/handoff.schema.json
 * ├── schemas/machine.schema.json
 * ├── schemas/me.schema.json
 * ├── schemas/meta.schema.json
 * ├── schemas/pairing.schema.json
 * ├── schemas/push.schema.json
 * ├── schemas/relay.schema.json
 * └── schemas/release-manifest.schema.json
 * External: @cfworker/json-schema
 *
 * Used by:
 * src/validate.ts
 * ├── src/errors.ts
 * ├── src/index.ts
 * ├── src/jwe/handoff.ts
 * ├── src/push/payload.ts
 * ├── test/errors.test.ts
 * ├── test/push.test.ts
 * └── test/schemas.test.ts
 * <module-headers:end>
 */
import { Validator, type OutputUnit, type Schema } from "@cfworker/json-schema";
import admin from "../schemas/admin.schema.json" with { type: "json" };
import common from "../schemas/common.schema.json" with { type: "json" };
import devices from "../schemas/devices.schema.json" with { type: "json" };
import error from "../schemas/error.schema.json" with { type: "json" };
import handoff from "../schemas/handoff.schema.json" with { type: "json" };
import machine from "../schemas/machine.schema.json" with { type: "json" };
import me from "../schemas/me.schema.json" with { type: "json" };
import meta from "../schemas/meta.schema.json" with { type: "json" };
import pairing from "../schemas/pairing.schema.json" with { type: "json" };
import push from "../schemas/push.schema.json" with { type: "json" };
import relay from "../schemas/relay.schema.json" with { type: "json" };
import releaseManifest from "../schemas/release-manifest.schema.json" with { type: "json" };

interface SchemaFile {
  $id: string;
  $defs: Record<string, unknown>;
}

/** Every schema file, in a fixed order. */
export const SCHEMA_FILES: readonly SchemaFile[] = [
  common, meta, pairing, machine, me, devices, handoff, admin, push, relay, error, releaseManifest,
] as SchemaFile[];

const FILE_OF_TYPE = new Map<string, string>();
for (const file of SCHEMA_FILES) {
  for (const name of Object.keys(file.$defs)) FILE_OF_TYPE.set(name, file.$id);
}

/** Every type name the schemas define. */
export function schemaTypeNames(): string[] {
  return [...FILE_OF_TYPE.keys()];
}

const cache = new Map<string, Validator>();

function validatorFor(typeName: string): Validator {
  const cached = cache.get(typeName);
  if (cached) return cached;
  const file = FILE_OF_TYPE.get(typeName);
  if (!file) throw new Error(`no schema type named ${typeName}`);
  // A synthetic root that points at the type; every file is registered so relative
  // $refs between files resolve against one shared base.
  const root = { $id: `root-${typeName}.json`, $ref: `${file}#/$defs/${typeName}` };
  const validator = new Validator(root as Schema, "2020-12", false);
  for (const f of SCHEMA_FILES) validator.addSchema(structuredClone(f) as Schema);
  cache.set(typeName, validator);
  return validator;
}

export interface ValidationResult {
  valid: boolean;
  /** Leaf errors as {path, keyword, message}, at most 20 (the validation_failed cap). */
  errors: { path: string; keyword: string; message: string }[];
}

/** Validates a value against a named schema type. */
export function validate(typeName: string, value: unknown): ValidationResult {
  const result = validatorFor(typeName).validate(value);
  const errors = result.errors
    .filter((e: OutputUnit) => e.keyword !== "$ref" && e.keyword !== "properties" && e.keyword !== "items")
    .slice(0, 20)
    .map((e: OutputUnit) => ({ path: e.instanceLocation, keyword: e.keyword, message: e.error }));
  return { valid: result.valid, errors };
}
