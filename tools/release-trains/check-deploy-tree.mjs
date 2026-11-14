#!/usr/bin/env node
/**
 * Deploy-tree gate for the `yaran-cloud-v*` train: proves the generated tree that
 * becomes the `cloud-deploy` branch (D18) is self-contained, ships the D19 wrangler
 * config, and carries the publisher callback (02 §8).
 *
 * `--config-only <dir>` runs on every PR against `cloud/worker` (its `wrangler.jsonc`
 * and Phase 07's `deploy-template/wrangler.template.jsonc`). The full mode runs in
 * `release-cloud.yml` on `<out>/worker` after Phase 07's assembler.
 *
 * - Config: `workers_dev: true`, `preview_urls: false`, no route/routes or custom
 *   domain, no D1 `database_id`, in the top level and every `env.*` block.
 * - Self-contained: no `link:`, `workspace:` or `file:` dependency resolving outside the
 *   tree; the protocol is vendored at `vendor/cloud-protocol/`.
 * - Callbacks: `vars.APP_CALLBACK_URLS` equals `https://<publisher_domain>/auth/callback`.
 * - `--isolated-build` copies the tree to an empty temp directory outside the checkout
 *   and runs `npm ci`, `npm run build` and `wrangler deploy --dry-run` there (network).
 *
 * <module-headers:begin>
 * Uses:
 * check-deploy-tree.mjs
 * ├── lib/jsonc.mjs
 * ├── lib/repo.mjs
 * ├── lib/report.mjs
 * └── versions.mjs
 * External: node:child_process, node:fs, node:os, node:path, node:url, node:util
 *
 * Used by: entry point (CLI: cloud-ci.yml (--config-only cloud/worker) and the release-cloud.yml build)
 * check-deploy-tree.mjs
 * └── test/deploy-tree.test.mjs
 * <module-headers:end>
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { parseTag } from "./versions.mjs";
import { parseJsonc } from "./lib/jsonc.mjs";
import { PLACEHOLDER, REPO_ROOT, readJson, readOptional } from "./lib/repo.mjs";
import { createReport } from "./lib/report.mjs";

const TEMPLATE = "deploy-template/wrangler.template.jsonc";
const DEP_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

function checkBlock(block, label, r) {
  if (block.workers_dev !== true) r.fail(`${label}: workers_dev must be true (D19 setup bootstrap), found ${JSON.stringify(block.workers_dev)}`);
  if (block.preview_urls !== false) r.fail(`${label}: preview_urls must be false (D19), found ${JSON.stringify(block.preview_urls)}`);
  if (block.route !== undefined) r.fail(`${label}: a "route" is set; the deploy tree ships no route or custom domain (D19)`);
  const routes = block.routes ?? [];
  if (!Array.isArray(routes) || routes.length) {
    const custom = Array.isArray(routes) && routes.some((x) => x && typeof x === "object" && x.custom_domain);
    r.fail(`${label}: "routes" must be empty${custom ? " (it holds a custom_domain entry)" : ""} (D19)`);
  }
  for (const db of block.d1_databases ?? []) {
    if (db.database_id !== undefined) r.fail(`${label}: D1 binding ${db.binding ?? "?"} carries a database_id; the deployer's account creates its own`);
  }
}

/** Checks one parsed wrangler config, top level and every `env.*` block. */
export function checkWranglerConfig(config, label, r) {
  const before = r.failures.length;
  checkBlock(config, label, r);
  for (const [name, block] of Object.entries(config.env ?? {})) checkBlock({ workers_dev: config.workers_dev, preview_urls: config.preview_urls, ...block }, `${label} env.${name}`, r);
  if (r.failures.length === before) r.ok(`${label}: workers_dev true, preview_urls false, no route or custom domain, no database_id`);
}

function outside(dir, spec) {
  if (spec.startsWith("link:") || spec.startsWith("workspace:")) return true;
  if (!spec.startsWith("file:")) return false;
  const target = path.resolve(dir, spec.slice("file:".length));
  return path.relative(dir, target).startsWith("..") || path.isAbsolute(path.relative(dir, target));
}

