/**
 * Shared file helpers for the release-train scripts: the repo root, optional reads and
 * the `KEY=VALUE` formats (`mobile/toolchain.env`, `mobile/publisher.properties`,
 * `Publisher.xcconfig`).
 *
 * - Read-only; every script takes `--root` so tests can point it at a fixture tree.
 * - `PLACEHOLDER` is the one definition of a D16 placeholder such as `<publisher-domain>`.
 *
 * <module-headers:begin>
 * Uses: none
 * External: node:fs, node:path, node:url
 *
 * Used by:
 * lib/repo.mjs
 * ├── bump.mjs
 * ├── check-association.mjs
 * ├── check-deploy-tree.mjs
 * ├── check-versions.mjs
 * ├── lib/gates.mjs
 * ├── license-allowlist.mjs
 * ├── release-manifest.mjs
 * └── test/association.test.mjs
 * <module-headers:end>
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root, two directories above this package's lib/. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** A D16 placeholder: `<publisher-domain>`, `<app-signing-cert-sha256>` and the like. */
export const PLACEHOLDER = /<[a-z][a-z0-9-]*>/;

/** Reads a UTF-8 file, or returns null when it does not exist. */
export function readOptional(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/** Parses `KEY=VALUE` lines (`.env`, `.properties`, `.xcconfig`); `#` and `//` lines are comments. */
export function parseKeyValue(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("//") || line.startsWith("!")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^"(.*)"$/, "$1");
  }
  return out;
}

/** Reads a `KEY=VALUE` file, or null when absent. */
export function readKeyValue(file) {
  const text = readOptional(file);
  return text === null ? null : parseKeyValue(text);
}

/** Reads a JSON file, or null when absent. */
export function readJson(file) {
  const text = readOptional(file);
  return text === null ? null : JSON.parse(text);
}

/** Every file named `name` under `dir` (skipping node_modules and .git). */
export function findFiles(dir, name) {
  const found = [];
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findFiles(p, name));
    else if (entry.name === name) found.push(p);
  }
  return found;
}

/** Lowercase 64-hex SHA-256 fingerprint, the form `apksigner verify --print-certs` prints. */
export const SHA256_HEX = /^[0-9a-f]{64}$/;

/** `ab12…` → `AB:12:…`, the form assetlinks.json uses. */
export function colonFingerprint(hex) {
  return hex.toUpperCase().match(/../g).join(":");
}
