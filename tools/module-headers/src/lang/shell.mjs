/**
 * Shell frontend: `source F` and `. F` with literal or script-directory-relative paths.
 *
 * A path built from the script's own directory (`$(dirname "$0")`, `${BASH_SOURCE%/*}`,
 * `$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)`, or a variable assigned one of those)
 * resolves against the script's directory. A plain relative literal is tried against the
 * script's directory, then the repository root.
 *
 * - Anything still computed after that (`$LIB/x.sh`) is listed as `unresolved: <expr>`,
 *   never dropped silently. Absolute and `~` paths go to External.
 * - Node names are repo-relative paths.
 *
 * <module-headers:begin>
 * Uses:
 * src/lang/shell.mjs
 * └── src/parsers.mjs
 * External: node:path
 *
 * Used by:
 * src/lang/shell.mjs
 * ├── src/build.mjs
 * └── test/shell.test.mjs
 * <module-headers:end>
 */

import { posix } from "node:path";
import { parse } from "../parsers.mjs";

const SELF = String.raw`"?\$(?:\{BASH_SOURCE(?:\[0\])?\}|BASH_SOURCE|0|\{0\})"?`;
const DIRNAME = String.raw`\$\(\s*dirname\s+(?:--\s+)?${SELF}\s*\)`;
const DIR_PATTERNS = [
  new RegExp(String.raw`\$\(\s*cd\s+(?:--\s+)?"?${DIRNAME}"?\s*(?:&&|;)\s*pwd(?:\s+-P)?\s*\)`, "g"),
  new RegExp(DIRNAME, "g"),
  /\$\{BASH_SOURCE(?:\[0\])?%\/\*\}/g,
  /\$\{0%\/\*\}/g,
];
const DIR = "\u0000DIR\u0000";

/** @typedef {{ sources: string[], dirVars: string[] }} ShellExtract */

/**
 * @param {string} text
 * @returns {Promise<ShellExtract>}
 */
export async function extractShell(text) {
  const tree = await parse("shell", text);
  /** @type {ShellExtract} */
  const ex = { sources: [], dirVars: [] };
  for (const node of tree.rootNode.descendantsOfType(["command", "variable_assignment"])) {
    if (!node) continue;
    if (node.type === "variable_assignment") {
      const name = node.childForFieldName("name")?.text;
      const value = node.childForFieldName("value")?.text;
      if (name && value && unquote(substituteDir(value)) === DIR) ex.dirVars.push(name);
      continue;
    }
    const cmd = node.childForFieldName("name")?.text;
    if (cmd !== "source" && cmd !== ".") continue;
    const arg = node.childrenForFieldName("argument").find((c) => c !== null);
    if (arg) ex.sources.push(arg.text);
  }
  tree.delete();
  return ex;
}

/** @param {string} s */
function substituteDir(s) {
  let out = s;
  for (const re of DIR_PATTERNS) out = out.replace(re, DIR);
  return out;
}

/** @param {string} s */
function unquote(s) {
  return s.replace(/["']/g, "");
}

/**
 * Resolve one sourced expression.
 * @param {string} file the sourcing script
 * @param {string} expr argument text as written
 * @param {string[]} dirVars variables holding the script directory
 * @param {Set<string>} tracked
 * @returns {{ file: string } | { external: string } | { unresolved: string }}
 */
export function resolveSource(file, expr, dirVars, tracked) {
  let t = substituteDir(expr);
  for (const v of dirVars) t = t.replace(new RegExp(String.raw`\$\{?${v}\}?(?![A-Za-z0-9_])`, "g"), DIR);
  t = unquote(t);
  if (/[$`*?]/.test(t)) return { unresolved: expr };
  const dir = posix.dirname(file);
  if (t.startsWith(DIR)) {
    const p = posix.normalize(posix.join(dir, t.slice(DIR.length)));
    return tracked.has(p) ? { file: p } : { unresolved: expr };
  }
  if (t.startsWith("/") || t.startsWith("~")) return { external: t };
  for (const p of [posix.normalize(posix.join(dir, t)), posix.normalize(t)]) if (tracked.has(p)) return { file: p };
  return { unresolved: expr };
}

/**
 * @param {import("../graph.mjs").Graph} graph
 * @param {{ files: Map<string, string>, tracked: Set<string>,
 *           extract: (file: string) => Promise<ShellExtract> }} ctx
 */
export async function addShellGraph(graph, { files, tracked, extract }) {
  const shellFiles = [...files.keys()];
  for (const f of shellFiles) graph.addNode(f, (t) => t, f);
  for (const file of shellFiles) {
    const ex = await extract(file);
    for (const expr of ex.sources) {
      const r = resolveSource(file, expr, ex.dirVars, tracked);
      if ("file" in r) graph.addEdge(file, r.file);
      else if ("external" in r) graph.addExternal(file, r.external);
      else graph.addUnresolved(file, r.unresolved);
    }
  }
}
