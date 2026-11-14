/**
 * Line gate tests: the new-file hard fail, the ratchet, accepted growth, tightening,
 * stale entries and renames.
 *
 * <module-headers:begin>
 * Uses:
 * test/lines.test.mjs
 * └── src/lines.mjs
 * External: node:assert/strict, node:test
 *
 * Used by: entry point (node --test, via npm test in tools/module-headers)
 * <module-headers:end>
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateLines, tightenBaseline, acceptGrowth, initBaseline, diffBaselines, LIMIT } from "../src/lines.mjs";

const rules = (/** @type {{ rule: string }[]} */ ps) => ps.map((p) => p.rule);

test("a new file at 501 lines fails and one at 500 passes", () => {
  assert.deepEqual(rules(evaluateLines(new Map([["new.ts", 501]]), {})), ["new-oversize"]);
  assert.deepEqual(rules(evaluateLines(new Map([["ok.ts", LIMIT]]), {})), []);
});

test("a baselined file may not grow by one line", () => {
  const base = { "big.rs": { lines: 900, reason: "baseline 2026-11-14" } };
  assert.deepEqual(rules(evaluateLines(new Map([["big.rs", 900]]), base)), []);
  const grown = evaluateLines(new Map([["big.rs", 901]]), base);
  assert.deepEqual(rules(grown), ["baseline-growth"]);
  assert.match(grown[0].fix, /--accept-growth big\.rs --reason/);
});

test("accept-growth raises the count and appends the reason; then the check passes", () => {
  const base = { "big.rs": { lines: 900, reason: "baseline 2026-11-14" } };
  const counts = new Map([["big.rs", 903]]);
  const next = acceptGrowth(counts, base, "big.rs", "phase 10: wire the cloud leg");
  assert.deepEqual(next["big.rs"], { lines: 903, reason: "baseline 2026-11-14; phase 10: wire the cloud leg" });
  assert.deepEqual(evaluateLines(counts, next), []);
  assert.throws(() => acceptGrowth(counts, base, "big.rs", "  "), /--reason/);
  assert.throws(() => acceptGrowth(new Map([["s.rs", 10]]), {}, "s.rs", "x"), /within the 500-line limit/);
  assert.throws(() => acceptGrowth(counts, base, "nope.rs", "x"), /not a tracked file/);
});

test("a shrink tightens, and a file at or under the limit leaves the baseline", () => {
  const base = { "a.rs": { lines: 900, reason: "r" }, "b.rs": { lines: 700, reason: "r" }, "gone.rs": { lines: 800, reason: "r" } };
  const next = tightenBaseline(new Map([["a.rs", 850], ["b.rs", 400]]), base);
  assert.deepEqual(next, { "a.rs": { lines: 850, reason: "r" } });
});

test("a stale entry fails the full check but not a path-limited one", () => {
  const base = { "gone.rs": { lines: 800, reason: "r" } };
  assert.deepEqual(rules(evaluateLines(new Map(), base)), ["stale-baseline"]);
  assert.deepEqual(rules(evaluateLines(new Map(), base, { selected: () => true })), []);
});

test("a renamed baselined file counts as new", () => {
  const base = { "old/name.rs": { lines: 900, reason: "r" } };
  const problems = evaluateLines(new Map([["new/name.rs", 900]]), base);
  assert.deepEqual(rules(problems).sort(), ["new-oversize", "stale-baseline"]);
  const fixed = acceptGrowth(new Map([["new/name.rs", 900]]), tightenBaseline(new Map([["new/name.rs", 900]]), base), "new/name.rs", "phase 14: git mv into packages/ui-kit");
  assert.deepEqual(evaluateLines(new Map([["new/name.rs", 900]]), fixed), []);
});

test("init keeps existing reasons and the dry-run diff is empty when nothing moved", () => {
  const counts = new Map([["a.rs", 600], ["b.rs", 100]]);
  const existing = { "a.rs": { lines: 600, reason: "baseline 2026-11-14; phase 09: x" } };
  const next = initBaseline(counts, existing, "2030-01-01");
  assert.deepEqual(next, existing);
  assert.deepEqual(diffBaselines(existing, next), []);
  assert.deepEqual(diffBaselines({}, initBaseline(new Map([["c.rs", 501]]), {}, "2030-01-01")), ["+ c.rs (501)"]);
});
