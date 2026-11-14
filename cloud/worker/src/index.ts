/**
 * Entry point of the yaran org control-plane Worker.
 *
 * `fetch` runs the request pipeline over the route table; `scheduled` runs the one cron
 * dispatcher. Both first make sure the D1 schema is current (the G11 fallback migrator,
 * a no-op once the database has every migration).
 *
 * Seams: Phase 06 passes its W4 pair-code key resolver here as
 * `createFetchHandler(ROUTES, { pairCodeKey })`; routes join through `http/routes.ts` and
 * cron tasks through `scheduled/tasks.ts`.
 *
 * <module-headers:begin>
 * Uses:
 * src/index.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/db/migrate-runtime.ts
 * ├── src/env.ts
 * ├── src/http/pipeline.ts
 * ├── src/http/responses.ts
 * ├── src/http/routes.ts
 * ├── src/log/logger.ts
 * ├── src/scheduled/dispatcher.ts
 * └── src/scheduled/tasks.ts
 * External: none
 *
 * Used by: entry point (Cloudflare Worker entry (wrangler.jsonc main), deployed with wrangler deploy or the Deploy to Cloudflare button)
 * src/index.ts
 * ├── test/dispatcher.test.ts
 * ├── test/migrate-runtime.test.ts
 * └── worker-configuration.d.ts
 * <module-headers:end>
 */
import { PROTOCOL_MAX } from "@yaran/protocol";
import { ensureMigrated } from "./db/migrate-runtime.ts";
import type { Env } from "./env.ts";
import { createFetchHandler } from "./http/pipeline.ts";
import { errorResponse, finalize, HttpError } from "./http/responses.ts";
import { ROUTES } from "./http/routes.ts";
import { createLogger } from "./log/logger.ts";
import { dispatch } from "./scheduled/dispatcher.ts";
import { TASKS } from "./scheduled/tasks.ts";

const handle = createFetchHandler(ROUTES);
const nowS = () => Math.floor(Date.now() / 1000);

async function schemaReady(env: Env): Promise<boolean> {
  if (env.RUNTIME_MIGRATIONS === "off") return true;
  try {
    await ensureMigrated(env.DB, createLogger({ event_source: "migrate" }), nowS);
    return true;
  } catch {
    return false;
  }
}

export default {
  async fetch(request, env, exec) {
    if (!(await schemaReady(env))) {
      const requestId = crypto.randomUUID().replaceAll("-", "");
      return finalize(errorResponse(new HttpError("unavailable", "The database schema is being updated; try again shortly."), "json", requestId),
        { requestId, protocol: PROTOCOL_MAX });
    }
    return handle(request, env, exec);
  },
  async scheduled(controller, env) {
    if (await schemaReady(env)) await dispatch(env, TASKS, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;
