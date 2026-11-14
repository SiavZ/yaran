/**
 * Phase 07's wiring surface: every route row and cron task this phase adds.
 *
 * Phase 04's route table appends `PHASE07_ROUTE_TABLE` (its pipeline runs the host lock,
 * the rate limits, the auth class and the JSON/CSRF rules before a handler), and its task
 * registry appends `PHASE07_TASKS` (from `admin/scheduled-jobs.ts`).
 *
 * <module-headers:begin>
 * Uses:
 * src/phase07.ts
 * ├── src/admin-api/routes.ts
 * ├── src/console/admin-routes.ts
 * ├── src/console/route-types.ts
 * ├── src/console/routes.ts
 * ├── src/http/routes.ts
 * ├── src/routes/phase07-context.ts
 * └── src/setup/routes.ts
 * External: none
 *
 * Used by:
 * src/phase07.ts
 * ├── src/http/routes.ts
 * └── test/console.test.ts
 * <module-headers:end>
 */
import { ADMIN_API_ROUTES } from "./admin-api/routes.ts";
import { ADMIN_ROUTES } from "./console/admin-routes.ts";
import type { RouteRow } from "./console/route-types.ts";
import { USER_ROUTES } from "./console/routes.ts";
import type { Route } from "./http/routes.ts";
import { toRoute07 } from "./routes/phase07-context.ts";
import { SETUP_ROUTES } from "./setup/routes.ts";

/** Phase 07's rows in 07's handler shape; `PHASE07_ROUTE_TABLE` is them as 04 routes. */
export const PHASE07_ROUTES: readonly RouteRow[] = [...SETUP_ROUTES, ...USER_ROUTES, ...ADMIN_ROUTES, ...ADMIN_API_ROUTES];

export const PHASE07_ROUTE_TABLE: readonly Route[] = PHASE07_ROUTES.map(toRoute07);
