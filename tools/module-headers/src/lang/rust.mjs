/**
 * Rust frontend: extracts `mod`, `use` trees and qualified paths, and resolves them to files.
 *
 * Extraction is per file and pure (so it can be cached by content hash). Resolution runs
 * after the module tree is known: a path resolves by its LONGEST module prefix that maps to
 * a file, starting from `crate::`, `self::`, `super::`, a child module, a `use` alias, or a
 * workspace crate name (`yaran_core::…`). Declared dependencies and std go to External.
 *
 * - Paths inside macro token trees (`format!("{}", crate::x())`) are not seen; tree-sitter
 *   does not parse macro arguments. Documented in docs/contributing/module-headers.md.
 * - A path whose first segment is none of the above (a local type, `Self`) is ignored.
 *
 * <module-headers:begin>
 * Uses:
 * src/lang/rust.mjs
 * ├── src/lang/rust-modules.mjs
 * └── src/parsers.mjs
 * External: node:path, web-tree-sitter
 *
 * Used by:
 * src/lang/rust.mjs
 * ├── src/build.mjs
 * └── test/rust.test.mjs
 * <module-headers:end>
 */

import { posix } from "node:path";
import { Query } from "web-tree-sitter";
import { parse } from "../parsers.mjs";
import { discoverCrates, buildModuleTree, modKey } from "./rust-modules.mjs";

const QUERY = `
(mod_item) @mod
(use_declaration) @use
(scoped_identifier) @path
(scoped_type_identifier) @path
(extern_crate_declaration) @extern
`;
const STD = new Set(["std", "core", "alloc", "proc_macro", "test"]);
const SCOPED = new Set(["scoped_identifier", "scoped_type_identifier"]);
/** @type {Query | undefined} */
let query;

/**
 * @typedef {{ segs: string[], inline: string[], use: boolean }} Ref
 * @typedef {{ mods: import("./rust-modules.mjs").ModDecl[], refs: Ref[],
 *             aliases: { name: string, segs: string[], inline: string[] }[], externs: string[] }} RustExtract
 */

/**
 * Split a path's source text into segments, dropping generics and whitespace.
 * @param {string} text
 */
export function pathSegs(text) {
  let out = "";
  let depth = 0;
  for (const ch of text.replace(/\s+/g, "").replace(/->/g, "")) {
    if (ch === "<") depth++;
    else if (ch === ">" && depth > 0) depth--;
    else if (depth === 0) out += ch;
  }
  return out.replace(/^::/, "").split("::").filter(Boolean);
}

/**
 * @param {string} text
 * @returns {Promise<RustExtract>}
 */
export async function extractRust(text) {
  const tree = await parse("rust", text);
  query ??= new Query(tree.language, QUERY);
  /** @type {RustExtract} */
  const ex = { mods: [], refs: [], aliases: [], externs: [] };
  /** @type {{ name: string, end: number }[]} */
  const inline = [];
  let useEnd = -1;
  const seen = new Set();
  /** @param {string[]} segs @param {boolean} use */
  const addRef = (segs, use) => {
    if (segs.length === 0 || !/^[a-z_][a-z0-9_]*$/.test(segs[0])) return;
    const stack = inline.map((m) => m.name);
    const key = `${stack.join("/")}|${segs.join("::")}|${use}`;
    if (seen.has(key)) return;
    seen.add(key);
    ex.refs.push({ segs, inline: stack, use });
  };
  for (const { name, node } of query.captures(tree.rootNode)) {
    while (inline.length && inline[inline.length - 1].end <= node.startIndex) inline.pop();
    if (name === "mod") {
      const modName = node.childForFieldName("name")?.text;
      if (!modName) continue;
      const body = node.childForFieldName("body") !== null;
      ex.mods.push({ name: modName, inline: inline.map((m) => m.name), pathAttr: pathAttrOf(node), body });
      if (body) inline.push({ name: modName, end: node.endIndex });
    } else if (name === "use") {
      useEnd = node.endIndex;
      const arg = node.childForFieldName("argument");
      /** @type {{ segs: string[], alias: string | null, glob: boolean }[]} */
      const out = [];
      if (arg) expandUse(arg, [], out);
      for (const u of out) {
        addRef(u.segs, true);
        if (u.alias && u.alias !== "_" && !u.glob) {
          ex.aliases.push({ name: u.alias, segs: u.segs, inline: inline.map((m) => m.name) });
        }
      }
    } else if (name === "path") {
      if (node.startIndex < useEnd) continue;
      const parent = node.parent;
      if (parent && SCOPED.has(parent.type) && parent.childForFieldName("path")?.id === node.id) continue;
      addRef(pathSegs(node.text), false);
    } else if (name === "extern") {
      const crate = node.childForFieldName("name")?.text;
      if (crate) ex.externs.push(crate);
    }
  }
  tree.delete();
  return ex;
}

/**
 * The `#[path = "…"]` attribute directly above a `mod` item, if any.
 * @param {import("web-tree-sitter").Node} node
 * @returns {string | null}
 */
