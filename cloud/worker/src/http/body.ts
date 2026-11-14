/**
 * Request bodies: a size-capped raw read (done once, before auth, because the machine
 * signature covers the exact bytes), the content-type rule, and schema-validated JSON.
 *
 * - Over the cap: `413 payload_too_large`, checked on Content-Length and while streaming.
 * - A JSON route's non-empty body must be `application/json`: `415 unsupported_media_type`.
 * - `readJson` validates against a Phase 02 schema type through `@yaran/protocol`; a
 *   failure is `400 validation_failed` with each error's JSON pointer.
 *
 * <module-headers:begin>
 * Uses:
 * src/http/body.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/http/context.ts
 * └── src/http/responses.ts
 * External: none
 *
 * Used by:
 * src/http/body.ts
 * ├── src/http/pipeline.ts
 * ├── src/shared/json-body.ts
 * └── test/body.test.ts
 * <module-headers:end>
 */
import { validate } from "@yaran/protocol";
import type { RequestContext } from "./context.ts";
import { HttpError } from "./responses.ts";

const tooLarge = () => new HttpError("payload_too_large", "The request body is larger than this route accepts.");

/** Reads the whole body, refusing anything over `limit` bytes. */
export async function readBody(request: Request, limit: number): Promise<Uint8Array> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && Number(declared) > limit) throw tooLarge();
  if (!request.body) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export function isJsonContentType(request: Request): boolean {
  const type = (request.headers.get("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
  return type === "application/json";
}

/** Parses raw body bytes as JSON (`bad_request` when they are not). */
export function parseJsonBytes(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body));
  } catch {
    throw new HttpError("bad_request", "The request body is not valid JSON.");
  }
}

/** Validates a parsed value against the named Phase 02 schema type (`validation_failed`). */
export function validateAs<T>(typeName: string, value: unknown): T {
  const result = validate(typeName, value);
  if (!result.valid) {
    throw new HttpError("validation_failed", "The request body does not match the expected shape.", {
      details: { errors: result.errors.map((e) => ({ path: e.path.replace(/^#/, ""), message: e.message })) },
    });
  }
  return value as T;
}

/** Parses the body as JSON and validates it against the named Phase 02 schema type. */
export function readJson<T>(ctx: RequestContext, typeName: string): T {
  return validateAs<T>(typeName, parseJsonBytes(ctx.body));
}
