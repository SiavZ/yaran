#!/usr/bin/env node
/**
 * Release-train version gate: the first job of `release-cloud.yml` and
 * `release-mobile.yml`, and the code gate in front of every Play upload.
 *
 * `check-versions.mjs <tag>` fails when any literal the tag implies (Gradle
 * versionCode/versionName, every pbxproj MARKETING_VERSION and CURRENT_PROJECT_VERSION,
 * `mobile/app/package.json`, the changelog file, each `cloud/*` package version)
 * disagrees, when Phase 14's projects disagree with `mobile/toolchain.env`, or when a
 * second Node pin (`.nvmrc` under mobile/) appears. Flags add the publisher (D16),
 * listing-length and Play enrollment (D23) gates.
 *
 * - Read-only; one output line per check; exit 1 on any failure, 2 on bad usage.
 * - `--dry-run` reports missing files as skipped and exits 0 unless the tag is invalid.
 * - `--root` points it at a fixture tree (tests).
 *
 * <module-headers:begin>
 * Uses:
 * check-versions.mjs
 * ├── lib/gates.mjs
 * ├── lib/literals.mjs
 * ├── lib/repo.mjs
 * ├── lib/report.mjs
 * └── versions.mjs
 * External: node:fs, node:path, node:url, node:util
 *
 * Used by: entry point (CLI: the first job of release-cloud.yml and release-mobile.yml, the --play gate before every Play upload, and --metadata in mobile-ci.yml and gates.yml)
 * check-versions.mjs
 * └── test/check-versions.test.mjs
 * <module-headers:end>
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { parseTag, versionCode } from "./versions.mjs";
import { PATHS, changelogPath, findGradle, gradleValue, pbxValues } from "./lib/literals.mjs";
import { checkMetadata, checkPlay, checkPublisher } from "./lib/gates.mjs";
import { REPO_ROOT, findFiles, readJson, readKeyValue, readOptional } from "./lib/repo.mjs";
import { createReport } from "./lib/report.mjs";

const USAGE = `usage: node tools/release-trains/check-versions.mjs <tag> [--publisher] [--metadata] [--dry-run] [--root <dir>]
       node tools/release-trains/check-versions.mjs --metadata [--root <dir>]
       node tools/release-trains/check-versions.mjs --play [--root <dir>]`;

/** Checks every pbxproj value of a setting equals `wanted`; an empty list fails. */
function expectAllPbx(r, text, key, wanted) {
  const values = pbxValues(text, key);
  if (values.length === 0) return r.fail(`${PATHS.pbxproj} has no ${key}`);
  const bad = values.filter((v) => v !== wanted);
  if (bad.length) r.fail(`${PATHS.pbxproj} ${key} must be ${wanted} in every target (App and NotificationService); found ${values.join(", ")}`);
  else r.ok(`${PATHS.pbxproj} ${key} = ${wanted} in ${values.length} build configuration(s)`);
}

function checkMobileLiterals(root, v, code, r) {
  const gradle = findGradle(root);
  if (gradle === null) {
    r.missing(`${PATHS.gradleKts} (or build.gradle)`, "Phase 14's app module");
  } else {
    const text = fs.readFileSync(path.join(root, gradle), "utf8");
    r.expect(`${gradle} versionCode`, gradleValue(text, "versionCode"), String(code));
    r.expect(`${gradle} versionName`, gradleValue(text, "versionName"), v.version);
  }

  const pbx = readOptional(path.join(root, PATHS.pbxproj));
  if (pbx === null) r.missing(PATHS.pbxproj, "Phase 14's Xcode project");
  else {
    expectAllPbx(r, pbx, "MARKETING_VERSION", v.base);
    expectAllPbx(r, pbx, "CURRENT_PROJECT_VERSION", String(code));
  }

  const pkg = readJson(path.join(root, PATHS.appPackage));
  if (pkg === null) r.missing(PATHS.appPackage);
  else r.expect(`${PATHS.appPackage} version`, pkg.version ?? null, v.version);

  const changelog = changelogPath(code);
  if (fs.existsSync(path.join(root, changelog))) r.ok(`${changelog} exists`);
  else r.missing(changelog, "write it with bump.mjs");
}

