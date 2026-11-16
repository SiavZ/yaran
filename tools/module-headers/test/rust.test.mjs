/**
 * Rust frontend tests against a two-crate workspace fixture (test/fixtures/rust-ws).
 *
 * Pins the module-resolution rules (mod.rs and non-mod-rs layouts, both `#[path]` forms),
 * `use` trees (globs, `super::*`, cross-crate), qualified-path calls with no `use`, and the
 * External list (std plus declared dependencies only).
 *
 * <module-headers:begin>
 * Uses:
 * test/rust.test.mjs
 * ├── src/lang/rust-modules.mjs
 * ├── src/lang/rust.mjs
 * └── test/helpers.mjs
 * External: node:assert/strict, node:test
 *
 * Used by: entry point (node --test, via npm test in tools/module-headers)
 * <module-headers:end>
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureGraph, names } from "./helpers.mjs";
import { parseCargoToml } from "../src/lang/rust-modules.mjs";
import { pathSegs, extractRust } from "../src/lang/rust.mjs";

const A = "crates/alpha/src";
const graph = await fixtureGraph("rust-ws", ["rust"]);

test("crate root uses every module, both layouts and both #[path] forms", () => {
  assert.deepEqual(names(graph, `${A}/lib.rs`, "uses"), ["dirmod", "flat", "inline::inner", "nested", "placed"]);
  assert.deepEqual(graph.externals(`${A}/lib.rs`), ["serde"]);
});

test("non-mod-rs file nests its child in a directory named after it", () => {
  assert.deepEqual(names(graph, `${A}/flat.rs`, "uses"), ["flat::child"]);
  assert.deepEqual(names(graph, `${A}/flat/child.rs`, "uses"), ["flat"], "use super::* reaches the parent");
});

test("#[path] inside an inline block of a non-mod-rs file includes the file stem", () => {
  assert.deepEqual(names(graph, `${A}/nested.rs`, "uses"), ["dirmod", "nested::blk::deep"]);
  assert.equal(graph.rootName(`${A}/nested/blk/deep.rs`), "nested/blk/deep.rs");
});

test("qualified-path call with no use, crate-root item, and std external", () => {
  assert.deepEqual(names(graph, `${A}/dirmod/mod.rs`, "uses"), ["crate", "dirmod::leaf", "flat::child"]);
  assert.deepEqual(graph.externals(`${A}/dirmod/mod.rs`), ["std"]);
  assert.deepEqual(graph.externals(`${A}/dirmod/leaf.rs`), ["anyhow"], "macro path to a workspace dependency");
});

test("cross-crate use and qualified path name the other crate by package", () => {
  const main = "crates/beta/src/main.rs";
  assert.deepEqual(names(graph, main, "uses"), ["alpha-core::flat::child", "alpha-core::nested"]);
  assert.deepEqual(graph.externals(main), ["std"]);
  assert.deepEqual(names(graph, `${A}/flat/child.rs`, "usedBy"), ["beta-app[bin beta-app]", "dirmod", "flat"]);
  assert.deepEqual(names(graph, `${A}/lib.rs`, "usedBy"), ["alpha-core[test smoke]", "dirmod"]);
});

test("Cargo.toml reader finds package, targets and dependency names", () => {
  const m = parseCargoToml(`[package]\nname = "x-y"\nbuild = false\n[lib]\npath = "src/l.rs"\n[[bin]]\nname = "tool"\n[dependencies]\nfoo-bar = "1"\n[dependencies.baz]\nversion = "2"\n[target.'cfg(unix)'.dev-dependencies]\nqux = "1"\n`);
  assert.equal(m.pkg.name, "x-y");
  assert.equal(m.pkg.build, false);
  assert.equal(m.lib?.path, "src/l.rs");
  assert.deepEqual(m.bin, [{ name: "tool" }]);
  assert.deepEqual([...m.deps].sort(), ["baz", "foo_bar", "qux"]);
});

test("path segments drop generics, turbofish and whitespace", () => {
  assert.deepEqual(pathSegs("crate::a::B::<Vec<T>>::new"), ["crate", "a", "B", "new"]);
  assert.deepEqual(pathSegs("::std :: fmt"), ["std", "fmt"]);
  assert.deepEqual(pathSegs("crate::f::<fn() -> u8>"), ["crate", "f"]);
});

test("extraction records use renames as aliases and inline module context", async () => {
  const ex = await extractRust("mod t { use crate::x::y as z; fn f() { super::g(); } }");
  assert.deepEqual(ex.aliases, [{ name: "z", segs: ["crate", "x", "y"], inline: ["t"] }]);
  assert.deepEqual(ex.refs.map((r) => [r.segs.join("::"), r.inline.join("/")]), [["crate::x::y", "t"], ["super::g", "t"]]);
});
