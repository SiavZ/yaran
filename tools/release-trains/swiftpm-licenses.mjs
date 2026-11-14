#!/usr/bin/env node
/**
 * SwiftPM license gate: no CycloneDX tool covers SwiftPM, so every package pinned in
 * `Package.resolved` must appear in the committed `mobile/ios/licenses-swiftpm.json` map
 * with a license from the `deny.toml` allowlist. `--out` writes the inventory attached to
 * each mobile release.
 *
 * - Reads Package.resolved (v2/v3 `pins[]`) and the map; writes only `--out`.
 *
 * <module-headers:begin>
 * Uses:
 * swiftpm-licenses.mjs
 * └── license-allowlist.mjs
 * External: node:fs, node:path, node:url, node:util
 *
 * Used by: entry point (CLI: _mobile-ios-ci.yml and _mobile-ios-release.yml)
 * swiftpm-licenses.mjs
 * └── test/licenses.test.mjs
 * <module-headers:end>
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { readAllowlist } from "./license-allowlist.mjs";

/** Joins resolved pins with the map; returns {inventory, problems}. */
export function swiftpmInventory(resolved, map, allow) {
  const problems = [];
  const inventory = [];
  for (const pin of resolved.pins ?? []) {
    const entry = map[pin.identity];
    if (!entry) {
      problems.push(`${pin.identity} (${pin.location}) is resolved but missing from the license map`);
      continue;
    }
    if (!allow.includes(entry.license)) problems.push(`${pin.identity} is ${entry.license}, which deny.toml does not allow`);
    inventory.push({ identity: pin.identity, location: pin.location, version: pin.state?.version ?? pin.state?.revision ?? null, license: entry.license, url: entry.url ?? null });
  }
  return { inventory, problems };
}

/** Runs the CLI; returns the exit code. */
export function run(argv, log = console.log) {
  const { values } = parseArgs({ args: argv, options: { resolved: { type: "string" }, map: { type: "string" }, out: { type: "string" }, deny: { type: "string" } } });
  if (!values.resolved || !values.map) {
    log("usage: node tools/release-trains/swiftpm-licenses.mjs --resolved <Package.resolved> --map <licenses-swiftpm.json> [--out <file>] [--deny <deny.toml>]");
    return 2;
  }
  const resolved = JSON.parse(fs.readFileSync(values.resolved, "utf8"));
  const map = JSON.parse(fs.readFileSync(values.map, "utf8"));
  const { inventory, problems } = swiftpmInventory(resolved, map, readAllowlist(values.deny ? path.resolve(values.deny) : undefined));
  for (const p of problems) log(`FAIL  ${p}`);
  if (values.out) fs.writeFileSync(values.out, `${JSON.stringify(inventory, null, 2)}\n`);
  log(problems.length ? `${problems.length} SwiftPM license problem(s)` : `${inventory.length} SwiftPM package(s) licensed and allowed`);
  return problems.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(run(process.argv.slice(2)));
