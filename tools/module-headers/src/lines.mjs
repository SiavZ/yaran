/**
 * The 500-line gate and its ratchet baseline.
 *
 * A counted file over 500 lines fails unless the baseline lists it, and a baselined file
 * may never exceed its recorded count. Growth is accepted only through `--accept-growth
 * <path> --reason <text>`, which raises the count and appends the reason, so it shows up
 * as a reviewed diff to a CODEOWNERS-guarded file. Shrinking tightens the baseline on
 * `--lines --write`, and an entry whose file is gone fails the check.
 *
 * - Pure functions over a path -> line-count map and the baseline object.
 * - A renamed baselined file counts as new: entries are keyed by path.
 *
 * <module-headers:begin>
 * Uses:
 * src/lines.mjs
 * ├── src/config.mjs
 * └── src/headers.mjs
 * External: none
 *
 * Used by:
 * src/lines.mjs
 * ├── bin/module-headers.mjs
 * └── test/lines.test.mjs
 * <module-headers:end>
 */

import { CLI } from "./headers.mjs";
import { BASELINE_FILE } from "./config.mjs";

export const LIMIT = 500;

/** @typedef {import("./config.mjs").Baseline} Baseline */
/** @typedef {import("./headers.mjs").Problem} Problem */

/**
 * @param {Map<string, number>} counts every counted, non-exempt file
 * @param {Baseline} baseline
 * @param {{ selected?: (path: string) => boolean }} [opts] limit to some paths (skips stale-entry checks)
 * @returns {Problem[]}
 */
export function evaluateLines(counts, baseline, opts = {}) {
  /** @type {Problem[]} */
  const problems = [];
  for (const [path, n] of counts) {
    if (n <= LIMIT || (opts.selected && !opts.selected(path))) continue;
    const entry = baseline[path];
    if (!entry) {
      problems.push({
        file: path,
        rule: "new-oversize",
        message: `${n} lines; a new file may not exceed ${LIMIT} lines`,
        fix: `split it into modules of ${LIMIT} lines or fewer (a RENAMED baselined file is re-baselined with ${CLI} --accept-growth ${path} --reason "<phase NN: why>")`,
      });
    } else if (n > entry.lines) {
      problems.push({
        file: path,
        rule: "baseline-growth",
        message: `${n} lines, over its baseline of ${entry.lines}; an oversize file may not grow`,
        fix: `move the new behaviour into a new module and keep only minimal wiring here; if the wiring is genuinely needed: ${CLI} --accept-growth ${path} --reason "<phase NN: why>"`,
      });
    }
  }
  if (!opts.selected) {
    for (const path of Object.keys(baseline).sort()) {
      if (!counts.has(path)) {
        problems.push({
          file: BASELINE_FILE,
          rule: "stale-baseline",
          message: `lists "${path}", which is no longer a tracked, counted file`,
          fix: `${CLI} --lines --write`,
        });
      }
    }
  }
  return problems;
}

/**
 * Lower counts for files that shrank; drop entries for files gone or now within the limit.
 * @param {Map<string, number>} counts
 * @param {Baseline} baseline
 * @returns {Baseline}
 */
export function tightenBaseline(counts, baseline) {
  /** @type {Baseline} */
  const out = {};
  for (const [path, entry] of Object.entries(baseline)) {
    const n = counts.get(path);
    if (n === undefined || n <= LIMIT) continue;
    out[path] = { lines: Math.min(n, entry.lines), reason: entry.reason };
  }
  return out;
}

/**
 * Record accepted growth (or a re-baselined rename) for one file.
 * @param {Map<string, number>} counts
 * @param {Baseline} baseline
 * @param {string} path
 * @param {string} reason
 * @returns {Baseline}
 */
export function acceptGrowth(counts, baseline, path, reason) {
  const n = counts.get(path);
  if (n === undefined) throw new RangeError(`${path} is not a tracked file the line gate counts (git add it first)`);
  if (n <= LIMIT) throw new RangeError(`${path} has ${n} lines, within the ${LIMIT}-line limit; there is no growth to accept`);
  if (reason.trim() === "") throw new RangeError("--accept-growth needs a non-empty --reason naming the phase and why");
  const prev = baseline[path];
  return {
    ...baseline,
    [path]: { lines: n, reason: prev ? `${prev.reason}; ${reason.trim()}` : reason.trim() },
  };
}

/**
 * The baseline as it would be generated from scratch today, keeping existing reasons.
 * @param {Map<string, number>} counts
 * @param {Baseline} existing
 * @param {string} today YYYY-MM-DD
 * @returns {Baseline}
 */
export function initBaseline(counts, existing, today) {
  /** @type {Baseline} */
  const out = {};
  for (const [path, n] of counts) {
    if (n > LIMIT) out[path] = { lines: n, reason: existing[path]?.reason ?? `baseline ${today}` };
  }
  return out;
}

/**
 * Human-readable differences in paths and counts (reasons are not compared).
 * @param {Baseline} from
 * @param {Baseline} to
 * @returns {string[]}
 */
export function diffBaselines(from, to) {
  const out = [];
  for (const p of [...new Set([...Object.keys(from), ...Object.keys(to)])].sort()) {
    const a = from[p];
    const b = to[p];
    if (a && !b) out.push(`- ${p} (${a.lines})`);
    else if (!a && b) out.push(`+ ${p} (${b.lines})`);
    else if (a && b && a.lines !== b.lines) out.push(`~ ${p} (${a.lines} -> ${b.lines})`);
  }
  return out;
}
