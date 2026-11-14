/**
 * Phase 06's route rows in one list, for 04's route table: pairing, the machine API, the
 * control-plane handoff, the user API, the device registry and `/v1/meta`.
 *
 * Integration wiring is one spread of `PHASE06_ROUTES` into 04's `http/routes.ts`.
 *
 * - Every machine path matches `^/v1/machine/[a-z]+$` and none is the bare prefix, so the
 *   single `/v1/machine/*` Access override covers all of them (R8; tested).
 *
 * <module-headers:begin>
 * Uses:
 * src/routes/pairing-and-sessions.ts
 * ├── src/machine-api/claim.ts
 * ├── src/machine-api/config.ts
 * ├── src/machine-api/origin.ts
 * ├── src/machine-api/rotate.ts
 * ├── src/machine-api/unpair.ts
 * ├── src/me/devices-route.ts
 * ├── src/me/machines-route.ts
 * ├── src/me/me-route.ts
 * ├── src/pairing/authorize-route.ts
 * ├── src/routes/meta.ts
 * ├── src/seams/context.ts
 * └── src/sessions/handoff-route.ts
 * External: none
 *
 * Used by:
 * src/routes/pairing-and-sessions.ts
 * ├── test/pairing/audit-coverage.test.ts
 * ├── test/pairing/pair-helpers.ts
 * └── test/routes.test.ts
 * <module-headers:end>
 */
import { CLAIM_ROUTE } from "../machine-api/claim.ts";
import { CONFIG_ROUTE } from "../machine-api/config.ts";
import { ORIGIN_ROUTE } from "../machine-api/origin.ts";
import { ROTATE_ROUTE } from "../machine-api/rotate.ts";
import { UNPAIR_ROUTE } from "../machine-api/unpair.ts";
import { DEVICE_ROUTES } from "../me/devices-route.ts";
import { MY_MACHINE_ROUTES } from "../me/machines-route.ts";
import { ME_ROUTES } from "../me/me-route.ts";
import { PAIR_AUTHORIZE_ROUTES } from "../pairing/authorize-route.ts";
import type { RouteRow } from "../seams/context.ts";
import { HANDOFF_ROUTES } from "../sessions/handoff-route.ts";
import { META_ROUTES } from "./meta.ts";

export const PHASE06_ROUTES: readonly RouteRow[] = [
  ...META_ROUTES,
  ...PAIR_AUTHORIZE_ROUTES,
  CLAIM_ROUTE,
  CONFIG_ROUTE,
  ROTATE_ROUTE,
  UNPAIR_ROUTE,
  ORIGIN_ROUTE,
  ...HANDOFF_ROUTES,
  ...ME_ROUTES,
  ...MY_MACHINE_ROUTES,
  ...DEVICE_ROUTES,
];

/** 04 tier-2 buckets Phase 06 declares: per-user pairing attempts and handoffs per JWT sub. */
export const PHASE06_RATE_BUCKETS = {
  pair: { limit: 10, windowS: 600 },
  handoff: { limit: 20, windowS: 60 },
} as const;
