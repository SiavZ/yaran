/**
 * The error registry and the JSON error envelope (Design §4).
 *
 * Servers (Worker, relay) build envelopes here so status, retryability and the code
 * always agree with `registry/errors.json`; clients interpret envelopes here so an
 * unknown code falls back to its HTTP status class instead of being guessed at.
 *
 * - `message` is human text the server has already sanitized; this module never
 *   inspects it.
 * - Local codes (`jwe_*`, `push_*`, `uri_invalid`) and callback-only codes have no HTTP
 *   status, so `buildErrorEnvelope` refuses them.
 *
 * <module-headers:begin>
 * Uses:
 * src/errors.ts
 * ├── cloud/protocol/registry/errors.json
 * ├── src/generated/types.ts
 * └── src/validate.ts
 * External: none
 *
 * Used by:
 * src/errors.ts
 * ├── src/index.ts
 * └── test/errors.test.ts
 * <module-headers:end>
 */
import registry from "../registry/errors.json" with { type: "json" };
import type { ErrorCode, ErrorEnvelope } from "./generated/types.ts";
import { validate } from "./validate.ts";

export interface ErrorEntry {
  code: string;
  status: number | null;
  retryable: boolean;
  emitted_by: string[];
  summary: string;
  reserved?: boolean;
  local?: boolean;
}

const ENTRIES: ReadonlyMap<string, ErrorEntry> = new Map(
  (registry.codes as ErrorEntry[]).map((e) => [e.code, e]),
);

/** The registry entry for a code, or undefined for a code this build does not know. */
export function errorEntry(code: string): ErrorEntry | undefined {
  return ENTRIES.get(code);
}

/** Every registry entry, in registry order. */
export function errorEntries(): readonly ErrorEntry[] {
  return [...ENTRIES.values()];
}

/**
 * Builds the envelope for an HTTP-emittable code. Throws for reserved, local and
 * callback-only codes, which must never reach a response body.
 */
export function buildErrorEnvelope(
  code: ErrorCode,
  message: string,
  requestId: string,
  details?: Record<string, unknown>,
): { status: number; body: ErrorEnvelope } {
  const entry = ENTRIES.get(code);
  if (!entry || entry.status === null || entry.reserved || entry.local) {
    throw new Error(`error code ${code} cannot be sent in a response body`);
  }
  const error: ErrorEnvelope["error"] = { code, message, retryable: entry.retryable };
  if (details) error.details = details;
  return { status: entry.status, body: { error, request_id: requestId } };
}

export interface InterpretedError {
  /** The registry code, or "unknown" when the body is missing, malformed or names a new code. */
  code: ErrorCode | "unknown";
  /** The raw code string when the body carried one. */
  rawCode: string | null;
  retryable: boolean;
  status: number;
  requestId: string | null;
  details: Record<string, unknown> | null;
}

/**
 * Interprets a non-2xx response. A known code is trusted as-is; anything else falls
 * back to the status class (429 and 5xx retry, every other status does not).
 */
export function interpretError(status: number, body: unknown): InterpretedError {
  const parsed = validate("ErrorEnvelope", body).valid ? (body as ErrorEnvelope) : null;
  const rawCode = parsed?.error.code ?? null;
  const entry = rawCode === null ? undefined : ENTRIES.get(rawCode);
  const known = entry !== undefined && !entry.local && !entry.reserved;
  return {
    code: known ? (rawCode as ErrorCode) : "unknown",
    rawCode,
    retryable: known ? entry.retryable : status === 429 || status >= 500,
    status,
    requestId: parsed?.request_id ?? null,
    details: (parsed?.error.details as Record<string, unknown> | undefined) ?? null,
  };
}