function pathAttrOf(node) {
  for (let s = node.previousNamedSibling; s && s.type === "attribute_item"; s = s.previousNamedSibling) {
    const m = s.text.match(/^#\[\s*path\s*=\s*"([^"]*)"\s*\]$/);
    if (m) return m[1];
  }
  return null;
}

/**
 * Flatten a use tree into full paths.
 * @param {import("web-tree-sitter").Node} node
 * @param {string[]} prefix
 * @param {{ segs: string[], alias: string | null, glob: boolean }[]} out
 */
function expandUse(node, prefix, out) {
  switch (node.type) {
    case "use_as_clause": {
      const p = node.childForFieldName("path");
      const segs = p ? [...prefix, ...pathSegs(p.text)] : prefix;
      out.push({ segs, alias: node.childForFieldName("alias")?.text ?? null, glob: false });
      return;
    }
    case "use_wildcard": {
      const p = node.namedChildren.find((c) => c !== null && c.type !== "use_list");
      out.push({ segs: p ? [...prefix, ...pathSegs(p.text)] : prefix, alias: null, glob: true });
      return;
    }
    case "scoped_use_list": {
      const p = node.childForFieldName("path");
      const list = node.childForFieldName("list");
      if (list) expandUse(list, p ? [...prefix, ...pathSegs(p.text)] : prefix, out);
      return;
    }
    case "use_list":
      for (const c of node.namedChildren) if (c) expandUse(c, prefix, out);
      return;
    case "self":
      out.push({ segs: prefix, alias: prefix[prefix.length - 1] ?? null, glob: false });
      return;
    default: {
      const segs = [...prefix, ...pathSegs(node.text)];
      out.push({ segs, alias: segs[segs.length - 1] ?? null, glob: false });
    }
  }
}

/**
 * Add every Rust file's edges to the graph.
 * @param {import("../graph.mjs").Graph} graph
 * @param {{ files: Map<string, string>, tracked: Set<string>,
 *           extract: (file: string) => Promise<RustExtract | undefined> }} ctx
 */
export async function addRustGraph(graph, { files, tracked, extract }) {
  /** @type {Map<string, string>} */
  const manifests = new Map();
  for (const p of tracked) if (posix.basename(p) === "Cargo.toml" && files.has(p)) manifests.set(p, /** @type {string} */ (files.get(p)));
  const crates = discoverCrates(manifests, tracked);
  const { fileMod, modIndex, modEdges } = await buildModuleTree(crates, tracked, extract);
  /** @type {Map<string, import("./rust-modules.mjs").Crate>} */
  const libs = new Map();
  for (const c of crates) if (c.libName) libs.set(c.libName, c);

  for (const file of files.keys()) {
    if (!file.endsWith(".rs")) continue;
    graph.addNode(file, namer, rootName(file));
  }
  for (const [from, to] of modEdges) graph.addEdge(from, to);

  for (const [file, { crate, modPath }] of fileMod) {
    const ex = await extract(file);
    if (!ex) continue;
    /** @type {Map<string, { segs: string[], inline: string[] }>} */
    const aliases = new Map();
    for (const a of ex.aliases) if (!aliases.has(a.name)) aliases.set(a.name, a);
    for (const name of ex.externs) graph.addExternal(file, name);
    for (const ref of ex.refs) {
      const r = resolve(crate, [...modPath, ...ref.inline], ref.segs, 0);
      if (r?.file) graph.addEdge(file, r.file);
      else if (r?.external) graph.addExternal(file, r.external);
    }

    /**
     * @param {import("./rust-modules.mjs").Crate} c
     * @param {string[]} m current module path
     * @param {string[]} segs
     * @param {number} depth
     * @returns {{ file?: string, external?: string } | null}
     */
    function resolve(c, m, segs, depth) {
      const [s0] = segs;
      if (s0 === "crate") return lookup(c, segs.slice(1));
      if (s0 === "self") return lookup(c, [...m, ...segs.slice(1)]);
      if (s0 === "super") {
        let k = 0;
        while (segs[k] === "super") k++;
        if (k > m.length) return null;
        return lookup(c, [...m.slice(0, m.length - k), ...segs.slice(k)]);
      }
      if (modIndex.has(modKey(c, [...m, s0]))) return lookup(c, [...m, ...segs]);
      const alias = aliases.get(s0);
      if (alias && depth < 3 && alias.segs[0] !== s0) {
        return resolve(c, [...modPath, ...alias.inline], [...alias.segs, ...segs.slice(1)], depth + 1);
      }
      const other = libs.get(s0);
      if (other) return lookup(other, segs.slice(1));
      if (STD.has(s0) || c.deps.has(s0)) return { external: s0 };
      return null;
    }
  }

  /**
   * @param {import("./rust-modules.mjs").Crate} c
   * @param {string[]} abs
   */
  function lookup(c, abs) {
    for (let i = abs.length; i >= 0; i--) {
      const f = modIndex.get(modKey(c, abs.slice(0, i)));
      if (f) return { file: f };
    }
    return null;
  }

  /** @type {import("../graph.mjs").Namer} */
  function namer(target, viewer) {
    const t = fileMod.get(target);
    if (!t) return target;
    const v = fileMod.get(viewer);
    const mod = t.modPath.join("::");
    if (v && v.crate === t.crate) return mod || "crate";
    return mod ? `${t.crate.label}::${mod}` : t.crate.label;
  }

  /** @param {string} file */
  function rootName(file) {
    const t = fileMod.get(file);
    if (!t) return file;
    const src = posix.join(t.crate.pkgDir, "src") + "/";
    if (file.startsWith(src)) return file.slice(src.length);
    return t.crate.pkgDir ? file.slice(t.crate.pkgDir.length + 1) : file;
  }
}
