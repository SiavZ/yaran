/**
 * Every error code Phase 04 emits exists in Phase 02's registry with the HTTP status the
 * Worker sends.
 *
 * <module-headers:begin>
 * Uses:
 * test/error-codes.test.ts
 * ├── @yaran/protocol:src/index.ts
 * └── src/http/responses.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { errorEntry, type ErrorCode } from "@yaran/protocol";
import { describe, expect, it } from "vitest";
import { errorResponse, HttpError } from "../src/http/responses.ts";

/** Design §6: every code Phase 04 emits, with the HTTP status it sends. */
const EMITTED: Record<string, number> = {
  bad_request: 400, validation_failed: 400, protocol_unsupported: 400, unauthenticated: 401,
  service_token_rejected: 403, forbidden: 403, user_disabled: 403, origin_mismatch: 403,
  misdirected_host: 421, not_found: 404, method_not_allowed: 405, conflict: 409,
  payload_too_large: 413, unsupported_media_type: 415, rate_limited: 429, internal: 500,
  unavailable: 503, identity_unavailable: 503, setup_incomplete: 503, setup_closed: 410,
  signature_missing: 401, signature_invalid: 401, signature_expired: 401, nonce_replayed: 401,
  machine_unknown: 401, machine_revoked: 410, machine_not_ready: 409, pair_code_invalid: 400,
};

describe("error codes", () => {
  it.each(Object.entries(EMITTED))("%s is in the registry with status %i", (code, status) => {
    const entry = errorEntry(code);
    expect(entry?.status).toBe(status);
    expect(entry?.local).toBeFalsy();
    expect(errorResponse(new HttpError(code as ErrorCode), "json", "r1").status).toBe(status);
  });
});
