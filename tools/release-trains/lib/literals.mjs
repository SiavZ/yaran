/**
 * Version literals the trains keep in files: where they live and how to read and
 * rewrite them (Gradle, `project.pbxproj`, `package.json`, the F-Droid changelog).
 *
 * F-Droid scrapes `versionCode`/`versionName` without running the build and Xcode reads
 * the pbxproj, so the tag must point at a commit that already holds the literals
 * (R5 §7.7-7.8). `check-versions.mjs` reads them through here and `bump.mjs` writes them.
 *
 * - Pure text transforms plus path constants; callers do the file I/O.
 * - Every pbxproj occurrence counts: the App and NotificationService targets must match.
 *
 * <module-headers:begin>
 * Uses: none
 * External: node:fs, node:path
 *
 * Used by:
 * lib/literals.mjs
 * ├── bump.mjs
 * ├── check-association.mjs
 * ├── check-versions.mjs
 * └── lib/gates.mjs
 * <module-headers:end>
 */

import fs from "node:fs";
import path from "node:path";

/** Repo-relative paths of every file the trains read or write. */
export const PATHS = {
  gradleKts: "mobile/android/app/build.gradle.kts",
  gradle: "mobile/android/app/build.gradle",
  gradleVariables: "mobile/android/variables.gradle",
  pbxproj: "mobile/ios/App/App.xcodeproj/project.pbxproj",
  appPackage: "mobile/app/package.json",
  toolchain: "mobile/toolchain.env",
  publisherProps: "mobile/publisher.properties",
  xcconfig: "mobile/ios/App/Config/Publisher.xcconfig",
  publisherJson: "publisher.json",
  metadata: "fastlane/metadata/android",
  enrollment: "mobile/android/signing/play-enrollment.json",
  appCert: "mobile/android/signing/app-signing-cert.sha256",
  cloud: "cloud",
};

/** The F-Droid/Play changelog file for a versionCode. */
export function changelogPath(code) {
  return `${PATHS.metadata}/en-US/changelogs/${code}.txt`;
}

/** The app module's Gradle file (Kotlin DSL first), or null. */
export function findGradle(root) {
  for (const rel of [PATHS.gradleKts, PATHS.gradle]) {
    if (fs.existsSync(path.join(root, rel))) return rel;
  }
  return null;
}

const GRADLE = {
  versionCode: /\bversionCode\s*=?\s*(\d+)/,
  versionName: /\bversionName\s*=?\s*["']([^"']+)["']/,
  targetSdk: /\btargetSdk(?:Version)?\s*=?\s*(\d+)/,
  compileSdk: /\bcompileSdk(?:Version)?\s*=?\s*(\d+)/,
};

/** Reads one literal (`versionCode`, `versionName`, `targetSdk`, `compileSdk`) or null. */
export function gradleValue(text, key) {
  return GRADLE[key].exec(text)?.[1] ?? null;
}

/** Rewrites versionCode and versionName, keeping the DSL's own syntax. */
export function writeGradleVersions(text, code, name) {
  for (const [key, re] of [["versionCode", GRADLE.versionCode], ["versionName", GRADLE.versionName]]) {
    if (!re.test(text)) throw new Error(`no ${key} literal to rewrite`);
  }
  return text
    .replace(/\b(versionCode\s*=?\s*)\d+/, `$1${code}`)
    .replace(/\b(versionName\s*=?\s*)(["'])[^"']+\2/, `$1$2${name}$2`);
}

const setting = (key) => new RegExp(`\\b${key} = "?([^";]+)"?;`, "g");

/** Every value of a build setting in a pbxproj, in file order. */
export function pbxValues(text, key) {
  return [...text.matchAll(setting(key))].map((m) => m[1].trim());
}

/** Sets every occurrence of a build setting in a pbxproj. */
export function writePbx(text, key, value) {
  return text.replace(setting(key), `${key} = ${value};`);
}

/** Rewrites the top-level `"version"` of a package.json text, keeping its formatting. */
export function writePackageVersion(text, version) {
  const json = JSON.parse(text);
  if (typeof json.version !== "string") throw new Error("no version field to rewrite");
  return text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
}
