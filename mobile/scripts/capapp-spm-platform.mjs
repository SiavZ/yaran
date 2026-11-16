#!/usr/bin/env node
/**
 * Pins the generated CapApp-SPM package to the app's full iOS deployment target after `cap sync`.
 *
 * The Capacitor CLI writes `mobile/ios/App/CapApp-SPM/Package.swift` with only the major
 * version of the Xcode project's deployment target (`.iOS(.v17)`), but YaranMachineView and
 * YaranPush need iOS 17.4 (the `.https` ASWebAuthenticationSession callback, D8), and SwiftPM
 * refuses a package whose minimum is below one of its dependencies'. This rewrites the
 * platform line to the project's exact `IPHONEOS_DEPLOYMENT_TARGET` (`.iOS("17.4")`).
 *
 * - Runs as mobile/app's `capacitor:update:after` hook, which `cap sync` and `cap update` both
 *   call; for any platform other than iOS it does nothing.
 * - Fails loudly when the project has no single deployment target or the generated file has
 *   no platform line, rather than leaving a package graph SwiftPM will reject.
 *
 * <module-headers:begin>
 * Uses: none
 * External: node:fs, node:path, node:url
 *
 * Used by:
 * mobile/scripts/capapp-spm-platform.mjs
 * └── mobile/scripts/capapp-spm-platform.test.mjs
 * <module-headers:end>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', 'ios', 'App');
export const PATHS = {
  pbxproj: join(APP, 'App.xcodeproj', 'project.pbxproj'),
  packageSwift: join(APP, 'CapApp-SPM', 'Package.swift'),
};

/** The project's one iOS deployment target, such as `17.4`. */
export function deploymentTarget(pbxproj) {
  const targets = new Set([...pbxproj.matchAll(/IPHONEOS_DEPLOYMENT_TARGET = ([0-9.]+);/g)].map((m) => m[1]));
  if (targets.size !== 1) throw new Error(`expected one IPHONEOS_DEPLOYMENT_TARGET in the Xcode project, found ${[...targets].join(', ') || 'none'}`);
  return [...targets][0];
}

/** The package text with its iOS platform set to exactly `target`. */
export function pinPlatform(packageSwift, target) {
  const line = /platforms: \[\.iOS\((?:\.v[0-9_]+|"[0-9.]+")\)\]/;
  if (!line.test(packageSwift)) throw new Error('CapApp-SPM Package.swift has no `platforms: [.iOS(...)]` line to pin');
  return packageSwift.replace(line, `platforms: [.iOS("${target}")]`);
}

export function run(paths = PATHS) {
  const target = deploymentTarget(readFileSync(paths.pbxproj, 'utf8'));
  const before = readFileSync(paths.packageSwift, 'utf8');
  const after = pinPlatform(before, target);
  if (after !== before) writeFileSync(paths.packageSwift, after);
  return target;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const platform = process.env.CAPACITOR_PLATFORM_NAME;
  if (platform === undefined || platform === 'ios') console.log(`CapApp-SPM pinned to iOS ${run()}`);
}
