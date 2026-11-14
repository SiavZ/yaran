/**
 * Security headers and request-origin checks for every console, setup and admin response.
 *
 * Pages carry no inline script or style, so the CSP allows only same-origin scripts,
 * styles, fonts and fetches. Authenticated pages are never cached. Form posts must come
 * from this origin (Origin, or Sec-Fetch-Site when Origin is absent), which is the
 * `hono/csrf` rule; JSON admin routes additionally require `application/json`, which a
 * cross-site form cannot send without a preflight.
 *
 * - `htmlResponse` is the only way this phase builds an HTML response, so no page can
 *   omit a header. Phase 04's `responses.html()` applies the same set when merged.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * src/console/ui/security-headers.ts
 * ├── src/admin-api/routes.ts
 * ├── src/console/admin-routes.ts
 * ├── src/console/routes.ts
 * └── src/setup/routes.ts
 * <module-headers:end>
 */

export const CONSOLE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; " +
  "connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

export function securityHeaders(): Record<string, string> {
  return {
    "Content-Security-Policy": CONSOLE_CSP,
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    // same-origin, not no-referrer: no-referrer makes a form POST carry `Origin: null`.
    "Referrer-Policy": "same-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cache-Control": "no-store",
  };
}

export function htmlResponse(html: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...securityHeaders(), ...extra } });
}

export function redirect(location: string, extra: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { Location: location, ...securityHeaders(), ...extra } });
}

/** True when an unsafe form post comes from this origin. */
export function formOriginOk(request: Request, origin: string): boolean {
  const o = request.headers.get("Origin");
  if (o !== null) return o === origin;
  return request.headers.get("Sec-Fetch-Site") === "same-origin";
}

/** The JSON admin API rule: `application/json` and, when present, this Origin. */
export function jsonRequestCheck(request: Request, origin: string): "ok" | "unsupported_media_type" | "origin_mismatch" {
  const o = request.headers.get("Origin");
  if (o !== null && o !== origin) return "origin_mismatch";
  // A cross-site form can only send GET or POST; DELETE always needs a preflight.
  if (!["POST", "PUT", "PATCH"].includes(request.method)) return "ok";
  const type = (request.headers.get("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
  return type === "application/json" ? "ok" : "unsupported_media_type";
}
