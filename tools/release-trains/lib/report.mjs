/**
 * Check reporter shared by the release-train CLIs: collects one line per passed,
 * failed or skipped check and decides the exit code.
 *
 * - In dry-run mode a missing file is "skipped (not present yet)" instead of a failure,
 *   so the tooling can run before Phase 14's projects exist.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * lib/report.mjs
 * ├── check-association.mjs
 * ├── check-deploy-tree.mjs
 * └── check-versions.mjs
 * <module-headers:end>
 */

/** Creates a reporter; `dryRun` turns missing files into skips. */
export function createReport({ dryRun = false, log = console.log } = {}) {
  const failures = [];
  return {
    failures,
    ok: (msg) => log(`ok    ${msg}`),
    skip: (msg) => log(`skip  ${msg}`),
    fail: (msg) => {
      failures.push(msg);
      log(`FAIL  ${msg}`);
    },
    /** A required file is absent. */
    missing(rel, why = "") {
      const msg = `${rel} is missing${why ? ` (${why})` : ""}`;
      if (dryRun) log(`skip  ${rel}: not present yet`);
      else this.fail(msg);
    },
    /** Compares one value and reports it. */
    expect(label, actual, wanted) {
      if (actual === wanted) this.ok(`${label} = ${wanted}`);
      else this.fail(`${label} is ${actual === null || actual === undefined ? "absent" : JSON.stringify(actual)}, expected ${JSON.stringify(wanted)}`);
    },
  };
}
