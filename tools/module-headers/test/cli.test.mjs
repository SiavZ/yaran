/**
 * CLI tests: run the real bin against a temporary git repository copied from
 * test/fixtures/mixed and assert exit codes and output for every rule.
 *
 * - Each test gets a fresh copy, so tests are independent and can run in any order.
 *
 * <module-headers:begin>
 * Uses:
 * test/cli.test.mjs
 * └── test/helpers.mjs
 * External: node:assert/strict, node:child_process, node:fs, node:os, node:path, node:test, node:url
 *
 * Used by: entry point (node --test, via npm test in tools/module-headers)
 * <module-headers:end>
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURES } from "./helpers.mjs";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "module-headers.mjs");

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "mh-cli-"));
  cpSync(join(FIXTURES, "mixed"), dir, { recursive: true });
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: dir });
  add(dir);
  return dir;
}

/** @param {string} dir */
function add(dir) {
  execFileSync("git", ["add", "-A"], { cwd: dir });
}

/**
 * @param {string} dir
 * @param {...string} args
 */
function run(dir, ...args) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** @param {string} dir */
function written(dir) {
  const r = run(dir, "--write");
  assert.equal(r.code, 0, r.out);
  return dir;
}

test("--write then --check passes, and a second --write changes nothing", () => {
  const dir = written(repo());
  const main = readFileSync(join(dir, "src/main.ts"), "utf8");
  assert.match(main, /Used by: entry point \(node src\/main\.ts\)/);
  assert.match(readFileSync(join(dir, "src/lib.sh"), "utf8"), /# └── src\/run\.sh/);
  assert.equal(run(dir, "--check").code, 0);
  const again = run(dir, "--write");
  assert.equal(again.code, 0);
  assert.doesNotMatch(again.out, /^wrote /m);
});

test("a missing block fails and names the file and the fix command", () => {
  const dir = written(repo());
  writeFileSync(join(dir, "src/util.ts"), "/**\n * Shared helper.\n */\n\nexport const util = 1;\n");
  const r = run(dir, "--check");
  assert.equal(r.code, 1);
  assert.match(r.out, /src\/util\.ts: missing-block: .*\n\s+fix: node tools\/module-headers\/bin\/module-headers\.mjs --write src\/util\.ts/);
});

test("a stale Uses entry and a stale Used by entry both fail", () => {
  const dir = written(repo());
  const path = join(dir, "src/main.ts");
  writeFileSync(path, readFileSync(path, "utf8").replace('import { util } from "./util.ts";\nconsole.log(util);', 'console.log("no import");'));
  const r = run(dir, "--check");
  assert.equal(r.code, 1);
  assert.match(r.out, /src\/main\.ts: stale-uses: the Uses tree disagrees/);
  assert.match(r.out, /src\/util\.ts: stale-used-by: the Used by tree disagrees/);
  assert.match(r.out, /fix: node tools\/module-headers\/bin\/module-headers\.mjs --write src\/main\.ts/);
});

test("a missing title fails even after --write adds the block", () => {
  const dir = written(repo());
  writeFileSync(join(dir, "src/notitle.ts"), "export const n = 1;\n");
  appendFileSync(join(dir, "src/main.ts"), 'import { n } from "./notitle.ts";\nconsole.log(n);\n');
  add(dir);
  const w = run(dir, "--write");
  assert.equal(w.code, 1);
  assert.match(w.out, /src\/notitle\.ts: missing-title/);
  const c = run(dir, "--check");
  assert.equal(c.code, 1);
  assert.match(c.out, /src\/notitle\.ts: missing-title: .*\n\s+fix: write a title line/);
  assert.doesNotMatch(c.out, /stale-/);
});

test("an orphan that is not a declared entry point fails", () => {
  const dir = written(repo());
  writeFileSync(join(dir, "src/orphan.ts"), "/**\n * Nobody imports me.\n */\nexport const o = 1;\n");
  add(dir);
  const r = run(dir, "--write");
  assert.equal(r.code, 1);
  assert.match(r.out, /src\/orphan\.ts: orphan: .*\n\s+fix: .*"src\/orphan\.ts": "<how it is launched>".*tools\/module-headers\/scope\.json/);
});

test("positional paths limit what is checked", () => {
  const dir = written(repo());
  writeFileSync(join(dir, "src/util.ts"), "/**\n * Shared helper.\n */\nexport const util = 1;\n");
  assert.equal(run(dir, "--check", "src/main.ts").code, 0);
  assert.equal(run(dir, "--check", "src").code, 1);
  const json = JSON.parse(run(dir, "--check", "--json").out);
  assert.equal(json.ok, false);
  assert.deepEqual(json.problems.map((/** @type {{rule: string}} */ p) => p.rule), ["missing-block"]);
});

test("line gate: new oversize, accepted growth, further growth, stale entry, dry-run diff", () => {
  const dir = written(repo());
  const big = join(dir, "src/big.sh");
  writeFileSync(big, "# big\n".repeat(501));
  add(dir);
  let r = run(dir, "--lines", "--check");
  assert.equal(r.code, 1);
  assert.match(r.out, /src\/big\.sh: new-oversize: 501 lines/);
  assert.equal(run(dir, "--init-baseline", "--dry-run").code, 1);

  r = run(dir, "--accept-growth", "src/big.sh");
  assert.equal(r.code, 2, "a reason is required");
  r = run(dir, "--accept-growth", "src/big.sh", "--reason", "phase 99: test wiring");
  assert.equal(r.code, 0, r.out);
  const base = JSON.parse(readFileSync(join(dir, "tools/module-headers/baseline-oversize.json"), "utf8"));
  assert.deepEqual(base, { "src/big.sh": { lines: 501, reason: "phase 99: test wiring" } });
  assert.equal(run(dir, "--lines", "--check").code, 0);
  assert.equal(run(dir, "--init-baseline", "--dry-run").code, 0);

  appendFileSync(big, "# one more\n");
  r = run(dir, "--lines", "--check");
  assert.equal(r.code, 1);
  assert.match(r.out, /baseline-growth: 502 lines, over its baseline of 501/);

  rmSync(big);
  add(dir);
  r = run(dir, "--lines", "--check");
  assert.equal(r.code, 1);
  assert.match(r.out, /stale-baseline: lists "src\/big\.sh"/);
  assert.equal(run(dir, "--lines", "--write").code, 0);
  assert.equal(run(dir, "--lines", "--check").code, 0);
});

test("usage errors exit 2", () => {
  const dir = repo();
  assert.equal(run(dir).code, 2);
  assert.equal(run(dir, "--check", "--write").code, 2);
  assert.equal(run(dir, "--bogus").code, 2);
});