function checkToolchain(root, r) {
  const env = readKeyValue(path.join(root, PATHS.toolchain));
  if (env === null) return r.missing(PATHS.toolchain);

  const gradle = findGradle(root);
  if (gradle === null) {
    r.missing(`${PATHS.gradleKts} (or build.gradle)`, "toolchain SDK check");
  } else {
    const app = fs.readFileSync(path.join(root, gradle), "utf8");
    const vars = readOptional(path.join(root, PATHS.gradleVariables)) ?? "";
    for (const [key, envKey] of [["targetSdk", "ANDROID_TARGET_SDK"], ["compileSdk", "ANDROID_COMPILE_SDK"]]) {
      // Capacitor's template keeps the SDK levels in variables.gradle and references them from the app module.
      const value = gradleValue(app, key) ?? gradleValue(vars, key);
      r.expect(`Gradle ${key} vs ${PATHS.toolchain} ${envKey}`, value, env[envKey] ?? null);
    }
  }

  const pbx = readOptional(path.join(root, PATHS.pbxproj));
  if (pbx === null) r.missing(PATHS.pbxproj, "toolchain deployment-target check");
  else expectAllPbx(r, pbx, "IPHONEOS_DEPLOYMENT_TARGET", env.IOS_DEPLOYMENT_TARGET ?? "(unset in toolchain.env)");
}

function checkOneNodePin(root, r) {
  const nvmrcs = findFiles(path.join(root, "mobile"), ".nvmrc");
  if (nvmrcs.length) r.fail(`a second Node pin exists (${nvmrcs.map((f) => path.relative(root, f)).join(", ")}); .node-version at the repo root is the only one`);
  else r.ok("no .nvmrc under mobile/ (.node-version is the one Node pin)");
}

function checkCloudLiterals(root, v, r) {
  const base = path.join(root, PATHS.cloud);
  const packages = fs.existsSync(base)
    ? fs.readdirSync(base).sort().filter((d) => fs.existsSync(path.join(base, d, "package.json")))
    : [];
  if (packages.length === 0) return r.missing(`${PATHS.cloud}/*/package.json`);
  for (const dir of packages) {
    const pkg = readJson(path.join(base, dir, "package.json"));
    r.expect(`${PATHS.cloud}/${dir}/package.json version`, pkg.version ?? null, v.version);
  }
}

/** Runs the checks; returns the process exit code. */
export function run(argv, log = console.log) {
  let args;
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        publisher: { type: "boolean" },
        metadata: { type: "boolean" },
        play: { type: "boolean" },
        "dry-run": { type: "boolean" },
        root: { type: "string" },
      },
    });
  } catch (err) {
    log(`${err.message}\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = args;
  const root = path.resolve(values.root ?? REPO_ROOT);
  const r = createReport({ dryRun: values["dry-run"], log });

  if (positionals.length > 1 || (positionals.length === 0 && !values.play && !values.metadata)) {
    log(USAGE);
    return 2;
  }
  if (positionals.length === 1) {
    let v;
    let code;
    try {
      v = parseTag(positionals[0]);
      code = versionCode(v);
    } catch (err) {
      log(`FAIL  ${err.message}`);
      return 1;
    }
    log(`tag ${positionals[0]}: train ${v.train}, version ${v.version}, versionCode ${code}`);
    if (v.train === "mobile") {
      checkMobileLiterals(root, v, code, r);
      checkToolchain(root, r);
      checkOneNodePin(root, r);
    } else {
      checkCloudLiterals(root, v, r);
    }
    if (values.publisher) checkPublisher(root, v.train, r);
    if (values.metadata) checkMetadata(root, r);
  } else if (values.publisher) {
    log("--publisher needs a tag");
    return 2;
  } else if (values.metadata) {
    // mobile-ci checks the listing lengths on every PR, where there is no tag.
    checkMetadata(root, r);
  }
  // The Play gate never softens under --dry-run: it guards an irreversible upload.
  const beforePlay = r.failures.length;
  if (values.play) checkPlay(root, r);
  const playFailed = r.failures.length > beforePlay;

  if (values["dry-run"]) {
    log(`dry run: ${r.failures.length} check(s) would fail`);
    return playFailed ? 1 : 0;
  }
  log(r.failures.length ? `${r.failures.length} check(s) failed` : "all checks passed");
  return r.failures.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(run(process.argv.slice(2)));
