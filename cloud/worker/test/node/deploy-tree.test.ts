/**
 * The deploy-tree assembler: a self-contained tree that meets the Deploy button's rules,
 * with exactly the three D20 secrets, D19's wrangler flags, the callbacks from
 * publisher.json and the commented CF_API_BASE_URL; and the release manifest step.
 * `YARAN_DEPLOY_DRY_RUN=1` also runs npm ci, build and `wrangler deploy --dry-run` in a copy.
 *
 * <module-headers:begin>
 * Uses:
 * test/node/deploy-tree.test.ts
 * ├── scripts/assemble-deploy-tree.ts
 * ├── scripts/update/merge-wrangler.ts
 * ├── src/update/release-manifest.ts
 * └── test/node/helpers/tree.ts
 * External: node:child_process, node:fs, node:os, node:path, vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { callbackUrls, writeManifest } from "../../scripts/assemble-deploy-tree.ts";
import { assembleAt, WORKER } from "./helpers/tree.ts";
import { parseJsonc } from "../../scripts/update/merge-wrangler.ts";
import { parseManifest } from "../../src/update/release-manifest.ts";

const files = (root: string, dir = root): string[] =>
  readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? (n === "node_modules" ? [] : files(root, join(dir, n))) : [relative(root, join(dir, n))]));

let tree = "";
beforeAll(() => {
  tree = assembleAt("yaran-cloud-v1.2.3");
}, 60_000);

describe("assembled tree", () => {
  test("has the Deploy button's minimum keys and no binding ids", () => {
    const w = parseJsonc(readFileSync(join(tree, "wrangler.jsonc"), "utf8"), "tree");
    expect(w).toMatchObject({ name: "yaran-cloud", main: "src/index.ts", compatibility_date: expect.any(String) });
    expect(JSON.stringify(w.d1_databases)).not.toContain("database_id");
  });
  test("keeps workers.dev on, previews off, and no routes or custom domain (D19)", () => {
    const w = parseJsonc(readFileSync(join(tree, "wrangler.jsonc"), "utf8"), "tree");
    expect(w.workers_dev).toBe(true);
    expect(w.preview_urls).toBe(false);
    expect(w.routes).toEqual([]);
    expect(JSON.stringify(w)).not.toMatch(/custom_domain|zone_name|"pattern"/);
  });
  test(".dev.vars.example lists exactly the three D20 secrets", () => {
    const names = readFileSync(join(tree, ".dev.vars.example"), "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => l.split("=")[0]);
    expect(names).toEqual(["CF_API_TOKEN", "SETUP_CODE", "DATA_KEY"]);
  });
  test("APP_CALLBACK_URLS comes from publisher.json; CF_API_BASE_URL defaults with its comment", () => {
    const text = readFileSync(join(tree, "wrangler.jsonc"), "utf8");
    const w = parseJsonc(text, "tree") as { vars: Record<string, string> };
    expect(w.vars.APP_CALLBACK_URLS).toBe(callbackUrls("app.example.org"));
    expect(w.vars.APP_CALLBACK_URLS).toBe("https://app.example.org/auth/callback");
    expect(w.vars.CF_API_BASE_URL).toBe("https://api.cloudflare.com/client/v4");
    expect(text).toMatch(/\/\/ The Cloudflare API base URL[^\n]*\n[^\n]*staging[^\n]*\n\s*"CF_API_BASE_URL"/);
    expect(text).not.toContain("yaranapp://auth/callback\"");
  });
  test("no import resolves outside the tree", () => {
    for (const f of files(tree).filter((p) => /\.(ts|tsx|js|mjs)$/.test(p))) {
      const src = readFileSync(join(tree, f), "utf8");
      for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
        const spec = m[1]!;
        if (spec.startsWith(".")) expect(resolve(dirname(join(tree, f)), spec).startsWith(tree), `${f} imports ${spec}`).toBe(true);
        else expect(spec, `${f} imports ${spec}`).not.toMatch(/^\/|cloud\/protocol|packages\//);
      }
    }
    const pkg = JSON.parse(readFileSync(join(tree, "package.json"), "utf8"));
    expect(pkg.dependencies["@yaran/protocol"]).toBe("file:vendor/cloud-protocol");
    for (const spec of Object.values({ ...pkg.dependencies, ...pkg.devDependencies }) as string[]) expect(spec).not.toMatch(/\.\.\//);
  });
  test("bundles the protocol as built JS and the ui-kit tokens, and stamps the version", () => {
    expect(existsSync(join(tree, "vendor/cloud-protocol/dist/src/index.js"))).toBe(true);
    expect(existsSync(join(tree, "vendor/cloud-protocol/dist/schemas/admin.schema.json"))).toBe(true);
    expect(readFileSync(join(tree, "assets/console/tokens.css"), "utf8")).toBe(":root { --background: x; }\n");
    expect(readFileSync(join(tree, "src/update/worker-version.ts"), "utf8")).toContain('"1.2.3"');
  });
  test("lists every upstream-owned file, and wrangler.jsonc is not one of them", () => {
    const list = JSON.parse(readFileSync(join(tree, "upstream-files.json"), "utf8")) as string[];
    expect(list).toContain(".github/workflows/yaran-cloud-update.yml");
    expect(list).toContain(".yaran/wrangler.template.jsonc");
    expect(list).not.toContain("wrangler.jsonc");
    expect(new Set(list)).toEqual(new Set(files(tree).filter((f) => f !== "wrangler.jsonc" && f !== "upstream-files.json")));
  });
  test("the deploy script applies migrations before deploying", () => {
    const pkg = JSON.parse(readFileSync(join(tree, "package.json"), "utf8"));
    expect(pkg.scripts.deploy).toBe("npm run db:migrations:apply && wrangler deploy");
    expect(pkg.scripts["db:migrations:apply"]).toBe("wrangler d1 migrations apply DB --remote");
  });
});

test("writes a release manifest that validates", () => {
  const m = writeManifest(tree, "yaran-cloud-v1.2.3", "a".repeat(64), { security: true, minUpdateFrom: "1.0.0", now: new Date("2026-11-14T12:00:00.123Z") });
  expect(parseManifest(JSON.parse(readFileSync(join(tree, "release.json"), "utf8"))).ok).toBe(true);
  expect(m).toMatchObject({ version: "1.2.3", released_at: "2026-11-14T12:00:00Z", tarball: { url: "https://github.com/SiavZ/yaran/releases/download/yaran-cloud-v1.2.3/yaran-cloud-worker-v1.2.3.tar.gz" } });
});

test("main holds no vendored protocol and no generated theme", () => {
  const tracked = execFileSync("git", ["ls-files", "cloud/worker"], { cwd: join(WORKER, "../.."), encoding: "utf8" });
  expect(tracked).not.toMatch(/vendor\/cloud-protocol|assets\/console\/tokens\.css/);
});

test.skipIf(!process.env.YARAN_DEPLOY_DRY_RUN)("the tree installs, builds and dry-run deploys with nothing from outside it", () => {
  const out = mkdtempSync(join(tmpdir(), "drytree-"));
  const t = assembleAt("yaran-cloud-v1.2.3", out, true);
  const sandbox = mkdtempSync(join(tmpdir(), "sandbox-"));
  cpSync(t, sandbox, { recursive: true });
  // Until Phase 04's src/index.ts lands, a stand-in entry bundles every Phase 07 route.
  if (!existsSync(join(sandbox, "src/index.ts"))) {
    writeFileSync(join(sandbox, "src/index.ts"), 'import { PHASE07_ROUTES } from "./phase07.ts";\nexport default { fetch: () => new Response(String(PHASE07_ROUTES.length)) };\n');
  }
  for (const args of [["ci"], ["run", "build"], ["exec", "--", "wrangler", "deploy", "--dry-run", "--outdir", join(out, "dist")]]) execFileSync("npm", args, { cwd: sandbox, stdio: "inherit" });
  expect(existsSync(join(out, "dist/index.js"))).toBe(true);
}, 600_000);
