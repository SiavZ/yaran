/**
 * Phase 07's wiring surface: every route row and cron task this phase adds.
 *
 * Phase 04's route table appends `PHASE07_ROUTES` (its pipeline runs the host lock, the
 * rate limits, the auth class and the JSON/CSRF rules before a handler), and its task
 * registry appends `PHASE07_TASKS`. This is the one import the integrator wires.
 */
import { ADMIN_API_ROUTES } from "./admin-api/routes.ts";
import { ADMIN_ROUTES } from "./console/admin-routes.ts";
import type { RouteRow } from "./console/route-types.ts";
import { USER_ROUTES } from "./console/routes.ts";
import { SETUP_ROUTES } from "./setup/routes.ts";

export { PHASE07_TASKS } from "./admin/scheduled-jobs.ts";
export { hostLock } from "./setup/host-lock.ts";
export { readSettings } from "./admin/settings-schema.ts";

export const PHASE07_ROUTES: readonly RouteRow[] = [...SETUP_ROUTES, ...USER_ROUTES, ...ADMIN_ROUTES, ...ADMIN_API_ROUTES];
