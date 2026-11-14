/**
 * Tracked-file enumeration and language detection.
 *
 * Lists the repository's tracked files with `git ls-files -z`, reads their working-tree
 * text, and decides each file's language (by extension, or by shebang for extensionless
 * scripts) and whether the 500-line gate counts it.
 *
 * - Only tracked files exist for this tool: a new file is seen once it is `git add`ed.
 * - A tracked file deleted from the working tree is skipped, not an error.
 * - Reads files synchronously; the CLI is a short-lived batch process.
 *
 * <module-headers:begin>
 * Uses: none
 * External: node:child_process, node:fs, node:path
 *
 * Used by:
 * src/files.mjs
 * ├── bin/module-headers.mjs
 * ├── test/files.test.mjs
 * └── test/helpers.mjs
 * <module-headers:end>
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, basename } from "node:path";

/** @typedef {"rust" | "ts" | "kotlin" | "swift" | "shell"} Lang */

/** @type {Record<string, Lang>} */
const BY_EXT = {
  ".rs": "rust",
  ".ts": "ts",
  ".tsx": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".js": "ts",
  ".mjs": "ts",
  ".cjs": "ts",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".swift": "swift",
  ".sh": "shell",
  ".bash": "shell",
  ".bats": "shell",
};

export const SHELL_SHEBANG = /^#!\s*(?:\/usr\/bin\/env\s+(?:-\S+\s+)*)?(?:\S*\/)?(?:ba|da|k)?sh\b/;

/**
 * @param {string} repoRoot
 * @returns {string} absolute path of the git top level containing repoRoot
 */
export function gitTopLevel(repoRoot) {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: repoRoot, encoding: "utf8" }).trim();
}

/**
 * @param {string} repoRoot
 * @returns {string[]} tracked paths that exist in the working tree, sorted
 */
export function listTracked(repoRoot) {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return out
    .split("\0")
    .filter((p) => p !== "" && existsSync(join(repoRoot, p)))
    .sort();
}

/**
 * Language of a file for the header graph, or undefined when it has none.
 * @param {string} path
 * @param {string} text
 * @returns {Lang | undefined}
 */
export function detectLang(path, text) {
  const ext = extname(path);
  if (ext in BY_EXT) return BY_EXT[ext];
  if (ext === "" && SHELL_SHEBANG.test(firstLine(text))) return "shell";
  return undefined;
}

/** @param {string} text */
function firstLine(text) {
  const nl = text.indexOf("\n");
  return nl < 0 ? text : text.slice(0, nl);
}

/**
 * Whether the line gate counts this file: code by extension, any extensionless shebang
 * script, and workflow YAML.
 * @param {string} path
 * @param {string} text
 */
export function isLineCounted(path, text) {
  const ext = extname(path);
  if (ext in BY_EXT) return true;
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) return true;
  return ext === "" && !basename(path).startsWith(".") && firstLine(text).startsWith("#!");
}

/**
 * Generated or vendored files are exempt from both the line gate and the header check.
 * @param {string} path
 * @param {string} text
 */
export function isExempt(path, text) {
  const head = text.split("\n", 5).join("\n");
  if (head.includes("@generated")) return true;
  return path.endsWith(".d.ts") && /\bvendored\b/i.test(head);
}

/**
 * Count lines the way an editor shows them: a final newline does not start a new line.
 * @param {string} text
 */
export function countLines(text) {
  if (text === "") return 0;
  let n = 0;
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) n++;
  return text.endsWith("\n") ? n : n + 1;
}

/**
 * @typedef {{ path: string, text: string, lang: Lang | undefined }} RepoFile
 */

/**
 * Every tracked path, plus the text of each tracked file that is line-counted or has a
 * language.
 * @param {string} repoRoot
 * @returns {{ tracked: Set<string>, files: RepoFile[] }}
 */
export function readRepoFiles(repoRoot) {
  /** @type {RepoFile[]} */
  const files = [];
  const tracked = new Set(listTracked(repoRoot));
  for (const path of tracked) {
    const ext = extname(path);
    const maybeCode = ext in BY_EXT || ext === "" || path.startsWith(".github/workflows/");
    if (!maybeCode) continue;
    let text;
    try {
      text = readFileSync(join(repoRoot, path), "utf8");
    } catch {
      continue; // a directory (submodule) or unreadable entry
    }
    if (ext === "" && !text.startsWith("#!") && !path.startsWith(".github/")) continue;
    files.push({ path, text, lang: detectLang(path, text) });
  }
  return { tracked, files };
}
