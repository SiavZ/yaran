/**
 * Release gates that are not about version literals: the publisher values (D16, 02 §8),
 * the F-Droid listing lengths, and the Play App Signing enrollment record (D23).
 *
 * - `checkPublisher` makes `publisher.json` the one home of the publisher domain and
 *   refuses any official release that still holds a placeholder or disagrees with
 *   Phase 14's `mobile/publisher.properties` / `Publisher.xcconfig`.
 * - `checkPlay` is the code gate in front of every Play upload: no enrollment record, a
 *   placeholder record, or a fingerprint that differs from `app-signing-cert.sha256` fails.
 * - Read-only.
 *
 * <module-headers:begin>
 * Uses:
 * lib/gates.mjs
 * ├── lib/literals.mjs
 * └── lib/repo.mjs
 * External: node:fs, node:path
 *
 * Used by:
 * lib/gates.mjs
 * └── check-versions.mjs
 * <module-headers:end>
 */

import fs from "node:fs";
import path from "node:path";
import { PATHS } from "./literals.mjs";
import { PLACEHOLDER, SHA256_HEX, readJson, readKeyValue, readOptional } from "./repo.mjs";

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** F-Droid's listing limits, in code points (f-droid.org Build Metadata / fastlane docs). */
export const LISTING_LIMITS = {
  "title.txt": 50,
  "short_description.txt": 80,
  "full_description.txt": 4000,
};
export const CHANGELOG_LIMIT = 500;

/** Reads `publisher.json`'s domain; reports and returns null when absent. */
export function readPublisherDomain(root, r) {
  const json = readJson(path.join(root, PATHS.publisherJson));
  if (json === null) {
    r.missing(PATHS.publisherJson);
    return null;
  }
  return typeof json.publisher_domain === "string" ? json.publisher_domain : "";
}

/** `--publisher`: the domain is real and every mobile publisher value agrees with it. */
export function checkPublisher(root, train, r) {
  const domain = readPublisherDomain(root, r);
  if (domain === null) return;
  if (PLACEHOLDER.test(domain) || !HOSTNAME.test(domain)) {
    r.fail(`${PATHS.publisherJson} publisher_domain is ${JSON.stringify(domain)}; an official release needs the real bare hostname`);
  } else {
    r.ok(`${PATHS.publisherJson} publisher_domain = ${domain}`);
  }
  if (train !== "mobile") return;

  const props = readKeyValue(path.join(root, PATHS.publisherProps));
  if (props === null) {
    r.missing(PATHS.publisherProps, "Phase 14's publisher build config");
  } else {
    for (const key of ["appId", "appleTeamId", "publisherDomain", "relayUrl"]) {
      const value = props[key] ?? "";
      if (!value || PLACEHOLDER.test(value)) r.fail(`${PATHS.publisherProps} ${key} is empty or a placeholder`);
    }
    if ((props.appId ?? "").startsWith("com.example.")) r.fail(`${PATHS.publisherProps} appId ${props.appId} is the repo default, not the publisher's`);
    r.expect(`${PATHS.publisherProps} publisherDomain`, props.publisherDomain ?? null, domain);
  }

  const xcconfig = readKeyValue(path.join(root, PATHS.xcconfig));
  if (xcconfig !== null) r.expect(`${PATHS.xcconfig} PUBLISHER_DOMAIN`, xcconfig.PUBLISHER_DOMAIN ?? null, domain);
}

const length = (text) => [...text.replace(/\r?\n$/, "")].length;

/** `--metadata`: every locale's listing files are within F-Droid's limits. */
export function checkMetadata(root, r) {
  const base = path.join(root, PATHS.metadata);
  if (!fs.existsSync(base)) {
    r.missing(PATHS.metadata);
    return;
  }
  for (const locale of fs.readdirSync(base).sort()) {
    const dir = path.join(base, locale);
    if (!fs.statSync(dir).isDirectory()) continue;
    const files = Object.entries(LISTING_LIMITS).map(([f, limit]) => [`${locale}/${f}`, path.join(dir, f), limit]);
    const changelogs = path.join(dir, "changelogs");
    if (fs.existsSync(changelogs)) {
      for (const f of fs.readdirSync(changelogs).sort()) files.push([`${locale}/changelogs/${f}`, path.join(changelogs, f), CHANGELOG_LIMIT]);
    }
    for (const [label, file, limit] of files) {
      const text = readOptional(file);
      if (text === null) continue;
      const n = length(text);
      if (n > limit) r.fail(`${PATHS.metadata}/${label} is ${n} characters; F-Droid allows ${limit}`);
      else r.ok(`${PATHS.metadata}/${label} ${n}/${limit}`);
    }
  }
}

/** `--play`: the D23 enrollment record exists, is real, and matches the committed cert. */
export function checkPlay(root, r) {
  const record = readJson(path.join(root, PATHS.enrollment));
  if (record === null) {
    r.fail(`${PATHS.enrollment} does not exist: the Android app-signing key has not been enrolled in Play App Signing (D23, docs/operations/release-trains.md); nothing may be uploaded to Play before it is`);
    return;
  }
  const fields = ["package", "app_signing_cert_sha256", "upload_cert_sha256", "enrolled_at", "enrolled_by"];
  for (const f of fields) {
    const value = record[f];
    if (typeof value !== "string" || !value || PLACEHOLDER.test(value)) r.fail(`${PATHS.enrollment} ${f} is empty or a placeholder`);
  }
  for (const f of ["app_signing_cert_sha256", "upload_cert_sha256"]) {
    if (typeof record[f] === "string" && !PLACEHOLDER.test(record[f]) && !SHA256_HEX.test(record[f])) {
      r.fail(`${PATHS.enrollment} ${f} must be 64 lowercase hex characters without colons`);
    }
  }
  const cert = readOptional(path.join(root, PATHS.appCert));
  if (cert === null) {
    r.fail(`${PATHS.appCert} does not exist`);
  } else {
    const fp = cert.trim();
    if (PLACEHOLDER.test(fp) || !SHA256_HEX.test(fp)) r.fail(`${PATHS.appCert} holds ${JSON.stringify(fp)}, not a real fingerprint`);
    else r.expect(`${PATHS.enrollment} app_signing_cert_sha256 vs ${PATHS.appCert}`, record.app_signing_cert_sha256, fp);
  }
  const props = readKeyValue(path.join(root, PATHS.publisherProps));
  if (props === null) r.fail(`${PATHS.publisherProps} does not exist, so the enrolled package cannot be checked`);
  else r.expect(`${PATHS.enrollment} package vs ${PATHS.publisherProps} appId`, record.package, props.appId ?? null);
}
