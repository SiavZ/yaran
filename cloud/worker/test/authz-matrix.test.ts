/**
 * The authorization matrix: every route row (production rows plus one probe per auth
 * class) × every identity kind × control-plane and workers.dev hosts × setup open and
 * closed. Each expectation is derived from the row's declared `auth`, so a route added by
 * any phase is covered the moment it is in the table.
 *
 * <module-headers:begin>
 * Uses:
 * test/authz-matrix.test.ts
 * ├── test/helpers/matrix.ts
 * └── test/helpers/worker.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { beforeAll, describe, expect, it } from "vitest";
import { expected, HOSTS, IDENTITIES, matrixFixture, send, setSetupState, type Fixture, type HostKind, type SetupKind } from "./helpers/matrix.ts";
import { ALL_ROUTES, errorCode } from "./helpers/worker.ts";

/** Codes that mean the request was refused before reaching its handler. */
const REFUSALS = new Set([
  "unauthenticated", "forbidden", "user_disabled", "service_token_rejected", "identity_unavailable", "setup_incomplete", "setup_closed",
  "misdirected_host", "signature_missing", "signature_invalid", "signature_expired", "nonce_replayed", "machine_unknown",
  "machine_revoked", "machine_not_ready", "pair_code_invalid", "protocol_unsupported", "origin_mismatch",
]);

let f: Fixture;
beforeAll(async () => {
  f = await matrixFixture();
});

for (const setup of ["open", "closed"] as SetupKind[]) {
  describe(`setup ${setup}`, () => {
    beforeAll(() => setSetupState(setup));
    for (const route of ALL_ROUTES) {
      it(`${route.method} ${route.path} (${route.auth.kind})`, async () => {
        for (const host of Object.keys(HOSTS) as HostKind[]) {
          for (const id of IDENTITIES) {
            const want = expected(route, id, host, setup);
            const res = await send(f, route, id, host);
            const code = res.status < 400 ? null : await errorCode(res);
            const label = `${id} on ${host}`;
            if (want === "ok") expect(code === null || !REFUSALS.has(code), `${label}: got ${code}`).toBe(true);
            else expect(code, label).toBe(want);
          }
        }
      });
    }
  });
}
