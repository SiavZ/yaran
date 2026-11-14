/**
 * Builds the import graph for the requested languages over every tracked file.
 *
 * The graph always covers every tracked file of a language, so an in-scope file's
 * `Used by` names importers outside scope. Languages with no file to write or check are
 * skipped entirely, which is what keeps a run fast while (say) no Swift exists.
 *
 * - This tool's own test fixtures are synthetic repositories (a Kotlin package, a Swift
 *   `App` module, Cargo crates) and are left out of the real graph so they can never
 *   lend a real file a false edge.
 * - Each file is parsed at most once per run (extractions are memoized).
 * - Parse failures are not fatal: tree-sitter recovers, and the graph uses what it found.
 *
 * <module-headers:begin>
 * Uses:
 * src/build.mjs
 * ├── src/graph.mjs
 * ├── src/lang/kotlin.mjs
 * ├── src/lang/rust.mjs
 * ├── src/lang/shell.mjs
 * ├── src/lang/swift.mjs
 * └── src/lang/typescript.mjs
 * External: node:fs, node:path
 *
 * Used by:
 * src/build.mjs
 * ├── bin/module-headers.mjs
 * └── test/helpers.mjs
 * <module-headers:end>
 */

import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { Graph } from "./graph.mjs";
import { addRustGraph, extractRust } from "./lang/rust.mjs";
import { addTsGraph } from "./lang/typescript.mjs";
import { addKotlinGraph, extractKotlin } from "./lang/kotlin.mjs";
import { addSwiftGraph, extractSwift } from "./lang/swift.mjs";
import { addShellGraph, extractShell } from "./lang/shell.mjs";

export const OWN_FIXTURES = "tools/module-headers/test/fixtures/";

/**
 * @template T
 * @param {Map<string, string>} texts
 * @param {(text: string) => Promise<T>} fn
 * @returns {(file: string) => Promise<T>}
 */
function memo(texts, fn) {
  /** @type {Map<string, Promise<T>>} */
  const cache = new Map();
  return (file) => {
    let p = cache.get(file);
    if (!p) {
      const text = texts.get(file);
      if (text === undefined) return /** @type {Promise<any>} */ (Promise.resolve(undefined));
      cache.set(file, (p = fn(text)));
    }
    return p;
  };
}

/**
 * @param {string} repoRoot
 * @param {{ tracked: Set<string>, files: import("./files.mjs").RepoFile[] }} repo
 * @param {Set<import("./files.mjs").Lang>} langs
 */
export async function buildGraph(repoRoot, repo, langs) {
  const keep = (/** @type {string} */ p) => !p.startsWith(OWN_FIXTURES);
  const tracked = new Set([...repo.tracked].filter(keep));
  const files = repo.files.filter((f) => keep(f.path));
  const graph = new Graph();
  /** @param {import("./files.mjs").Lang} lang */
  const textsOf = (lang) => new Map(files.filter((f) => f.lang === lang).map((f) => [f.path, f.text]));

  if (langs.has("rust")) {
    const texts = textsOf("rust");
    for (const p of tracked) {
      if (posix.basename(p) === "Cargo.toml") texts.set(p, readFileSync(join(repoRoot, p), "utf8"));
    }
    await addRustGraph(graph, { files: texts, tracked, extract: memo(texts, extractRust) });
  }
  if (langs.has("ts")) addTsGraph(graph, { repoRoot, files: textsOf("ts"), tracked });
  if (langs.has("kotlin")) {
    const texts = textsOf("kotlin");
    await addKotlinGraph(graph, { files: texts, extract: memo(texts, extractKotlin) });
  }
  if (langs.has("swift")) {
    const texts = textsOf("swift");
    await addSwiftGraph(graph, { files: texts, tracked, extract: memo(texts, extractSwift) });
  }
  if (langs.has("shell")) {
    const texts = textsOf("shell");
    await addShellGraph(graph, { files: texts, tracked, extract: memo(texts, extractShell) });
  }
  return graph;
}