/** No dependency spec in package.json or package-lock.json escapes `dir`. */
export function checkSelfContained(dir, r) {
  const before = r.failures.length;
  const pkg = readJson(path.join(dir, "package.json"));
  if (pkg === null) return r.fail(`${dir}/package.json is missing`);
  for (const section of DEP_SECTIONS) {
    for (const [name, spec] of Object.entries(pkg[section] ?? {})) {
      if (outside(dir, String(spec))) r.fail(`package.json ${section}.${name} = ${spec} points outside the tree; deployers have no monorepo`);
    }
  }
  const lock = readJson(path.join(dir, "package-lock.json"));
  if (lock === null) r.fail("package-lock.json is missing; the deploy tree must install with npm ci");
  else {
    for (const [key, entry] of Object.entries(lock.packages ?? {})) {
      for (const field of ["resolved", "version"]) {
        const spec = String(entry?.[field] ?? "");
        // npm writes local links as a relative "resolved" path plus link: true.
        const rel = entry?.link && field === "resolved" ? `file:${spec}` : spec;
        if (outside(dir, rel)) r.fail(`package-lock.json packages["${key}"].${field} = ${spec} points outside the tree`);
      }
    }
    for (const [name, entry] of Object.entries(lock.dependencies ?? {})) {
      if (outside(dir, String(entry?.version ?? ""))) r.fail(`package-lock.json dependencies.${name} points outside the tree`);
    }
  }
  if (!fs.existsSync(path.join(dir, "vendor/cloud-protocol/package.json"))) r.fail("vendor/cloud-protocol/package.json is missing; the protocol must be bundled into the tree (07 §1)");
  if (r.failures.length === before) r.ok("tree is self-contained (no dependency outside it, protocol vendored)");
}

/** Normalises APP_CALLBACK_URLS (array or comma-separated string) to a list. */
export function callbackList(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

/** `vars.APP_CALLBACK_URLS` equals the list derived from publisher.json. */
export function checkCallbacks(config, domain, stable, r) {
  const urls = callbackList(config.vars?.APP_CALLBACK_URLS);
  const wanted = [`https://${domain}/auth/callback`];
  if (urls.some((u) => u.startsWith("yaranapp://"))) r.fail("APP_CALLBACK_URLS lists a yaranapp:// callback; release builds accept only the https callback (02 §8)");
  if (stable && (PLACEHOLDER.test(domain) || urls.some((u) => PLACEHOLDER.test(u)))) {
    r.fail(`APP_CALLBACK_URLS still holds the placeholder (${urls.join(", ") || "empty"}); commit the real publisher_domain in publisher.json before a stable release`);
  }
  if (JSON.stringify(urls) === JSON.stringify(wanted)) r.ok(`APP_CALLBACK_URLS = ${wanted[0]}`);
  else r.fail(`APP_CALLBACK_URLS is ${JSON.stringify(urls)}, expected ${JSON.stringify(wanted)} (derived from publisher.json)`);
}

function readConfig(file, r) {
  const text = readOptional(file);
  if (text === null) {
    r.fail(`${file} is missing`);
    return null;
  }
  return parseJsonc(text);
}

function isolatedBuild(dir, r) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "yaran-deploy-tree-"));
  const tree = path.join(tmp, "worker");
  fs.cpSync(dir, tree, { recursive: true, filter: (src) => !src.split(path.sep).includes("node_modules") });
  for (const cmd of [["npm", ["ci"]], ["npm", ["run", "build"]], ["npx", ["wrangler", "deploy", "--dry-run", "--outdir", path.join(tmp, "dist")]]]) {
    const res = spawnSync(cmd[0], cmd[1], { cwd: tree, stdio: "inherit" });
    if (res.status !== 0) return r.fail(`isolated build: ${cmd[0]} ${cmd[1].join(" ")} failed in ${tree}`);
  }
  r.ok(`isolated build passed in ${tree}`);
}

/** Runs the CLI; returns the exit code. */
export function run(argv, log = console.log) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "config-only": { type: "boolean" },
      tag: { type: "string" },
      publisher: { type: "string" },
      "isolated-build": { type: "boolean" },
    },
  });
  if (positionals.length !== 1) {
    log("usage: node tools/release-trains/check-deploy-tree.mjs <dir> [--config-only] [--tag <tag>] [--publisher <publisher.json>] [--isolated-build]");
    return 2;
  }
  const dir = path.resolve(positionals[0]);
  const r = createReport({ log });

  const main = readConfig(path.join(dir, "wrangler.jsonc"), r);
  if (main) checkWranglerConfig(main, "wrangler.jsonc", r);

  if (values["config-only"]) {
    if (fs.existsSync(path.join(dir, TEMPLATE))) {
      const template = readConfig(path.join(dir, TEMPLATE), r);
      if (template) checkWranglerConfig(template, TEMPLATE, r);
    }
  } else {
    checkSelfContained(dir, r);
    const stable = values.tag ? !parseTag(values.tag).prerelease : true;
    const publisher = readJson(path.resolve(values.publisher ?? path.join(REPO_ROOT, "publisher.json")));
    if (publisher === null) r.fail("publisher.json not found (pass --publisher)");
    else if (main) checkCallbacks(main, String(publisher.publisher_domain ?? ""), stable, r);
    if (values["isolated-build"] && r.failures.length === 0) isolatedBuild(dir, r);
  }
  log(r.failures.length ? `${r.failures.length} check(s) failed` : "deploy tree passed");
  return r.failures.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(run(process.argv.slice(2)));
