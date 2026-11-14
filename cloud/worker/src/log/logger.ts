/**
 * Structured logger: one JSON object per line on the console, which Workers Logs index.
 *
 * Every line carries `level` and `event` plus the request's fields (`request_id`, `route`,
 * `actor_kind`, `actor_id`) and any extra fields. Before serializing, every string is run
 * through the sanitizer and every value under a deny-listed key is replaced, at any depth,
 * so a token, signature or push endpoint can never reach the log.
 *
 * - Never log a request or response body; pass the facts you need as fields.
 * - Extend the deny-list here when a new secret-bearing field name appears.
 *
 * <module-headers:begin>
 * Uses:
 * src/log/logger.ts
 * └── src/security/sanitize.ts
 * External: none
 *
 * Used by:
 * src/log/logger.ts
 * ├── src/audit/audit.ts
 * ├── src/db/migrate-runtime.ts
 * ├── src/http/context.ts
 * ├── src/http/pipeline.ts
 * ├── src/index.ts
 * ├── src/scheduled/dispatcher.ts
 * ├── src/security/secrets.ts
 * ├── test/helpers/app.ts
 * ├── test/helpers/deps.ts
 * ├── test/machine-signature.test.ts
 * ├── test/migrate-runtime.test.ts
 * ├── test/phase06/fakes.ts
 * └── test/sanitize.test.ts
 * <module-headers:end>
 */
import { forTerminal } from "../security/sanitize.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

/** Keys whose values are never logged, compared case-insensitively. */
export const REDACTED_KEYS: ReadonlySet<string> = new Set([
  "token", "jwt", "cookie", "authorization", "signature", "secret", "private_key", "endpoint",
  "p256dh", "auth", "code", "code_verifier", "state",
]);
export const REDACTED = "[redacted]";

/** Deep copy with deny-listed keys redacted and strings sanitized. */
export function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return forTerminal(value);
  if (value === null || typeof value !== "object") return value;
  if (depth > 8) return "[depth]";
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (value instanceof Error) return forTerminal(value.stack ?? `${value.name}: ${value.message}`);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[forTerminal(k)] = REDACTED_KEYS.has(k.toLowerCase()) ? REDACTED : scrub(v, depth + 1);
  }
  return out;
}

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** A logger whose lines also carry `fields` (later values win). */
  with(fields: LogFields): Logger;
}

/** Creates a logger whose lines carry `base`. */
export function createLogger(base: LogFields = {}): Logger {
  const emit = (level: LogLevel, event: string, fields: LogFields = {}) => {
    const line = scrub({ ...base, ...fields, level, event }) as LogFields;
    console.log(JSON.stringify(line));
  };
  return {
    debug: (e, f) => emit("debug", e, f),
    info: (e, f) => emit("info", e, f),
    warn: (e, f) => emit("warn", e, f),
    error: (e, f) => emit("error", e, f),
    with: (fields) => createLogger({ ...base, ...fields }),
  };
}
