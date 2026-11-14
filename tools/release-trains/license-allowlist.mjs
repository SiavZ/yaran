#!/usr/bin/env node
/**
 * One license allowlist for every ecosystem: reads the `allow = [...]` array of
 * `deny.toml`'s `[licenses]` table (the cargo gate) and emits it for npm
 * (`license-checker-rseidelsohn --onlyAllow`) and for Gradle (jk1's
 * `allowed-licenses.json`, written under build/ and never committed).
 *
 * - Read-only except `--jk1 <out>`; no TOML dependency (the array is plain strings).
 *
 * <module-headers:begin>
 * Uses:
 * license-allowlist.mjs
 * └── lib/repo.mjs
 * External: node:fs, node:path, node:url, node:util
 *
 * Used by: entry point (CLI: .github/scripts/npm_license_gate.sh (--npm) and the Android legs (--jk1))
 * license-allowlist.mjs
 * ├── swiftpm-licenses.mjs
 * └── test/licenses.test.mjs
 * <module-headers:end>
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { REPO_ROOT } from "./lib/repo.mjs";

/** The SPDX ids in `[licenses] allow = [...]` of a deny.toml text, in file order. */
export function parseAllowlist(text) {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/#.*$/, ""));
  const start = lines.findIndex((l) => l.trim() === "[licenses]");
  if (start < 0) throw new Error("deny.toml has no [licenses] table");
  let body = "";
  let inArray = false;
  for (const line of lines.slice(start + 1)) {
    if (!inArray && /^\s*\[/.test(line)) break;
    if (!inArray && /^\s*allow\s*=\s*\[/.test(line)) inArray = true;
    if (inArray) {
      body += `${line}\n`;
      if (line.includes("]")) break;
    }
  }
  if (!inArray) throw new Error("deny.toml [licenses] has no allow array");
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** Reads the allowlist from a deny.toml path. */
export function readAllowlist(file = path.join(REPO_ROOT, "deny.toml")) {
  return parseAllowlist(fs.readFileSync(file, "utf8"));
}

/** Runs the CLI; returns the exit code. */
export function run(argv, log = console.log) {
  const { values } = parseArgs({ args: argv, options: { npm: { type: "boolean" }, jk1: { type: "string" }, deny: { type: "string" } } });
  if (!values.npm && !values.jk1) {
    log("usage: node tools/release-trains/license-allowlist.mjs --npm | --jk1 <out.json> [--deny <deny.toml>]");
    return 2;
  }
  const list = readAllowlist(values.deny ? path.resolve(values.deny) : undefined);
  if (values.npm) log(list.join(";"));
  if (values.jk1) {
    fs.mkdirSync(path.dirname(path.resolve(values.jk1)), { recursive: true });
    fs.writeFileSync(values.jk1, `${JSON.stringify({ allowedLicenses: list.map((moduleLicense) => ({ moduleLicense })) }, null, 2)}\n`);
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(run(process.argv.slice(2)));
