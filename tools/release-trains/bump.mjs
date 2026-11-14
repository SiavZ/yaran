#!/usr/bin/env node
/**
 * Release-train version bump: writes the literals a tag implies, run in the release PR
 * before the tag is pushed, so the tagged commit already holds them (R5 §7.7-7.8).
 *
 * Mobile: Gradle versionCode/versionName, every pbxproj MARKETING_VERSION and
 * CURRENT_PROJECT_VERSION (App and NotificationService alike), `mobile/app/package.json`,
 * and a changelog stub `fastlane/metadata/android/en-US/changelogs/<versionCode>.txt`.
 * Cloud: every `cloud/*` package.json version.
 *
 * - Writes files in place; a file that does not exist yet is reported and skipped.
 * - Never overwrites an existing changelog.
 *
 * <module-headers:begin>
 * Uses:
 * bump.mjs
 * ├── lib/literals.mjs
 * ├── lib/repo.mjs
 * └── versions.mjs
 * External: node:fs, node:path, node:url, node:util
 *
 * Used by: entry point (CLI: run by a maintainer in the release PR (docs/operations/release-trains.md))
 * bump.mjs
 * └── test/check-versions.test.mjs
 * <module-headers:end>
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { parseTag, versionCode } from "./versions.mjs";
import { PATHS, changelogPath, findGradle, writeGradleVersions, writePackageVersion, writePbx } from "./lib/literals.mjs";
import { REPO_ROOT } from "./lib/repo.mjs";

function rewrite(root, rel, transform, log) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) {
    log(`skip  ${rel}: not present yet`);
    return;
  }
  const before = fs.readFileSync(file, "utf8");
  const after = transform(before);
  if (after !== before) fs.writeFileSync(file, after);
  log(`${after === before ? "same " : "wrote"} ${rel}`);
}

/** Bumps every literal for `tag` under `root`; returns the exit code. */
export function run(argv, log = console.log) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { root: { type: "string" } } });
  if (positionals.length !== 1) {
    log("usage: node tools/release-trains/bump.mjs <tag> [--root <dir>]");
    return 2;
  }
  const root = path.resolve(values.root ?? REPO_ROOT);
  let v;
  let code;
  try {
    v = parseTag(positionals[0]);
    code = versionCode(v);
  } catch (err) {
    log(`bump: ${err.message}`);
    return 1;
  }

  if (v.train === "cloud") {
    const base = path.join(root, PATHS.cloud);
    for (const dir of fs.existsSync(base) ? fs.readdirSync(base).sort() : []) {
      const rel = `${PATHS.cloud}/${dir}/package.json`;
      if (fs.existsSync(path.join(root, rel))) rewrite(root, rel, (t) => writePackageVersion(t, v.version), log);
    }
    return 0;
  }

  rewrite(root, findGradle(root) ?? PATHS.gradleKts, (t) => writeGradleVersions(t, code, v.version), log);
  rewrite(root, PATHS.pbxproj, (t) => writePbx(writePbx(t, "MARKETING_VERSION", v.base), "CURRENT_PROJECT_VERSION", String(code)), log);
  rewrite(root, PATHS.appPackage, (t) => writePackageVersion(t, v.version), log);

  const changelog = path.join(root, changelogPath(code));
  if (fs.existsSync(changelog)) {
    log(`keep  ${changelogPath(code)}`);
  } else {
    fs.mkdirSync(path.dirname(changelog), { recursive: true });
    fs.writeFileSync(changelog, `Version ${v.version}. Replace this line with what changed (500 characters at most).\n`);
    log(`wrote ${changelogPath(code)} (stub: edit before tagging)`);
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(run(process.argv.slice(2)));
