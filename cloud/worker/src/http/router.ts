/**
 * Route matching on `URLPattern`, plus the canonical-path rule that runs before it.
 *
 * A path that is not already canonical (a doubled or encoded `/`, a `.` or `..` segment,
 * uppercase in a `/v1/` path, any percent-encoding in a `/v1/machine/` path) is refused
 * before any route is matched, so a normalization trick can never carry a request past the
 * Access public override to a protected route. An unknown path is 404 and a known path
 * with the wrong method is 405, both without touching auth.
 *
 * - The runtime's URL parser already resolves dot segments (`%2e%2e` included) before the
 *   Worker sees `request.url`; this check covers whatever survives that, and the route's
 *   own auth class covers the rest (G8 records what Access does with the raw path).
 *
 * <module-headers:begin>
 * Uses:
 * src/http/router.ts
 * └── src/http/routes.ts
 * External: none
 *
 * Used by:
 * src/http/router.ts
 * ├── src/http/pipeline.ts
 * └── test/router.test.ts
 * <module-headers:end>
 */
import type { Method, Route } from "./routes.ts";

/** Whether `path` (the pathname exactly as received, no query) is canonical. */
export function isCanonicalPath(path: string): boolean {
  if (!path.startsWith("/") || path.includes("//") || path.includes("\\")) return false;
  if (/%(2f|5c)/i.test(path)) return false;
  for (const seg of path.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      return false;
    }
    if (decoded === "." || decoded === ".." || decoded.includes("/")) return false;
  }
  if (path.startsWith("/v1/") || path === "/v1") {
    if (/[A-Z]/.test(path)) return false;
    if (path.startsWith("/v1/machine/") && path.includes("%")) return false;
  }
  return true;
}

export type Match =
  | { kind: "route"; route: Route; params: Record<string, string> }
  | { kind: "not_found" }
  | { kind: "method_not_allowed"; allow: Method[] };

export interface Router {
  match(method: string, path: string): Match;
}

/** Compiles a route table once; a duplicate method and path is a startup error. */
export function compileRoutes(routes: readonly Route[]): Router {
  const seen = new Set<string>();
  const compiled = routes.map((route) => {
    const key = `${route.method} ${route.path}`;
    if (seen.has(key)) throw new Error(`duplicate route ${key}`);
    seen.add(key);
    return { route, pattern: new URLPattern({ pathname: route.path }) };
  });
  return {
    match(method, path) {
      const allow: Method[] = [];
      for (const { route, pattern } of compiled) {
        const hit = pattern.exec({ pathname: path });
        if (!hit) continue;
        if (route.method === method) {
          const params: Record<string, string> = {};
          for (const [k, v] of Object.entries(hit.pathname.groups)) if (v !== undefined) params[k] = v;
          return { kind: "route", route, params };
        }
        allow.push(route.method);
      }
      return allow.length ? { kind: "method_not_allowed", allow } : { kind: "not_found" };
    },
  };
}
