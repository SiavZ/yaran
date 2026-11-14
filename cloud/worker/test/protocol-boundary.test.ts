/**
 * The assembler contract (D18): nothing in `cloud/worker/` reaches outside the package
 * except the one `@yaran/protocol` dependency, so Phase 07's deploy-tree assembler only
 * has to rewrite that one line. Also: no vendored protocol copy exists on main.
 *
 * Files are read through Vite's `import.meta.glob` (the tests run inside workerd, which
 * has no filesystem).
 *
 * <module-headers:begin>
 * Uses:
 * test/protocol-boundary.test.ts
 * └── cloud/worker/package.json
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import pkg from "../package.json";

const files: Record<string, string> = {
  ...import.meta.glob(["/src/**/*.ts", "/test/**/*.ts", "/migrations/*.sql", "/*.{ts,js,json,jsonc,toml}", "/.dev.vars.example", "/.npmrc", "/vendor/**"],
    { query: "?raw", import: "default", eager: true }),
};

const ROOT = "file:///pkg";
const SPEC_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g;

describe("protocol boundary", () => {
  it("found the package's files", () => {
    expect(Object.keys(files)).toEqual(expect.arrayContaining(["/src/index.ts", "/wrangler.jsonc", "/package.json", "/tsconfig.json"]));
  });

  it("imports nothing by a path outside cloud/worker", () => {
    const escapes: string[] = [];
    for (const [path, text] of Object.entries(files)) {
      if (path === "/package-lock.json" || path === "/worker-configuration.d.ts") continue;
      for (const [, spec] of text.matchAll(SPEC_RE)) {
        if (!spec!.startsWith(".") && !spec!.startsWith("/")) continue;
        if (!new URL(spec!, `${ROOT}${path}`).href.startsWith(`${ROOT}/`)) escapes.push(`${path}: ${spec}`);
      }
      if (!path.endsWith(".ts") && /["'(\s]\.\.\//.test(text)) escapes.push(`${path}: a ../ path`);
    }
    expect(escapes).toEqual([]);
  });

  it("depends on exactly one package outside itself: @yaran/protocol via file:../protocol", () => {
    const all = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>;
    const local = Object.entries(all).filter(([, v]) => /^(file|link|workspace|portal):/.test(v) || v.startsWith("."));
    expect(local).toEqual([["@yaran/protocol", "file:../protocol"]]);
  });

  it("ships no vendored protocol copy", () => {
    expect(Object.keys(files).some((p) => p.startsWith("/vendor/") || /protocol/.test(p.split("/")[1] ?? ""))).toBe(false);
  });
});
