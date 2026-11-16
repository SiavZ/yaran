#!/usr/bin/env node
/**
 * Association-file gate (T63): the files Phase 21 hosts on `<publisher-domain>` must
 * vouch for the real app and the real signing key, or App Links and the iOS `.https`
 * callback either fail or vouch for somebody else.
 *
 * Without flags it checks the committed `publisher-site/.well-known/assetlinks.json`
 * (package = appId, fingerprint = `app-signing-cert.sha256`) and
 * `apple-app-site-association` (`<TeamID>.<appId>` covering `/auth/callback` and
 * `/oauth/callback`). `--live` also fetches both over https with no redirect followed and
 * compares them byte for byte. `release-mobile.yml` runs `--live` for stable tags; Phase 22
 * runs it daily.
 *
 * - Reads committed files; `--live` makes two GET requests to the publisher domain.
 * - `--base-url` replaces `https://<publisher_domain>` and exists for tests only.
 *
 * <module-headers:begin>
 * Uses:
 * check-association.mjs
 * ├── lib/literals.mjs
 * ├── lib/repo.mjs
 * └── lib/report.mjs
 * External: node:fs, node:path, node:url, node:util
 *
 * Used by: entry point (CLI: release-mobile.yml check (--live on stable tags); Phase 22 daily)
 * check-association.mjs
 * └── test/association.test.mjs
 * <module-headers:end>
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { PATHS } from "./lib/literals.mjs";
import { PLACEHOLDER, REPO_ROOT, SHA256_HEX, colonFingerprint, readJson, readKeyValue, readOptional } from "./lib/repo.mjs";
import { createReport } from "./lib/report.mjs";

export const WELL_KNOWN = "publisher-site/.well-known";
const FILES = ["assetlinks.json", "apple-app-site-association"];
const IOS_PATHS = ["/auth/callback", "/oauth/callback"];

/** assetlinks.json names `appId` with the app-signing fingerprint. */
export function checkAssetLinks(statements, appId, certHex, r) {
  const want = colonFingerprint(certHex);
  const entries = (Array.isArray(statements) ? statements : []).filter(
    (s) => (s.relation ?? []).includes("delegate_permission/common.handle_all_urls") && s.target?.namespace === "android_app",
  );
  const forApp = entries.filter((s) => s.target.package_name === appId);
  if (forApp.length === 0) return r.fail(`assetlinks.json has no handle_all_urls statement for package ${appId}`);
  if (!forApp.some((s) => (s.target.sha256_cert_fingerprints ?? []).map((f) => String(f).toUpperCase()).includes(want))) {
    return r.fail(`assetlinks.json does not list the app-signing fingerprint ${want} for ${appId}`);
  }
  r.ok(`assetlinks.json vouches for ${appId} signed by ${want}`);
}

function coveredPaths(detail) {
  const out = [...(detail.paths ?? [])];
  for (const c of detail.components ?? []) if (c["/"] && !c.exclude) out.push(c["/"]);
  return out;
}

/** apple-app-site-association names `<TeamID>.<appId>` with both callback paths. */
export function checkAasa(aasa, teamId, appId, r) {
  const appIdFull = `${teamId}.${appId}`;
  const details = (aasa?.applinks?.details ?? []).filter((d) => d.appID === appIdFull || (d.appIDs ?? []).includes(appIdFull));
  if (details.length === 0) return r.fail(`apple-app-site-association has no applinks entry for ${appIdFull}`);
  const paths = details.flatMap(coveredPaths);
  const missing = IOS_PATHS.filter((p) => !paths.includes(p));
  if (missing.length) return r.fail(`apple-app-site-association does not cover ${missing.join(" and ")} for ${appIdFull}`);
  r.ok(`apple-app-site-association covers ${IOS_PATHS.join(" and ")} for ${appIdFull}`);
}

/** Fetches `<base>/.well-known/<file>` without following redirects and compares bytes. */
export async function checkLive(base, file, committed, r) {
  const url = `${base.replace(/\/$/, "")}/.well-known/${file}`;
  let res;
  try {
    res = await fetch(url, { redirect: "manual" });
  } catch (err) {
    return r.fail(`${url}: ${err.message}`);
  }
  if (res.status !== 200) return r.fail(`${url} answered ${res.status}${res.headers.get("location") ? ` (redirect to ${res.headers.get("location")})` : ""}; it must serve the file directly`);
  const body = Buffer.from(await res.arrayBuffer());
  if (!body.equals(committed)) return r.fail(`${url} differs from the committed ${WELL_KNOWN}/${file}`);
  r.ok(`${url} matches the committed file`);
}

/** Runs the CLI; returns the exit code. */
export async function run(argv, log = console.log) {
  const { values } = parseArgs({ args: argv, options: { root: { type: "string" }, live: { type: "boolean" }, "base-url": { type: "string" }, help: { type: "boolean" } } });
  if (values.help) {
    log("usage: node tools/release-trains/check-association.mjs [--root <dir>] [--live] [--base-url <url>]\n  --base-url replaces https://<publisher_domain> for --live; tests only.");
    return 0;
  }
  const root = path.resolve(values.root ?? REPO_ROOT);
  const r = createReport({ log });

  const props = readKeyValue(path.join(root, PATHS.publisherProps)) ?? {};
  const appId = props.appId ?? "";
  const teamId = props.appleTeamId ?? "";
  const cert = (readOptional(path.join(root, PATHS.appCert)) ?? "").trim();
  if (!appId || PLACEHOLDER.test(appId)) r.fail(`${PATHS.publisherProps} appId is missing or a placeholder`);
  if (!teamId || PLACEHOLDER.test(teamId)) r.fail(`${PATHS.publisherProps} appleTeamId is missing or a placeholder`);
  if (!SHA256_HEX.test(cert)) r.fail(`${PATHS.appCert} holds no real fingerprint yet (D23 enrollment, work item 9)`);

  const committed = {};
  for (const file of FILES) {
    const p = path.join(root, WELL_KNOWN, file);
    if (!fs.existsSync(p)) r.fail(`${WELL_KNOWN}/${file} is missing; Phase 21 commits the association files`);
    else committed[file] = fs.readFileSync(p);
  }

  if (r.failures.length === 0) {
    checkAssetLinks(JSON.parse(committed["assetlinks.json"]), appId, cert, r);
    checkAasa(JSON.parse(committed["apple-app-site-association"]), teamId, appId, r);
  }

  if (values.live && r.failures.length === 0) {
    let base = values["base-url"];
    if (!base) {
      const domain = readJson(path.join(root, PATHS.publisherJson))?.publisher_domain ?? "";
      if (!domain || PLACEHOLDER.test(domain)) r.fail(`${PATHS.publisherJson} holds no real publisher_domain to fetch from`);
      base = `https://${domain}`;
    }
    if (r.failures.length === 0) for (const file of FILES) await checkLive(base, file, committed[file], r);
  }
  log(r.failures.length ? `${r.failures.length} check(s) failed` : "association files agree");
  return r.failures.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await run(process.argv.slice(2)));
