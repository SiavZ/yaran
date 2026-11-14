/**
 * Test helpers: load a fixture directory as if it were a repository, and build its graph.
 *
 * Fixtures are plain directories under test/fixtures; this walks one and returns the same
 * `{ tracked, files }` shape `readRepoFiles` returns for a real checkout, so the frontends
 * run unchanged against it without a git repository.
 *
 * - Read-only over the fixture tree.
 *
 * <module-headers:begin>
 * Uses:
 * test/helpers.mjs
 * ├── src/build.mjs
 * └── src/files.mjs
 * External: node:fs, node:path, node:url
 *
 * Used by:
 * test/helpers.mjs
 * ├── test/block.test.mjs
 * ├── test/cli.test.mjs
 * ├── test/kotlin.test.mjs
 * ├── test/rust.test.mjs
 * ├── test/shell.test.mjs
 * ├── test/swift.test.mjs
 * └── test/typescript.test.mjs
 * <module-headers:end>
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { detectLang } from "../src/files.mjs";
import { buildGraph } from "../src/build.mjs";

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/**
 * @param {string} dir absolute fixture directory
 * @returns {{ tracked: Set<string>, files: import("../src/files.mjs").RepoFile[] }}
 */
export function loadFixture(dir) {
  const tracked = new Set();
  /** @param {string} d */
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const abs = join(d, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else tracked.add(relative(dir, abs).split("\\").join("/"));
    }
  };
  walk(dir);
  const files = [...tracked].sort().map((path) => {
    const text = readFileSync(join(dir, path), "utf8");
    return { path, text, lang: detectLang(path, text) };
  });
  return { tracked, files };
}

/**
 * Build a fixture's graph for the given languages.
 * @param {string} name fixture directory under test/fixtures
 * @param {import("../src/files.mjs").Lang[]} langs
 */
export async function fixtureGraph(name, langs) {
  const dir = join(FIXTURES, name);
  return buildGraph(dir, loadFixture(dir), new Set(langs));
}

/**
 * `name` strings of one direction of a file's edges, `(inferred)` appended where marked.
 * @param {import("../src/graph.mjs").Graph} graph
 * @param {string} file
 * @param {"uses" | "usedBy"} dir
 */
export function names(graph, file, dir) {
  return graph.entries(file, dir).map((e) => (e.inferred ? `${e.name} (inferred)` : e.name));
}
