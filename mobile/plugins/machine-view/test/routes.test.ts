/**
 * Pins the TypeScript agent-route grammar to the shared `fixtures/routes.json`.
 *
 * The Kotlin and Swift `RouteFragment` twins read the same file, so the route the shell
 * builds and the route the native window accepts cannot disagree.
 *
 * - Pure; no Capacitor.
 *
 * <module-headers:begin>
 * Uses:
 * test/routes.test.ts
 * ├── mobile/plugins/machine-view/fixtures/routes.json
 * └── src/routes.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in the plugin package)
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import routes from "../fixtures/routes.json" with { type: "json" };
import { agentRoute, isAgentRoute } from "../src/routes.ts";

describe("isAgentRoute", () => {
  it.each(routes.cases.map((c) => [JSON.stringify(c.route), c] as const))("%s", (_, c) => {
    expect(isAgentRoute(c.route)).toBe(c.expect);
  });
});

describe("agentRoute", () => {
  it("builds routes the grammar accepts", () => {
    expect(agentRoute("abc")).toBe("#/agent/abc");
    expect(agentRoute("sess one", "t/2")).toBe("#/agent/sess%20one/tab/t%2F2");
    for (const id of ["a", "x".repeat(128), "~!*'()", "% #?&"]) expect(isAgentRoute(agentRoute(id, id))).toBe(true);
  });

  it("refuses ids that are not YaranIds", () => {
    for (const bad of ["", "x".repeat(129), "é", "a\nb", "\u0000"]) expect(() => agentRoute(bad)).toThrow();
  });
});
