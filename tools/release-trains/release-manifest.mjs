#!/usr/bin/env node
/**
 * Writes the cloud train's `release.json` (02 `ReleaseManifest`), which lives at
 * `cloud-deploy:worker/release.json` and is what Phase 07's update checker reads.
 *
 * The manifest names the Worker tarball's own SHA-256, so it stays outside that tarball:
 * `release-cloud.yml` packs the tree first, then runs this, then adds the file to the
 * branch commit. The result is validated with `@yaran/protocol`'s own validator
 * (`cloud/protocol/src/validate.ts`), so the wire type is never re-declared here.
 *
 * - Reads the tarball, writes one JSON file; needs `npm ci` in cloud/protocol.
 * - Exit 1 when the manifest does not validate.
 *
 * <module-headers:begin>
 * Uses:
 * release-manifest.mjs
 * ├── lib/repo.mjs
 * └── versions.mjs
 * External: node:crypto, node:fs, node:path, node:url, node:util
 *
 * Used by: entry point (CLI: release-cloud.yml build, writes cloud-deploy:worker/release.json)
 * release-manifest.mjs
 * └── test/release-manifest.test.mjs
 * <module-headers:end>
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseTag } from "./versions.mjs";
import { REPO_ROOT } from "./lib/repo.mjs";

const USAGE = `usage: node tools/release-trains/release-manifest.mjs --tag <tag> --tarball <path> --url <https url>
         --out <file> --notes-url <https url> --min-update-from X.Y.Z [--security]
         [--protocol-min N --protocol-max N] [--released-at <RFC 3339 UTC>]`;

/** Reads PROTOCOL_MIN/MAX from the protocol package's version module. */
export function protocolRange(root = REPO_ROOT) {
  const text = fs.readFileSync(path.join(root, "cloud/protocol/src/version.ts"), "utf8");
  const read = (name) => Number(new RegExp(`export const ${name} = (\\d+);`).exec(text)?.[1]);
  const range = { min: read("PROTOCOL_MIN"), max: read("PROTOCOL_MAX") };
  if (!Number.isInteger(range.min) || !Number.isInteger(range.max)) throw new Error("cannot read PROTOCOL_MIN/PROTOCOL_MAX from cloud/protocol/src/version.ts");
  return range;
}

/** Builds the manifest object. */
export function buildManifest({ tag, tarball, url, notesUrl, minUpdateFrom, security = false, protocol, releasedAt }) {
  const v = parseTag(tag);
  if (v.train !== "cloud") throw new Error(`${tag} is not a yaran-cloud-v* tag`);
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(tarball)).digest("hex");
  return {
    train: "yaran-cloud",
    version: v.version,
    tag,
    released_at: releasedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    protocol,
    min_update_from: minUpdateFrom,
    security,
    notes_url: notesUrl,
    tarball: { url, sha256 },
  };
}

/** Validates with @yaran/protocol; returns its {valid, errors}. */
export async function validateManifest(manifest, root = REPO_ROOT) {
  const mod = await import(pathToFileURL(path.join(root, "cloud/protocol/src/validate.ts")).href);
  const result = mod.validate("ReleaseManifest", manifest);
  if (result.valid && manifest.protocol.max < manifest.protocol.min) {
    return { valid: false, errors: [{ path: "/protocol", keyword: "range", message: "max < min" }] };
  }
  return result;
}

/** Runs the CLI; returns the exit code. */
export async function run(argv, log = console.log) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        tag: { type: "string" },
        tarball: { type: "string" },
        url: { type: "string" },
        out: { type: "string" },
        "notes-url": { type: "string" },
        "min-update-from": { type: "string" },
        security: { type: "boolean" },
        "protocol-min": { type: "string" },
        "protocol-max": { type: "string" },
        "released-at": { type: "string" },
      },
    }));
  } catch (err) {
    log(`${err.message}\n${USAGE}`);
    return 2;
  }
  for (const k of ["tag", "tarball", "url", "out", "notes-url", "min-update-from"]) {
    if (!values[k]) {
      log(`--${k} is required\n${USAGE}`);
      return 2;
    }
  }
  try {
    const fallback = protocolRange();
    const protocol = {
      min: values["protocol-min"] ? Number(values["protocol-min"]) : fallback.min,
      max: values["protocol-max"] ? Number(values["protocol-max"]) : fallback.max,
    };
    const manifest = buildManifest({
      tag: values.tag,
      tarball: values.tarball,
      url: values.url,
      notesUrl: values["notes-url"],
      minUpdateFrom: values["min-update-from"],
      security: Boolean(values.security),
      protocol,
      releasedAt: values["released-at"],
    });
    const result = await validateManifest(manifest);
    if (!result.valid) {
      for (const e of result.errors) log(`FAIL  ${e.path || "/"} ${e.keyword}: ${e.message}`);
      log("release.json does not validate against ReleaseManifest; nothing written");
      return 1;
    }
    fs.writeFileSync(values.out, `${JSON.stringify(manifest, null, 2)}\n`);
    log(`wrote ${values.out} (tarball sha256 ${manifest.tarball.sha256})`);
    return 0;
  } catch (err) {
    log(`release-manifest: ${err.message}`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await run(process.argv.slice(2)));
