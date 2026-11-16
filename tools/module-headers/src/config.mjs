/**
 * Scope manifest and oversize baseline: loading, validation and glob matching.
 *
 * `scope.json` says which files carry a generated block (roots plus optIn, minus exclude)
 * and which files are entry points. `baseline-oversize.json` holds the files that were
 * already over 500 lines when the gate landed. Both live next to this tool.
 *
 * - Pure apart from reading and writing those two JSON files; no git, no parsing.
 * - Globs are a small hand-written subset (`**`, `*`, `?`, `{a,b}`), so no dependency.
 * - A malformed manifest throws a UsageError, which the CLI reports as exit code 2.
 *
 * <module-headers:begin>
 * Uses: none
 * External: node:fs, node:path
 *
 * Used by:
 * src/config.mjs
 * ├── bin/module-headers.mjs
 * ├── src/headers.mjs
 * ├── src/lines.mjs
 * ├── src/parsers.mjs
 * └── test/files.test.mjs
 * <module-headers:end>
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export class UsageError extends Error {}

/** Where the manifest and baseline live, relative to the repository root. */
export const TOOL_DIR = "tools/module-headers";
export const SCOPE_FILE = `${TOOL_DIR}/scope.json`;
export const BASELINE_FILE = `${TOOL_DIR}/baseline-oversize.json`;

/**
 * Turn a glob into an anchored regular expression over repo-relative POSIX paths.
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      // `**/` matches zero or more whole directories; a trailing `**` matches anything.
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      const close = glob.indexOf("}", i);
      if (close < 0) throw new UsageError(`unclosed '{' in glob ${glob}`);
      const alts = glob.slice(i + 1, close).split(",");
      re += `(?:${alts.map((a) => globToRegExp(a).source.slice(1, -1)).join("|")})`;
      i = close;
    } else {
      re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * @param {string[]} globs
 * @returns {(path: string) => boolean}
 */
export function matcher(globs) {
  const res = globs.map(globToRegExp);
  return (path) => res.some((r) => r.test(path));
}

/**
 * @typedef {{ roots: string[], optIn: string[], exclude: string[],
 *             entryPoints: Record<string, string> }} Scope
 */

/**
 * Validate a parsed scope manifest.
 * @param {unknown} raw
 * @returns {Scope}
 */
export function validateScope(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new UsageError(`${SCOPE_FILE} must be a JSON object`);
  }
  const obj = /** @type {Record<string, unknown>} */ (raw);
  for (const key of Object.keys(obj)) {
    if (!["roots", "optIn", "exclude", "entryPoints"].includes(key)) {
      throw new UsageError(`${SCOPE_FILE}: unknown key "${key}"`);
    }
  }
  /** @param {string} key */
  const list = (key) => {
    const v = obj[key] ?? [];
    if (!Array.isArray(v) || v.some((s) => typeof s !== "string" || s === "")) {
      throw new UsageError(`${SCOPE_FILE}: "${key}" must be an array of non-empty strings`);
    }
    return /** @type {string[]} */ (v);
  };
  const ep = obj.entryPoints ?? {};
  if (typeof ep !== "object" || Array.isArray(ep) || ep === null) {
    throw new UsageError(`${SCOPE_FILE}: "entryPoints" must map a path or glob to a description`);
  }
  for (const [k, v] of Object.entries(ep)) {
    if (typeof v !== "string" || v.trim() === "") {
      throw new UsageError(`${SCOPE_FILE}: entry point "${k}" needs a launch description`);
    }
  }
  return {
    roots: list("roots"),
    optIn: list("optIn"),
    exclude: list("exclude"),
    entryPoints: /** @type {Record<string, string>} */ (ep),
  };
}

/**
 * @param {string} repoRoot
 * @returns {Scope}
 */
export function loadScope(repoRoot) {
  const file = join(repoRoot, SCOPE_FILE);
  if (!existsSync(file)) throw new UsageError(`missing ${SCOPE_FILE}`);
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new UsageError(`${SCOPE_FILE} is not valid JSON: ${/** @type {Error} */ (e).message}`);
  }
  return validateScope(raw);
}

/**
 * Compile a scope into the predicates the checker needs.
 * @param {Scope} scope
 */
export function compileScope(scope) {
  const inRoots = matcher(scope.roots);
  const optIn = new Set(scope.optIn);
  const excluded = matcher(scope.exclude);
  const eps = Object.entries(scope.entryPoints).map(([glob, desc]) => ({
    glob,
    desc,
    re: globToRegExp(glob),
  }));
  return {
    /** @param {string} path */
    inScope: (path) => (inRoots(path) || optIn.has(path)) && !excluded(path),
    /** @param {string} path @returns {string | undefined} */
    entryPoint: (path) => eps.find((e) => e.re.test(path))?.desc,
    entryGlobs: eps.map((e) => e.glob),
    optIn: scope.optIn,
    /** @param {string} glob @param {string} path */
    entryMatches: (glob, path) => globToRegExp(glob).test(path),
  };
}

/** @typedef {Record<string, { lines: number, reason: string }>} Baseline */

/**
 * @param {string} repoRoot
 * @returns {Baseline}
 */
export function loadBaseline(repoRoot) {
  const file = join(repoRoot, BASELINE_FILE);
  if (!existsSync(file)) return {};
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new UsageError(`${BASELINE_FILE} is not valid JSON: ${/** @type {Error} */ (e).message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new UsageError(`${BASELINE_FILE} must be a JSON object`);
  }
  for (const [path, entry] of Object.entries(raw)) {
    if (
      !entry ||
      !Number.isInteger(entry.lines) ||
      entry.lines <= 0 ||
      typeof entry.reason !== "string" ||
      entry.reason.trim() === ""
    ) {
      throw new UsageError(`${BASELINE_FILE}: entry "${path}" needs integer "lines" and a "reason"`);
    }
  }
  return raw;
}

/**
 * Serialize with sorted keys so the file diffs cleanly.
 * @param {Baseline} baseline
 */
export function formatBaseline(baseline) {
  /** @type {Baseline} */
  const sorted = {};
  for (const k of Object.keys(baseline).sort()) sorted[k] = baseline[k];
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

/**
 * @param {string} repoRoot
 * @param {Baseline} baseline
 */
export function saveBaseline(repoRoot, baseline) {
  writeFileSync(join(repoRoot, BASELINE_FILE), formatBaseline(baseline));
}
