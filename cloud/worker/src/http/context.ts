/**
 * The request context every pipeline step and handler receives, and the narrowing helpers
 * handlers use to read the identity the pipeline already proved.
 *
 * `AppContext` is the part shared with cron tasks (env, db, logger, clock, actor), so the
 * audit writer and the repositories accept either. `RequestContext` adds the request, the
 * matched route's params, the raw body and the identity.
 *
 * - The identity is set only by `auth/authorize.ts`; handlers never authenticate.
 * - `requireUser`/`requireAdmin`/`requireMachine` assert what the route's auth class
 *   guarantees; a mismatch is a programming error and becomes `500 internal`.
 *
 * <module-headers:begin>
 * Uses:
 * src/http/context.ts
 * ├── src/db/machines.ts
 * ├── src/db/users.ts
 * ├── src/env.ts
 * ├── src/http/responses.ts
 * └── src/log/logger.ts
 * External: none
 *
 * Used by:
 * src/http/context.ts
 * ├── src/audit/audit.ts
 * ├── src/auth/access-jwt.ts
 * ├── src/auth/authorize.ts
 * ├── src/auth/identity.ts
 * ├── src/auth/machine-signature.ts
 * ├── src/http/body.ts
 * ├── src/http/pipeline.ts
 * ├── src/http/routes.ts
 * ├── src/provisioning/context.ts
 * ├── src/scheduled/purge.ts
 * ├── src/scheduled/tasks.ts
 * ├── src/security/data-key.ts
 * ├── src/security/rate-limit.ts
 * ├── test/audit.test.ts
 * ├── test/body.test.ts
 * ├── test/helpers/app.ts
 * └── test/machine-signature.test.ts
 * <module-headers:end>
 */
import type { Env } from "../env.ts";
import type { Logger } from "../log/logger.ts";
import type { MachineRow } from "../db/machines.ts";
import type { UserRow } from "../db/users.ts";
import { HttpError } from "./responses.ts";

/** Who performed an action, as the audit log records it. */
export type Actor =
  | { kind: "user"; id: string; email: string }
  | { kind: "admin"; id: string; email: string }
  | { kind: "machine"; id: string | null }
  | { kind: "system" }
  | { kind: "setup" };

/** The verified Access claims this Worker relies on. */
export interface AccessClaims {
  email: string;
  sub: string;
  exp: number;
}

export type Identity =
  | { kind: "anonymous" }
  | { kind: "setup" }
  | { kind: "user"; user: UserRow; claims: AccessClaims }
  | { kind: "machine"; machineId: string | null; machine: MachineRow | null; protocol: number };

/** What request handlers and cron tasks share. */
export interface AppContext {
  env: Env;
  db: D1Database;
  log: Logger;
  /** Unix seconds. */
  now(): number;
  requestId: string;
  ip: string | null;
  country: string | null;
  actor(): Actor;
  /** Defers work past the response (ExecutionContext.waitUntil). */
  waitUntil(promise: Promise<unknown>): void;
}

export interface RequestContext extends AppContext {
  request: Request;
  url: URL;
  /** The matched route's path pattern, for logs. */
  route: string | null;
  params: Record<string, string>;
  /** The raw request body, read once and size-capped; empty for bodiless requests. */
  body: Uint8Array;
  identity: Identity;
  /** The negotiated protocol version, or null where the route does not negotiate. */
  protocol: number | null;
}

/** The actor a given identity acts as. */
export function actorOf(identity: Identity): Actor {
  switch (identity.kind) {
    case "anonymous":
      return { kind: "system" };
    case "setup":
      return { kind: "setup" };
    case "user":
      return { kind: identity.user.role === "admin" ? "admin" : "user", id: identity.user.id, email: identity.user.email };
    case "machine":
      return { kind: "machine", id: identity.machineId };
  }
}

export function requireUser(ctx: RequestContext): Extract<Identity, { kind: "user" }> {
  if (ctx.identity.kind !== "user") throw new HttpError("internal", "This route was reached without a user identity.");
  return ctx.identity;
}

export function requireAdmin(ctx: RequestContext): Extract<Identity, { kind: "user" }> {
  const id = requireUser(ctx);
  if (id.user.role !== "admin") throw new HttpError("internal", "This route was reached without an admin identity.");
  return id;
}

export function requireMachine(ctx: RequestContext): Extract<Identity, { kind: "machine" }> {
  if (ctx.identity.kind !== "machine") throw new HttpError("internal", "This route was reached without a machine identity.");
  return ctx.identity;
}
