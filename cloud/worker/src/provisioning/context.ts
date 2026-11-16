/**
 * Builds the provisioning engine's `ProvCtx` from the Worker foundation's `AppContext`.
 *
 * This is the one place the ports in `ports.ts` meet 04's real modules: D1, the audit writer,
 * the logger, the sanitizer, the settings store and a Cloudflare client over global `fetch`
 * with the `CF_API_TOKEN` secret. Request handlers (06, 07) and the cron task rows call
 * `provCtx(ctx)` once per request or run.
 *
 * - The token is the sealed copy setup stored in D1 (its one home after setup, 07), else the
 *   `CF_API_TOKEN` secret; it is resolved on the first call, handed only to the client,
 *   and never logged.
 * - A fresh `ApiBudget` per context, so each invocation flushes its own observation.
 *
 * <module-headers:begin>
 * Uses:
 * src/provisioning/context.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/admin/setup-settings.ts
 * ├── src/audit/audit.ts
 * ├── src/cloudflare/budget.ts
 * ├── src/cloudflare/client.ts
 * ├── src/db/settings.ts
 * ├── src/http/context.ts
 * ├── src/provisioning/ports.ts
 * ├── src/provisioning/provision-error.ts
 * ├── src/security/data-key.ts
 * └── src/security/sanitize.ts
 * External: none
 *
 * Used by:
 * src/provisioning/context.ts
 * ├── src/reconcile/tasks.ts
 * ├── src/routes/phase06-context.ts
 * ├── src/routes/phase07-context.ts
 * ├── src/sessions/handoff-route.ts
 * └── test/prov-context.test.ts
 * <module-headers:end>
 */
import { record } from "../audit/audit.ts";
import { ApiBudget } from "../cloudflare/budget.ts";
import { CfClient, resolveCfBaseUrl } from "../cloudflare/client.ts";
import { utf8Decode } from "@yaran/protocol";
import { API_TOKEN_AAD, API_TOKEN_KEY } from "../admin/setup-settings.ts";
import { getStoredSettings } from "../db/settings.ts";
import type { AppContext } from "../http/context.ts";
import { open } from "../security/data-key.ts";
import { forTerminal } from "../security/sanitize.ts";
import type { AuditEvent, ProvCtx } from "./ports.ts";
import { ProvisionError } from "./provision-error.ts";

export const CF_USER_AGENT = "yaran-cloud";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The https callbacks from the `APP_CALLBACK_URLS` deploy variable (space or comma separated). */
export function appCallbackUrls(raw: string | undefined): string[] {
  return (raw ?? "").split(/[\s,]+/).filter((u) => u !== "");
}

/** The stored (sealed) API token, else the deploy secret. */
export async function apiToken(ctx: AppContext): Promise<string> {
  const sealed = (await getStoredSettings(ctx.db, [API_TOKEN_KEY]))[API_TOKEN_KEY] as string | undefined;
  const token = sealed ? utf8Decode(await open(ctx, "cf_api_token", API_TOKEN_AAD, sealed)) : ctx.env.CF_API_TOKEN;
  if (!token) throw new ProvisionError("setup_incomplete", "No Cloudflare API token is stored or set; finish the setup token step or set the CF_API_TOKEN secret.");
  return token;
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
      token: () => apiToken(ctx),
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
