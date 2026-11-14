/**
 * Every response the Worker sends is built here: JSON, HTML and the error envelope, with
 * the security headers no route may omit.
 *
 * Errors use the Phase 02 envelope and registry through `@yaran/protocol`, so a code's HTTP
 * status and retryability can never disagree with the contract. `finalize` stamps the
 * protocol, request-id and security headers on whatever a handler returned, which is why a
 * handler cannot forget them.
 *
 * - Throw `HttpError` from anywhere below the pipeline; it becomes an error response.
 * - HTML pages carry a strict CSP with no remote script source (07 renders through `html`).
 * - `Retry-After` is set on every 429 and 503.
 *
 * <module-headers:begin>
 * Uses:
 * src/http/responses.ts
 * └── @yaran/protocol:src/index.ts
 * External: none
 *
 * Used by:
 * src/http/responses.ts
 * ├── src/auth/access-jwt.ts
 * ├── src/auth/authorize.ts
 * ├── src/auth/identity.ts
 * ├── src/auth/machine-signature.ts
 * ├── src/cloudflare/access-sessions.ts
 * ├── src/devices/device-params.ts
 * ├── src/devices/devices-repo.ts
 * ├── src/devices/install-id.ts
 * ├── src/http/body.ts
 * ├── src/http/context.ts
 * ├── src/http/host-guard.ts
 * ├── src/http/pipeline.ts
 * ├── src/http/routes.ts
 * ├── src/index.ts
 * ├── src/machine-api/claim.ts
 * ├── src/machine-api/config.ts
 * ├── src/me/cursor.ts
 * ├── src/me/devices-route.ts
 * ├── src/me/machines-route.ts
 * ├── src/me/me-route.ts
 * ├── src/pairing/authorize-route.ts
 * ├── src/routes/phase06-context.ts
 * ├── src/security/data-key.ts
 * ├── src/security/rate-limit.ts
 * ├── src/sessions/handoff-route.ts
 * ├── src/sessions/revoke-sessions.ts
 * ├── src/shared/json-body.ts
 * ├── test/access-jwt.test.ts
 * ├── test/body.test.ts
 * ├── test/devices/device-params.test.ts
 * ├── test/error-codes.test.ts
 * ├── test/helpers/worker.ts
 * ├── test/machine-signature.test.ts
 * ├── test/rate-limit.test.ts
 * ├── test/responses.test.ts
 * └── test/sessions/revoke-sessions.test.ts
 * <module-headers:end>
 */
import { buildErrorEnvelope, errorEntry, type ErrorCode } from "@yaran/protocol";

export type ResponseKind = "json" | "html";

/** An error a handler or pipeline step raises; the pipeline turns it into a response. */
export class HttpError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;
  readonly headers: Record<string, string>;
  constructor(code: ErrorCode, message?: string, opts: { details?: Record<string, unknown>; headers?: Record<string, string> } = {}) {
    super(message ?? errorEntry(code)?.summary ?? code);
    this.code = code;
    this.details = opts.details;
    this.headers = opts.headers ?? {};
  }
}

/** Default seconds for `Retry-After` when the raiser did not set one. */
export const DEFAULT_RETRY_AFTER_S = 30;

export const CSP = "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const BASE_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "X-Frame-Options": "DENY",
};

/** The facts `finalize` needs from the request. */
export interface ResponseMeta {
  requestId: string;
  /** The protocol version served (the negotiated one, else the newest). */
  protocol: number;
  /** `public, max-age=60` for /v1/meta; everything else is `no-store`. */
  cacheControl?: string;
}

/** Stamps the protocol, request-id and security headers onto a response. */
export function finalize(res: Response, meta: ResponseMeta): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(BASE_HEADERS)) {
    // A page may tighten or widen its own Referrer-Policy (06's consent pages need same-origin).
    if (k !== "Referrer-Policy" || !out.headers.has(k)) out.headers.set(k, v);
  }
  out.headers.set("Cache-Control", meta.cacheControl ?? "no-store");
  out.headers.set("Yaran-Protocol", String(meta.protocol));
  out.headers.set("Yaran-Request-Id", meta.requestId);
  // A page that sets its own CSP keeps it: 06's consent forms must allow form-action to the
  // validated loopback or app callback, which the default would block on the redirect.
  if ((out.headers.get("Content-Type") ?? "").startsWith("text/html") && !out.headers.has("Content-Security-Policy")) {
    out.headers.set("Content-Security-Policy", CSP);
  }
  if ((out.status === 429 || out.status === 503) && !out.headers.has("Retry-After")) {
    out.headers.set("Retry-After", String(DEFAULT_RETRY_AFTER_S));
  }
  return out;
}

/** A JSON response. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

/** An HTML response; the markup must already be escaped (see `escapeHtml`). */
export function html(markup: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(markup, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...headers } });
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The error response for `err`, shaped by the route kind. */
export function errorResponse(err: HttpError, kind: ResponseKind, requestId: string): Response {
  const { status, body } = buildErrorEnvelope(err.code, err.message, requestId, err.details);
  if (kind === "json") return json(body, status, err.headers);
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(err.code)}</title></head><body><main><h1>${escapeHtml(err.message)}</h1><p>Error code <code>${escapeHtml(err.code)}</code>, request <code>${escapeHtml(requestId)}</code>.</p></main></body></html>`;
  return html(page, status, err.headers);
}
