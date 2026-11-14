/**
 * The provisioning context adapter over the real foundation: D1, audit rows, settings and
 * the Cloudflare client's token and base URL.
 *
 * <module-headers:begin>
 * Uses:
 * test/prov-context.test.ts
 * ├── src/db/client.ts
 * ├── src/db/settings.ts
 * ├── src/provisioning/context.ts
 * ├── test/helpers/app.ts
 * └── test/helpers/seed.ts
 * External: cloudflare:test, vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all } from "../src/db/client.ts";
import { setSetting } from "../src/db/settings.ts";
import { appCallbackUrls, provCtx } from "../src/provisioning/context.ts";
import { appCtx } from "./helpers/app.ts";
import { NOW } from "./helpers/seed.ts";

describe("provCtx", () => {
  it("reads stored settings only, omitting absent keys", async () => {
    await setSetting(env.DB, "drift_machines_per_run", 3, null, NOW);
    expect(await provCtx(appCtx()).settings.getMany(["drift_machines_per_run", "orphan_grace_minutes", "zone_id"])).toEqual({ drift_machines_per_run: 3 });
  });

  it("writes provisioning audit events through 04's audit log", async () => {
    await provCtx(appCtx()).audit({ action: "machine.reconciled", target: { kind: "org", id: null }, outcome: "ok", detail: { tasks: ["cf_status"] } });
    const rows = await all<{ action: string; actor_kind: string; target_kind: string; target_id: string | null; request_id: string }>(env.DB,
      "SELECT action, actor_kind, target_kind, target_id, request_id FROM audit_log");
    expect(rows).toEqual([{ action: "machine.reconciled", actor_kind: "system", target_kind: "org", target_id: null, request_id: "test" }]);
  });

  it("sends the API token to the configured base URL", async () => {
    const seen: Request[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(input, init));
      return Response.json({ success: true, errors: [], messages: [], result: { id: "z" } });
    }) as typeof fetch;
    const ctx = provCtx(appCtx({ CF_API_BASE_URL: "https://cf.test/client/v4" }), fetcher);
    await ctx.cf.request("GET", "/zones/z", { priority: "interactive" });
    expect(seen[0]!.url).toBe("https://cf.test/client/v4/zones/z");
    expect(seen[0]!.headers.get("authorization")).toBe(`Bearer ${env.CF_API_TOKEN}`);
  });

  it("splits APP_CALLBACK_URLS on whitespace", () => {
    expect(appCallbackUrls(" https://a.example/cb  https://b.example/cb\n")).toEqual(["https://a.example/cb", "https://b.example/cb"]);
    expect(appCallbackUrls(undefined)).toEqual([]);
  });
});
