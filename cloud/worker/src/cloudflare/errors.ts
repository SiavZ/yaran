/**
 * Cloudflare API errors: one `CfApiError` with an exhaustive `kind`, and the table that maps it.
 *
 * Every failed Cloudflare call becomes a `CfApiError`. The saga decides retry, adoption or
 * compensation from `kind` alone, and the HTTP layer surfaces the 02 registry code that
 * `wireCodeFor` returns, so classification lives in exactly one place.
 *
 * - Carries no request headers, so the API token can never ride an error.
 * - Cloudflare's message text is attacker-influenced; callers sanitize `cfErrors` before
 *   logging or auditing (see `safeErrorDetail`).
 * - The DNS same-name conflict codes (8105x) come from third-party sources only and are
 *   UNVERIFIED, so the whole 81050-81059 range is matched.
 *
 * <module-headers:begin>
 * Uses:
 * src/cloudflare/errors.ts
 * └── @yaran/protocol:src/index.ts
 * External: none
 *
 * Used by:
 * src/cloudflare/errors.ts
 * ├── src/cloudflare/budget.ts
 * ├── src/cloudflare/client.ts
 * ├── src/cloudflare/paginate.ts
 * ├── src/provisioning/engine.ts
 * ├── src/provisioning/steps-provision.ts
 * ├── src/provisioning/steps-teardown.ts
 * ├── src/reconcile/kit.ts
 * ├── src/reconcile/orphans.ts
 * ├── src/routes/phase06-context.ts
 * ├── test/provisioning/budget.test.ts
 * ├── test/provisioning/client.test.ts
 * └── test/provisioning/errors.test.ts
 * <module-headers:end>
 */
import type { ErrorCode } from "@yaran/protocol";

export type CfErrorKind = "rate_limited" | "transient" | "not_found" | "conflict" | "auth" | "invalid";

export interface CfErrorItem {
  code: number;
  message: string;
}

export class CfApiError extends Error {
  override readonly name = "CfApiError";
  constructor(
    readonly kind: CfErrorKind,
    readonly status: number | null,
    /** `METHOD /path` without the query string. */
    readonly endpoint: string,
    readonly cfErrors: readonly CfErrorItem[] = [],
    /** Seconds, from `retry-after` or the known block. */
    readonly retryAfter: number | null = null,
    message?: string,
  ) {
    super(message ?? `${endpoint} failed (${kind}${status === null ? "" : `, HTTP ${status}`})`);
  }
}

const DNS_CONFLICT_MIN = 81050;
const DNS_CONFLICT_MAX = 81059;

/** Classifies a non-success HTTP answer. Network failures and timeouts are `transient` by the client. */
export function classify(status: number, errors: readonly CfErrorItem[]): CfErrorKind {
  if (status === 429) return "rate_limited";
  if (status >= 500) return "transient";
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (errors.some((e) => e.code >= DNS_CONFLICT_MIN && e.code <= DNS_CONFLICT_MAX)) return "conflict";
  return "invalid";
}

export function assertNever(x: never): never {
  throw new Error(`unreachable: ${String(x)}`);
}

/** The 02 registry code a surfaced error carries (02 §4). */
export function wireCodeFor(kind: CfErrorKind): ErrorCode {
  switch (kind) {
    case "rate_limited":
      return "cloudflare_rate_limited";
    case "transient":
      return "cloudflare_unavailable";
    case "conflict":
      return "hostname_conflict";
    case "auth":
      return "cloudflare_permission_denied";
    case "invalid":
    case "not_found": // handled per step; reaching the wire means a call failed unexpectedly
      return "cloudflare_api_failed";
    default:
      return assertNever(kind);
  }
}

/** The token permission an endpoint needs, for an admin-actionable `auth` message (07 template, G9). */
export function permissionFor(endpoint: string): string {
  if (endpoint.includes("/cfd_tunnel")) return "Cloudflare Tunnel Edit";
  if (endpoint.includes("/access/")) return "Access: Apps and Policies Edit";
  if (endpoint.includes("/dns_records")) return "DNS Edit";
  return "Zone Read";
}

export function isRetryable(err: CfApiError): boolean {
  return err.kind === "transient" || err.kind === "rate_limited";
}

/** Sanitized, size-bounded detail for logs, audit rows and `provisioning_ops.last_error`. */
export function safeErrorDetail(err: CfApiError, sanitize: (s: string) => string): Record<string, unknown> {
  const detail: Record<string, unknown> = {
    kind: err.kind,
    status: err.status,
    endpoint: sanitize(err.endpoint),
    cf_errors: err.cfErrors.slice(0, 5).map((e) => ({ code: e.code, message: sanitize(e.message).slice(0, 200) })),
  };
  if (err.kind === "auth") detail["permission"] = permissionFor(err.endpoint);
  return detail;
}
