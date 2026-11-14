/**
 * Pins the handoff redirect allowlist (Design §8) to `fixtures/uri/handoff-redirect.json`:
 * release builds accept only the configured https callback, byte for byte; the custom
 * scheme only with build=dev.
 *
 * <module-headers:begin>
 * Uses:
 * test/redirect.test.ts
 * ├── src/redirect.ts
 * └── test/fixtures.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test)
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import { redirectAllowed } from "../src/redirect.ts";
import { fixture } from "./fixtures.ts";

describe("handoff redirect allowlist", () => {
  const f = fixture("uri/handoff-redirect.json");
  for (const c of f.cases) {
    it(`${c.build ?? "(absent)"} ${c.redirect}`, () => {
      expect(redirectAllowed(c.redirect, c.build ?? undefined, f.configured)).toBe(c.expect);
    });
  }
});
