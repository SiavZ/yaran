/**
 * THE route table: every route the Worker serves is one row here, and every row declares
 * who may call it. A row without an `auth` class does not compile, and the authorization
 * matrix test iterates this table, so a new route is covered the moment it exists.
 *
 * How a phase adds routes: put its rows in a module of its own that exports a
 * `readonly Route[]` (for example `src/pairing/routes.ts`), then add ONE import and ONE
 * spread line to `ROUTES` below. Never add an auth check inside a handler instead of
 * choosing the right class here.
 *
 * - `protocol`: "header" requires `Yaran-Protocol` (every JSON /v1/* route but /v1/meta);
 *   "query" checks the `v` parameter (W2/W3, W16/W16b); "none" negotiates nothing (setup,
 *   consoles, /v1/meta).
 * - `rateLimit`: every request also counts against the per-IP bucket; "auth" and
 *   "machine" add the stricter bucket.
 *
 * <module-headers:begin>
 * Uses:
 * src/http/routes.ts
 * ├── src/http/context.ts
 * ├── src/http/responses.ts
 * ├── src/phase07.ts
 * └── src/routes/pairing-and-sessions.ts
 * External: none
 *
 * Used by:
 * src/http/routes.ts
 * ├── src/auth/authorize.ts
 * ├── src/http/host-guard.ts
 * ├── src/http/pipeline.ts
 * ├── src/http/router.ts
 * ├── src/index.ts
 * ├── src/phase07.ts
 * ├── src/routes/call.ts
 * ├── src/routes/pairing-and-sessions.ts
 * ├── src/routes/phase06-context.ts
 * ├── src/routes/phase07-context.ts
 * ├── src/security/rate-limit.ts
 * ├── test/body.test.ts
 * ├── test/helpers/deps.ts
 * ├── test/helpers/matrix.ts
 * ├── test/helpers/worker.ts
 * └── test/no-secret-leak.test.ts
 * <module-headers:end>
 */
import type { RequestContext } from "./context.ts";
import type { ResponseKind } from "./responses.ts";
import { PHASE07_ROUTE_TABLE } from "../phase07.ts";
import { PHASE06_ROUTE_TABLE } from "../routes/pairing-and-sessions.ts";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Who may call a route. `authorize.ts` switches over this exhaustively. */
export type RouteAuth =
  | { kind: "public" } // W1 /v1/meta only (06)
  | { kind: "setup" } // W29 /setup*, served only while setup is open (07)
  | { kind: "machine"; key: "registered" | "pair_request" } // Ed25519 (W4 claim uses pair_request)
  | { kind: "user" } // valid Access JWT, active user
  | { kind: "admin" }; // as user, plus role = admin

export type RateBucket = "ip" | "auth" | "machine";
export type ProtocolRule = "header" | "query" | "none";

export interface Route {
  method: Method;
  /** A URLPattern pathname, such as `/v1/me/devices/:id`. */
  path: string;
  auth: RouteAuth;
  kind: ResponseKind;
  protocol: ProtocolRule;
  rateLimit: RateBucket;
  /** Request body cap in bytes; defaults to 64 KiB. */
  bodyLimit?: number;
  handler: (ctx: RequestContext) => Promise<Response>;
}

export const DEFAULT_BODY_LIMIT = 64 * 1024;

/** Every production route. Phases 05–08 append one spread line each. */
export const ROUTES: readonly Route[] = [...PHASE06_ROUTE_TABLE, ...PHASE07_ROUTE_TABLE];
