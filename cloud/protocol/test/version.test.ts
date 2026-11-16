/**
 * Pins protocol negotiation and deprecation lookup to `fixtures/version/negotiate.json`
 * (Design §3); the Rust suite reads the same table.
 *
 * <module-headers:begin>
 * Uses:
 * test/version.test.ts
 * ├── src/version.ts
 * └── test/fixtures.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/protocol and cloud-protocol.yml)
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import { deprecationFor, negotiate, PROTOCOL_MAX, PROTOCOL_MIN } from "../src/version.ts";
import { fixture } from "./fixtures.ts";

describe("protocol negotiation", () => {
  const table = fixture("version/negotiate.json");
  for (const c of table.cases) {
    it(c.name, () => {
      const result = negotiate(c.client, c.server);
      if ("version" in c.expect) {
        expect(result).toEqual({ ok: true, version: c.expect.version });
        if (result.ok) expect(deprecationFor(result.version, c.deprecations)).toEqual(c.deprecated);
      } else {
        expect(result).toEqual({ ok: false, code: "protocol_unsupported", update: c.expect.update });
      }
    });
  }

  it("this build speaks protocol 1", () => {
    expect([PROTOCOL_MIN, PROTOCOL_MAX]).toEqual([1, 1]);
  });
});
