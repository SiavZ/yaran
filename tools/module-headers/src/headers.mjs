/**
 * The header rules: what each in-scope file's block must say, and every way it can be wrong.
 *
 * For one file this renders the expected block from the graph (keeping the author's
 * annotations), compares it with what the file holds, and either reports the drift or
 * rewrites the block. It also enforces the rules the graph cannot fix: a title line in the
 * prose, and no orphans (a file nothing imports must be a declared entry point).
 *
 * - Every problem names the file, the rule and the exact command or edit that fixes it.
 * - Write mode only ever changes the delimited block.
 *
 * <module-headers:begin>
 * Uses:
 * src/headers.mjs
 * ├── src/block.mjs
 * ├── src/config.mjs
 * └── src/render.mjs
 * External: none
 *
 * Used by:
 * src/headers.mjs
 * ├── bin/module-headers.mjs
 * ├── src/lines.mjs
 * └── test/block.test.mjs
 * <module-headers:end>
 */

import { renderBlock, parseAnnotations, sections } from "./render.mjs";
import { findHeader, hasTitle, blockContent, applyBlock } from "./block.mjs";
import { SCOPE_FILE } from "./config.mjs";

export const CLI = "node tools/module-headers/bin/module-headers.mjs";

/** @typedef {{ file: string, rule: string, message: string, fix: string }} Problem */

/**
 * @param {import("./graph.mjs").Graph} graph
 * @param {string} file
 * @param {string | undefined} entryPoint
 * @param {import("./render.mjs").Annotations} [annotations]
 */
export function expectedBlock(graph, file, entryPoint, annotations) {
  return renderBlock({
    root: graph.rootName(file),
    uses: graph.entries(file, "uses"),
    unresolved: graph.unresolvedOf(file),
    external: graph.externals(file),
    usedBy: graph.entries(file, "usedBy"),
    entryPoint,
    annotations,
  });
}

/**
 * Check (and in write mode, fix) one in-scope file.
 * @param {{ path: string, text: string, lang: string }} f
 * @param {import("./graph.mjs").Graph} graph
 * @param {string | undefined} entryPoint
 * @param {boolean} write
 * @returns {{ problems: Problem[], text: string }}
 */
export function checkFile(f, graph, entryPoint, write) {
  /** @type {Problem[]} */
  const problems = [];
  const fixWrite = `${CLI} --write ${f.path}`;
  const lines = f.text.split("\n");
  const h = findHeader(lines, f.lang);
  let text = f.text;

  if (h && h.begin >= 0 && h.finish < 0) {
    problems.push({
      file: f.path,
      rule: "unterminated-block",
      message: "the <module-headers:begin> marker has no <module-headers:end> in the same header comment",
      fix: "restore the end marker (or delete the partial block), then run " + fixWrite,
    });
    return { problems, text };
  }

  const present = h !== null && h.begin >= 0;
  const existing = present ? blockContent(lines, /** @type {import("./block.mjs").Header} */ (h)) : null;
  const expected = expectedBlock(graph, f.path, entryPoint, existing ? parseAnnotations(existing) : undefined);

  if (!existing) {
    if (write) text = applyBlock(text, f.lang, expected);
    else problems.push({ file: f.path, rule: "missing-block", message: "no module-headers block in the header comment", fix: fixWrite });
  } else {
    const a = sections(existing);
    const b = sections(expected);
    const stale = [
      ["stale-uses", "the Uses tree", a.uses !== b.uses],
      ["stale-external", "the External list", a.external !== b.external],
      ["stale-used-by", "the Used by tree", a.usedBy !== b.usedBy],
    ].filter(([, , bad]) => bad);
    const exact = existing.join("\n") === expected.join("\n");
    if (write && !exact) text = applyBlock(text, f.lang, expected);
    else if (!write) {
      for (const [rule, what] of stale) {
        problems.push({ file: f.path, rule: String(rule), message: `${what} disagrees with the import graph`, fix: fixWrite });
      }
    }
  }

  const after = text.split("\n");
  if (!hasTitle(after, findHeader(after, f.lang))) {
    problems.push({
      file: f.path,
      rule: "missing-title",
      message: "the header comment has no title line before the block",
      fix: "write a title line and a one-paragraph purpose statement above <module-headers:begin> (00-CONVENTIONS.md §2)",
    });
  }
  if (entryPoint === undefined && graph.entries(f.path, "usedBy").length === 0) {
    problems.push({
      file: f.path,
      rule: "orphan",
      message: "no first-party file imports this file and it is not a declared entry point",
      fix: `import it from first-party code, or add "${f.path}": "<how it is launched>" to entryPoints in ${SCOPE_FILE}`,
    });
  }
  return { problems, text };
}

/**
 * Manifest entries that no longer point at anything.
 * @param {ReturnType<typeof import("./config.mjs").compileScope>} scope
 * @param {Set<string>} tracked
 * @returns {Problem[]}
 */
export function manifestProblems(scope, tracked) {
  /** @type {Problem[]} */
  const problems = [];
  for (const p of scope.optIn) {
    if (!tracked.has(p)) {
      problems.push({ file: SCOPE_FILE, rule: "stale-opt-in", message: `optIn names "${p}", which is not a tracked file`, fix: `fix the path in ${SCOPE_FILE} (files never leave optIn; a renamed file is renamed there)` });
    }
  }
  for (const g of scope.entryGlobs) {
    if (![...tracked].some((p) => scope.entryMatches(g, p))) {
      problems.push({ file: SCOPE_FILE, rule: "stale-entry-point", message: `entryPoints names "${g}", which matches no tracked file`, fix: `fix or remove that entry in ${SCOPE_FILE}` });
    }
  }
  return problems;
}
