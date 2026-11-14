/**
 * The deployer-side update job: merge-wrangler's ownership rules, fetch-release's refusals,
 * and an end-to-end v1.0.0 → v1.1.0 update of an assembled tree in a temp git repository.
 *
 * <module-headers:begin>
 * Uses:
 * test/update-job.test.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── cloud/protocol/fixtures/api/ReleaseManifest.json
 * ├── scripts/assemble-deploy-tree.ts
 * ├── scripts/update/fetch-release.ts
 * ├── scripts/update/merge-wrangler.ts
 * ├── scripts/update/update.ts
 * ├── src/update/release-manifest.ts
 * └── test/helpers/tree.ts
 * External: node:child_process, node:fs, node:os, node:path, vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker)
 * <module-headers:end>
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import fixtures from "@yaran/protocol/fixtures/api/ReleaseManifest.json" with { type: "json" };
import type { ReleaseManifest } from "@yaran/protocol";
import { writeManifest } from "../scripts/assemble-deploy-tree.ts";
import { checkStartingPoint, downloadVerified, sha256Hex } from "../scripts/update/fetch-release.ts";
import { mergeWrangler, parseJsonc } from "../scripts/update/merge-wrangler.ts";
import { runUpdate } from "../scripts/update/update.ts";
import { RAW_MANIFEST_URL } from "../src/update/release-manifest.ts";
import { assembleAt } from "./helpers/tree.ts";

const TEMPLATE = readFileSync(new URL("../deploy-template/wrangler.template.jsonc", import.meta.url), "utf8");
const tpl = (cb: string) => TEMPLATE.replace('"__APP_CALLBACK_URLS__"', JSON.stringify(cb));
const OLD_CB = "https://app.example.org/auth/callback";
const NEW_CB = "https://app2.example.org/auth/callback";

describe("merge-wrangler", () => {
  const current = (vars: Record<string, string>, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ name: "acme-cp", account_id: "acc1", main: "src/index.ts", workers_dev: true, preview_urls: true, routes: [{ pattern: "x.example.org/*", zone_name: "example.org" }], d1_databases: [{ binding: "DB", database_name: "acme-db", database_id: "uuid-1" }], vars, ...extra });

  test("keeps every deployer-owned value and lists what it kept", () => {
    const out = mergeWrangler({ current: current({ APP_CALLBACK_URLS: OLD_CB, CF_API_BASE_URL: "https://proxy.example/v4", MY_FLAG: "1" }, { limits: { cpu_ms: 50 } }), template: tpl(NEW_CB), previousTemplate: tpl(OLD_CB), setupClosed: false });
    const w = parseJsonc(out.text, "out") as Record<string, any>;
    expect(w).toMatchObject({ name: "acme-cp", account_id: "acc1", routes: [{ pattern: "x.example.org/*" }], d1_databases: [{ binding: "DB", database_name: "acme-db", database_id: "uuid-1", migrations_dir: "migrations" }], limits: { cpu_ms: 50 } });
    expect(w.vars).toEqual({ APP_CALLBACK_URLS: NEW_CB, CF_API_BASE_URL: "https://proxy.example/v4", MY_FLAG: "1" });
    expect(out.preserved).toEqual(["name", "account_id", "d1_databases.DB.database_id", "d1_databases.DB.database_name", "routes", "vars.CF_API_BASE_URL"]);
    expect(out.unknown).toEqual(["vars.MY_FLAG", "limits"]);
    expect(out.text).toContain("// The Cloudflare API base URL");
  });
  test("APP_CALLBACK_URLS: a deployer change from the previous default is kept and listed", () => {
    const out = mergeWrangler({ current: current({ APP_CALLBACK_URLS: `${OLD_CB},https://fork.example/auth/callback` }), template: tpl(NEW_CB), previousTemplate: tpl(OLD_CB), setupClosed: false });
    expect((parseJsonc(out.text, "o") as any).vars.APP_CALLBACK_URLS).toBe(`${OLD_CB},https://fork.example/auth/callback`);
    expect(out.preserved).toContain("vars.APP_CALLBACK_URLS");
  });
  test("flips workers_dev only once setup is closed, and never allows preview URLs", () => {
    const open = parseJsonc(mergeWrangler({ current: current({}), template: tpl(NEW_CB), previousTemplate: null, setupClosed: false }).text, "o");
    expect(open.workers_dev).toBe(true);
    expect(open.preview_urls).toBe(false);
    const closed = parseJsonc(mergeWrangler({ current: current({}), template: tpl(NEW_CB), previousTemplate: null, setupClosed: true }).text, "o");
    expect(closed.workers_dev).toBe(false);
  });
  test("adds no route of its own", () => {
    const out = mergeWrangler({ current: JSON.stringify({ name: "yaran-cloud" }), template: tpl(NEW_CB), previousTemplate: null, setupClosed: true });
    expect((parseJsonc(out.text, "o") as any).routes).toEqual([]);
  });
});

const MANIFEST = fixtures.valid[0]!.value as ReleaseManifest;

describe("fetch-release", () => {
  test("refuses skipping past min_update_from and names the stepping stone", () => {
    expect(() => checkStartingPoint("0.9.0", MANIFEST)).toThrow(/update to 1\.0\.0 first/);
    expect(checkStartingPoint("1.0.0", MANIFEST)).toBe("update");
    expect(checkStartingPoint("1.2.0", MANIFEST)).toBe("up_to_date");
  });
  test("refuses a tarball whose SHA-256 does not match", async () => {
    const bytes = new TextEncoder().encode("tarball");
    const f = (sum: string) => (async (u: RequestInfo | URL) => (String(u).endsWith(".sha256") ? new Response(`${sum}  worker.tar.gz\n`) : new Response(bytes))) as typeof fetch;
    const good = { ...MANIFEST, tarball: { ...MANIFEST.tarball, sha256: sha256Hex(bytes) } };
    expect(await downloadVerified(f(sha256Hex(bytes)), good)).toEqual(bytes);
    await expect(downloadVerified(f("0".repeat(64)), good)).rejects.toThrow(/does not match/);
    await expect(downloadVerified(f(sha256Hex(bytes)), MANIFEST)).rejects.toThrow(/does not match/);
  });
});

test("end to end: v1.0.0 → v1.1.0 replaces upstream files, keeps the deployer's, and commits on a branch", async () => {
  const v1 = assembleAt("yaran-cloud-v1.0.0");
  writeManifest(v1, "yaran-cloud-v1.0.0", "a".repeat(64), { security: false });
  const repo = mkdtempSync(join(tmpdir(), "deployer-"));
  cpSync(v1, repo, { recursive: true });
  // The deployer's own state: a database id written by the button, a file of their own.
  const wr = readFileSync(join(repo, "wrangler.jsonc"), "utf8").replace('"migrations_dir"', '"database_id": "db-uuid", "migrations_dir"');
  writeFileSync(join(repo, "wrangler.jsonc"), wr);
  writeFileSync(join(repo, "NOTES.md"), "mine\n");
  writeFileSync(join(repo, "src/stale-upstream.ts"), "export {};\n");
  const list = JSON.parse(readFileSync(join(repo, "upstream-files.json"), "utf8"));
  writeFileSync(join(repo, "upstream-files.json"), JSON.stringify([...list, "src/stale-upstream.ts"]));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "deploy");

  const v2out = mkdtempSync(join(tmpdir(), "v2-"));
  const v2 = assembleAt("yaran-cloud-v1.1.0", v2out);
  const tarball = join(v2out, "worker.tar.gz");
  execFileSync("tar", ["-czf", tarball, "-C", v2, "."]);
  const bytes = new Uint8Array(readFileSync(tarball));
  const manifest = writeManifest(v2, "yaran-cloud-v1.1.0", sha256Hex(bytes), { security: true, minUpdateFrom: "1.0.0" });
  const fetcher = (async (u: RequestInfo | URL) => {
    const url = String(u);
    if (url === RAW_MANIFEST_URL) return Response.json(manifest);
    if (url === manifest.tarball.url) return new Response(bytes);
    if (url === `${manifest.tarball.url}.sha256`) return new Response(`${manifest.tarball.sha256}\n`);
    if (url === "https://cp.example.org/v1/meta") return Response.json({ setup: "closed" });
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;

  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "t";
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "t@t";
  const out = await runUpdate({ repo, attest: false, fetcher, controlPlaneUrl: "https://cp.example.org" });
  expect(out?.branch).toBe("yaran-cloud-update/v1.1.0");
  expect(git("log", "-1", "--format=%s")).toBe("Update yaran control plane to v1.1.0\n");
  expect(readFileSync(join(repo, "src/update/worker-version.ts"), "utf8")).toContain('"1.1.0"');
  expect(readFileSync(join(repo, "NOTES.md"), "utf8")).toBe("mine\n");
  expect(existsSync(join(repo, "src/stale-upstream.ts"))).toBe(false);
  const w = parseJsonc(readFileSync(join(repo, "wrangler.jsonc"), "utf8"), "merged") as any;
  expect(w.d1_databases[0].database_id).toBe("db-uuid");
  expect(w.workers_dev).toBe(false);
  expect(JSON.parse(readFileSync(join(repo, "release.json"), "utf8")).version).toBe("1.1.0");
  expect(out?.body).toContain("Security fix: **yes, merge soon**");
  expect(out?.body).toContain("d1_databases.DB.database_id");
  const changed = git("diff", "--name-only", "main").trim().split("\n");
  expect(changed).toEqual(expect.arrayContaining(["release.json", "src/stale-upstream.ts", "src/update/worker-version.ts", "upstream-files.json", "wrangler.jsonc"]));
  expect(changed).not.toContain("NOTES.md");
  expect(await runUpdate({ repo, attest: false, fetcher })).toBeNull();
  rmSync(repo, { recursive: true, force: true });
}, 120_000);
