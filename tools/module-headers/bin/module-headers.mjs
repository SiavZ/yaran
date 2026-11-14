#!/usr/bin/env node
/**
 * module-headers CLI: generate and check module-header blocks, and run the 500-line gate.
 *
 * Run from anywhere inside the repository: `node tools/module-headers/bin/module-headers.mjs
 * --check [<path>…]`. Optional paths limit which in-scope files are written or checked; the
 * graph is still built over every tracked file, so `Used by` stays complete.
 *
 * - Exit codes: 0 ok, 1 drift or a rule violation, 2 usage or internal error.
 * - `--write` changes only generated blocks; `--lines --write`, `--accept-growth` and
 *   `--init-baseline` change only baseline-oversize.json.
 * - The line-gate modes load no npm dependency (the graph builder is imported lazily), so
 *   CI's File length job needs no `npm ci`.
 *
 * <module-headers:begin>
 * Uses:
 * bin/module-headers.mjs
 * ├── src/build.mjs
 * ├── src/config.mjs
 * ├── src/files.mjs
 * ├── src/headers.mjs
 * └── src/lines.mjs
 * External: node:fs, node:path, node:util
 *
 * Used by: entry point (CLI: node tools/module-headers/bin/module-headers.mjs, via npm run check / write / lines, make headers-check and gates.yml)
 * <module-headers:end>
 */

import { realpathSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { UsageError, loadScope, compileScope, loadBaseline, saveBaseline, BASELINE_FILE } from "../src/config.mjs";
import { gitTopLevel, readRepoFiles, isLineCounted, isExempt, countLines } from "../src/files.mjs";
import { checkFile, expectedBlock, manifestProblems } from "../src/headers.mjs";
import { evaluateLines, tightenBaseline, acceptGrowth, initBaseline, diffBaselines } from "../src/lines.mjs";

const USAGE = `usage: module-headers.mjs <mode> [--json] [<path>…]
modes:
  --check                          check every in-scope file's block (default paths: all)
  --write                          rewrite blocks to match the import graph
  --lines --check                  run the 500-line gate against the baseline
  --lines --write                  tighten the baseline after files shrank or went away
  --accept-growth <path> --reason <text>
                                   record reviewed growth of an oversize file
  --init-baseline [--dry-run]      regenerate the baseline (--dry-run prints the diff)
  --explain <path>                 print one file's edges and expected block`;

/** @typedef {import("../src/headers.mjs").Problem} Problem */

/**
 * @param {string[]} argv
 * @param {string} cwd
 * @returns {Promise<number>}
 */
async function main(argv, cwd) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        check: { type: "boolean" },
        write: { type: "boolean" },
        lines: { type: "boolean" },
        "accept-growth": { type: "string" },
        reason: { type: "string" },
        "init-baseline": { type: "boolean" },
        "dry-run": { type: "boolean" },
        explain: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    throw new UsageError(`${/** @type {Error} */ (e).message}\n${USAGE}`);
  }
  const { values: o, positionals } = parsed;
  if (o.help) {
    console.log(USAGE);
    return 0;
  }
  const repoRoot = gitTopLevel(cwd);
  const here = realpathSync(cwd);
  /** @param {string} p */
  const toRepo = (p) => relative(repoRoot, resolve(here, p)).split("\\").join("/");
  const filters = positionals.map(toRepo);
  /** @param {string} path */
  const selected = (path) => filters.length === 0 || filters.some((f) => f === "" || path === f || path.startsWith(`${f}/`));

  const repo = readRepoFiles(repoRoot);
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const f of repo.files) if (isLineCounted(f.path, f.text) && !isExempt(f.path, f.text)) counts.set(f.path, countLines(f.text));
  const baseline = loadBaseline(repoRoot);

  if (o["accept-growth"] !== undefined) {
    if (o.reason === undefined) throw new UsageError("--accept-growth needs --reason \"<phase NN: why>\"");
    const path = toRepo(o["accept-growth"]);
    let next;
    try {
      next = acceptGrowth(counts, baseline, path, o.reason);
    } catch (e) {
      throw new UsageError(/** @type {Error} */ (e).message);
    }
    saveBaseline(repoRoot, next);
    console.log(`${BASELINE_FILE}: ${path} accepted at ${next[path].lines} lines (${o.reason.trim()})`);
    return 0;
  }

  if (o["init-baseline"]) {
    const next = initBaseline(counts, baseline, new Date().toISOString().slice(0, 10));
    const diff = diffBaselines(baseline, next);
    if (o["dry-run"]) {
      for (const d of diff) console.log(d);
      if (diff.length) console.error(`${BASELINE_FILE} differs from the tree in ${diff.length} entr${diff.length === 1 ? "y" : "ies"}`);
      return diff.length ? 1 : 0;
    }
    saveBaseline(repoRoot, next);
    console.log(`${BASELINE_FILE}: ${Object.keys(next).length} oversize files recorded`);
    return 0;
  }

  if (o.lines) {
    if (o.write) {
      const next = tightenBaseline(counts, baseline);
      const diff = diffBaselines(baseline, next);
      if (diff.length) saveBaseline(repoRoot, next);
      for (const d of diff) console.log(d);
      console.log(`${BASELINE_FILE}: ${diff.length ? `${diff.length} entries tightened` : "already tight"}`);
      return 0;
    }
    const problems = evaluateLines(counts, baseline, filters.length ? { selected } : {});
    return report(problems, [], o.json, `line gate: ${counts.size} counted files, ${Object.keys(baseline).length} baselined`);
  }

  const scope = compileScope(loadScope(repoRoot));
  const { buildGraph } = await import("../src/build.mjs");
  if (o.explain !== undefined) {
    const path = toRepo(o.explain);
    const f = repo.files.find((x) => x.path === path);
    if (!f || !f.lang) throw new UsageError(`${path} is not a tracked file in a supported language`);
    const graph = await buildGraph(repoRoot, repo, new Set([f.lang]));
    const block = expectedBlock(graph, path, scope.entryPoint(path));
    console.log(`${path} (${f.lang}, ${scope.inScope(path) ? "in scope" : "not in scope"})`);
    for (const line of block) console.log(`  ${line}`);
    return 0;
  }

  if (!o.check && !o.write) throw new UsageError(`choose a mode\n${USAGE}`);
  if (o.check && o.write) throw new UsageError("--check and --write are mutually exclusive");
  const files = repo.files.filter((f) => f.lang && scope.inScope(f.path) && !isExempt(f.path, f.text) && selected(f.path));
  const langs = new Set(files.map((f) => /** @type {import("../src/files.mjs").Lang} */ (f.lang)));
  const graph = await buildGraph(repoRoot, repo, langs);
  /** @type {Problem[]} */
  const problems = filters.length ? [] : manifestProblems(scope, repo.tracked);
  const written = [];
  for (const f of files) {
    const r = checkFile({ path: f.path, text: f.text, lang: /** @type {string} */ (f.lang) }, graph, scope.entryPoint(f.path), Boolean(o.write));
    if (o.write && r.text !== f.text) {
      writeFileSync(join(repoRoot, f.path), r.text);
      written.push(f.path);
    }
    problems.push(...r.problems);
  }
  return report(problems, written, o.json, `${files.length} in-scope files ${o.write ? "written" : "checked"}`);
}

/**
 * @param {Problem[]} problems
 * @param {string[]} written
 * @param {boolean | undefined} json
 * @param {string} summary
 */
function report(problems, written, json, summary) {
  if (json) {
    console.log(JSON.stringify({ ok: problems.length === 0, problems, written }, null, 2));
  } else {
    for (const w of written) console.log(`wrote ${w}`);
    for (const p of problems) console.log(`${p.file}: ${p.rule}: ${p.message}\n    fix: ${p.fix}`);
    const files = new Set(problems.map((p) => p.file)).size;
    console.log(problems.length ? `module-headers: ${problems.length} problem(s) in ${files} file(s); ${summary}` : `module-headers: OK; ${summary}`);
  }
  return problems.length ? 1 : 0;
}

main(process.argv.slice(2), process.cwd()).then(
  (code) => process.exit(code),
  (e) => {
    if (e instanceof UsageError) console.error(`module-headers: ${e.message}`);
    else console.error(`module-headers: internal error: ${e?.stack ?? e}`);
    process.exit(2);
  },
);
