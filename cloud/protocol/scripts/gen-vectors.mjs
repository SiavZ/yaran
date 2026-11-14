#!/usr/bin/env node
/**
 * Regenerates every file under `fixtures/` from fixed inputs, independently of `src/`.
 *
 * Each generator module returns `{ "<path under fixtures/>": <JSON value> }`. Derived
 * values are computed with Node WebCrypto, node:crypto and jose (never with this
 * package's own codecs, so the TS and Rust suites are checked against an independent
 * implementation), and RFC vectors are asserted against the RFC text while generating.
 * `--check` regenerates in memory and fails unless every committed file matches byte for
 * byte and no stray fixture exists.
 *
 * - Randomized values (ECDSA signatures) are committed once: a generator receives the
 *   committed file through `ctx.previous(path)` and keeps a value that still verifies.
 * - Writes only under fixtures/.
 *
 * <module-headers:begin>
 * Uses:
 * scripts/gen-vectors.mjs
 * ├── scripts/vectors/access-jwt.mjs
 * ├── scripts/vectors/api.mjs
 * ├── scripts/vectors/consent.mjs
 * ├── scripts/vectors/jwe.mjs
 * ├── scripts/vectors/misc.mjs
 * ├── scripts/vectors/push.mjs
 * ├── scripts/vectors/sig.mjs
 * └── scripts/vectors/webpush.mjs
 * External: node:fs, node:path, node:url
 *
 * Used by: entry point (CLI: npm run gen / gen:vectors:check in cloud/protocol, and cloud-protocol.yml)
 * <module-headers:end>
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as accessJwt from "./vectors/access-jwt.mjs";
import * as api from "./vectors/api.mjs";
import * as consent from "./vectors/consent.mjs";
import * as jwe from "./vectors/jwe.mjs";
import * as misc from "./vectors/misc.mjs";
import * as push from "./vectors/push.mjs";
import * as sig from "./vectors/sig.mjs";
import * as webpush from "./vectors/webpush.mjs";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const check = process.argv.includes("--check");

const ctx = {
  previous(path) {
    const file = join(fixturesDir, path);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  },
};

const files = {};
for (const gen of [api, jwe, sig, consent, push, webpush, misc, accessJwt]) {
  for (const [path, value] of Object.entries(await gen.generate(ctx))) {
    if (files[path]) throw new Error(`two generators write ${path}`);
    files[path] = `${JSON.stringify(value, null, 2)}\n`;
  }
}

function listFixtures(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return listFixtures(full);
    return name.endsWith(".json") ? [relative(fixturesDir, full)] : [];
  });
}

if (check) {
  const problems = [];
  for (const [path, text] of Object.entries(files)) {
    const file = join(fixturesDir, path);
    if (!existsSync(file)) problems.push(`missing ${path}`);
    else if (readFileSync(file, "utf8") !== text) problems.push(`stale ${path}`);
  }
  // Hand-maintained fixtures (none today) would be listed here; anything else is stray.
  for (const path of existsSync(fixturesDir) ? listFixtures(fixturesDir) : []) {
    if (!files[path]) problems.push(`stray ${path} (no generator writes it)`);
  }
  if (problems.length) {
    console.error(`fixtures differ from the generators:\n  ${problems.join("\n  ")}\nRun \`node scripts/gen-vectors.mjs\`.`);
    process.exit(1);
  }
  console.log(`${Object.keys(files).length} fixture files are up to date.`);
} else {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(fixturesDir, path)), { recursive: true });
    writeFileSync(join(fixturesDir, path), text);
  }
  console.log(`wrote ${Object.keys(files).length} fixture files.`);
}
