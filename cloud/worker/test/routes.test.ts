/**
 * Phase 06's route table: every machine route sits under the one `/v1/machine/*` public
 * override (02 §5, R8), nothing lives at the bare prefix, every row names an auth class
 * of the kind its path needs, and no (method, path) is declared twice.
 *
 * <module-headers:begin>
 * Uses:
 * test/routes.test.ts
 * ├── @yaran/protocol:src/index.ts
 * └── src/routes/pairing-and-sessions.ts
 * External: vitest
 *
 * Used by: entry point (vitest in the Workers pool, via npm test in cloud/worker)
 * <module-headers:end>
 */
import { MACHINE_PATH_RE } from "@yaran/protocol";
import { describe, expect, it } from "vitest";
import { PHASE06_ROUTES } from "../src/routes/pairing-and-sessions.ts";

describe("PHASE06_ROUTES", () => {
  it("puts every signed route under /v1/machine/<lowercase word> and nothing at the bare prefix", () => {
    for (const r of PHASE06_ROUTES) {
      expect(r.path).not.toBe("/v1/machine");
      if (r.auth.kind === "machine") expect(r.path).toMatch(MACHINE_PATH_RE);
      if (r.path.startsWith("/v1/machine")) expect(r.auth.kind).toBe("machine");
    }
  });
  it("serves /v1/meta alone as public; /v1/me/*, pairing and handoff need a user", () => {
    for (const r of PHASE06_ROUTES) {
      if (r.path === "/v1/meta") expect(r.auth.kind).toBe("public");
      else if (!r.path.startsWith("/v1/machine/")) expect(r.auth.kind).toBe("user");
    }
  });
  it("declares each method and path once", () => {
    const keys = PHASE06_ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(
      expect.arrayContaining([
        "GET /v1/meta", "GET /v1/pair/authorize", "POST /v1/pair/authorize", "POST /v1/machine/claim", "GET /v1/machine/config",
        "POST /v1/machine/rotate", "POST /v1/machine/unpair", "PUT /v1/machine/origin", "GET /v1/handoff", "POST /v1/handoff",
        "GET /v1/me", "GET /v1/me/machines", "DELETE /v1/me/machines/:id", "POST /v1/me/devices", "GET /v1/me/devices",
        "PATCH /v1/me/devices/:id", "DELETE /v1/me/devices/:id",
      ]),
    );
  });
});
