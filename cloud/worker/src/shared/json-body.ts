/**
 * Reads a JSON request body and validates it against a named 02 schema type, refusing
 * with 02's codes (`bad_request` for unparseable bytes, `validation_failed` with the
 * schema's error pointers otherwise).
 *
 * Stand-in for 04's `http/body.ts` schema step, which machine routes reach after the
 * signature has been checked over the same raw bytes.
 *
 * <module-headers:begin>
 * Uses:
 * src/shared/json-body.ts
 * ├── @yaran/protocol:src/index.ts
 * └── src/seams/foundation.ts
 * External: none
 *
 * Used by:
 * src/shared/json-body.ts
 * ├── src/machine-api/claim.ts
 * ├── src/machine-api/origin.ts
 * └── src/machine-api/rotate.ts
 * <module-headers:end>
 */
import { utf8Decode, validate } from "@yaran/protocol";
import { ApiError } from "../seams/foundation.ts";

/** The parsed JSON value, before schema validation. */
export function parseJson(body: Uint8Array): unknown {
  const text = utf8Decode(body);
  try {
    if (text === null) throw new Error("not UTF-8");
    return JSON.parse(text);
  } catch {
    throw new ApiError("bad_request", "The request body is not valid JSON.");
  }
}

export function validated<T>(type: string, value: unknown): T {
  const r = validate(type, value);
  if (!r.valid) throw new ApiError("validation_failed", `The request does not match ${type}.`, { errors: r.errors.map((e) => ({ path: e.path, message: e.message })) });
  return value as T;
}

/** A body's `origin_port` outside 1-65535 is `origin_port_invalid`, before the schema runs. */
export function checkOriginPortField(value: unknown): void {
  if (value === null || typeof value !== "object" || !("origin_port" in value)) return;
  const port = (value as { origin_port: unknown }).origin_port;
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) {
    throw new ApiError("origin_port_invalid", "origin_port must be an integer from 1 to 65535: the port yaran serves on.");
  }
}
