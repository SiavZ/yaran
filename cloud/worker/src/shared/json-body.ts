/**
 * The `origin_port` pre-check machine routes run between parsing and validating a body
 * (04's `parseJsonBytes` and `validateAs`), so a bad port gets its own code.
 *
 * <module-headers:begin>
 * Uses:
 * src/shared/json-body.ts
 * ├── src/http/body.ts
 * └── src/http/responses.ts
 * External: none
 *
 * Used by:
 * src/shared/json-body.ts
 * ├── src/machine-api/claim.ts
 * ├── src/machine-api/origin.ts
 * └── src/machine-api/rotate.ts
 * <module-headers:end>
 */
import { HttpError } from "../http/responses.ts";

export { parseJsonBytes as parseJson, validateAs as validated } from "../http/body.ts";

/** A body's `origin_port` outside 1-65535 is `origin_port_invalid`, before the schema runs. */
export function checkOriginPortField(value: unknown): void {
  if (value === null || typeof value !== "object" || !("origin_port" in value)) return;
  const port = (value as { origin_port: unknown }).origin_port;
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) {
    throw new HttpError("origin_port_invalid", "origin_port must be an integer from 1 to 65535: the port yaran serves on.");
  }
}
