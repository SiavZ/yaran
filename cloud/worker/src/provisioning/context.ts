/**
 * Builds the provisioning engine's `ProvCtx` from the Worker foundation's `AppContext`.
 *
 * This is the one place the ports in `ports.ts` meet 04's real modules: D1, the audit writer,
 * the logger, the sanitizer, the settings store and a Cloudflare client over global `fetch`
 * with the `CF_API_TOKEN` secret. Request handlers (06, 07) and the cron task rows call
 * `provCtx(ctx)` once per request or run.
 *
 * - The token is read here and handed only to the client; it is never logged or stored.
 * - A fresh `ApiBudget` per context, so each invocation flushes its own observation.
 *
 * <module-headers:begin>
 * Uses:
 * src/provisioning/context.ts
 * ├── src/audit/audit.ts
 * ├── src/cloudflare/budget.ts
 * ├── src/cloudflare/client.ts
 * ├── src/db/settings.ts
 * ├── src/http/context.ts
 * ├── src/provisioning/ports.ts
 * └── src/security/sanitize.ts
 * External: none
 *
 * Used by:
 * src/provisioning/context.ts
 * ├── src/reconcile/tasks.ts
 * ├── src/routes/phase06-context.ts
 * ├── src/sessions/handoff-route.ts
 * └── test/prov-context.test.ts
 * <module-headers:end>
 */
import { record } from "../audit/audit.ts";
import { ApiBudget } from "../cloudflare/budget.ts";
import { CfClient, resolveCfBaseUrl } from "../cloudflare/client.ts";
import { getStoredSettings } from "../db/settings.ts";
import type { AppContext } from "../http/context.ts";
import { forTerminal } from "../security/sanitize.ts";
import type { AuditEvent, ProvCtx } from "./ports.ts";

export const CF_USER_AGENT = "yaran-cloud";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The https callbacks from the `APP_CALLBACK_URLS` deploy variable (space separated). */
export function appCallbackUrls(raw: string | undefined): string[] {
  return (raw ?? "").split(/\s+/).filter((u) => u !== "");
}

function auditPort(ctx: AppContext) {
  return (e: AuditEvent) =>
    record(ctx, {
      action: e.action,
      target: { kind: e.target.kind, ...(e.target.id ? { id: e.target.id } : {}) },
      outcome: e.outcome,
      ...(e.error_code ? { errorCode: e.error_code } : {}),
      ...(e.detail ? { detail: e.detail } : {}),
    });
}

export function provCtx(ctx: AppContext, fetcher: typeof fetch = (input, init) => fetch(input, init)): ProvCtx {
  const now = () => ctx.now();
  const actor = ctx.actor();
  return {
    db: ctx.db,
    cf: new CfClient({
      fetch: fetcher,
      token: ctx.env.CF_API_TOKEN ?? "",
      baseUrl: resolveCfBaseUrl(ctx.env.CF_API_BASE_URL),
      budget: new ApiBudget(ctx.db, now),
      userAgent: CF_USER_AGENT,
      sleep,
    }),
    audit: auditPort(ctx),
    log: ctx.log,
    sanitize: forTerminal,
    settings: { getMany: (keys) => getStoredSettings(ctx.db, keys) },
    actor: { kind: actor.kind, id: "id" in actor ? actor.id : null },
    now,
    sleep,
    appCallbackUrls: appCallbackUrls(ctx.env.APP_CALLBACK_URLS),
  };
}
