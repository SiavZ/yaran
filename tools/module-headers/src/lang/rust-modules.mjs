/**
 * Rust crate discovery and module-path-to-file resolution, per the Rust Reference.
 *
 * Reads every tracked Cargo.toml with a [package], finds each crate root (lib, bins,
 * tests, examples, benches, build script) the way Cargo's target auto-discovery does, then
 * walks `mod` declarations from each root to give every reachable file a module path.
 *
 * - `mod x;` in a mod-rs file (crate root or `mod.rs`) loads `dir/x.rs` or `dir/x/mod.rs`;
 *   in a non-mod-rs file `a/b.rs` it loads `a/b/x.rs` or `a/b/x/mod.rs`.
 * - `#[path]` outside inline blocks is relative to the declaring file's directory; inside
 *   inline blocks it is relative to that directory plus the inline module names (plus the
 *   file stem for a non-mod-rs file). A `#[path]`-loaded file owns its directory like a
 *   mod-rs file, as rustc does (rustc_expand::module, "All `#[path]` files are treated as
 *   though they are a `mod.rs` file").
 * - Only the TOML this needs is understood; no TOML dependency.
 *
 * <module-headers:begin>
 * Uses: none
 * External: node:path
 *
 * Used by:
 * src/lang/rust-modules.mjs
 * ├── src/lang/rust.mjs
 * └── test/rust.test.mjs
 * <module-headers:end>
 */

import { posix } from "node:path";

const { dirname, join, normalize, basename } = posix;

/**
 * @typedef {{ name?: string, path?: string }} Target
 * @typedef {{ pkg: { name?: string, build?: string | false }, lib?: Target,
 *             bin: Target[], test: Target[], example: Target[], bench: Target[],
 *             deps: Set<string> }} CargoManifest
 */

/**
 * Minimal Cargo.toml reader: tables, arrays of tables, string/bool values, dependency keys.
 * @param {string} text
 * @returns {CargoManifest}
 */
export function parseCargoToml(text) {
  /** @type {CargoManifest} */
  const m = { pkg: {}, bin: [], test: [], example: [], bench: [], deps: new Set() };
  /** @type {Record<string, any> | null} */
  let cur = null;
  let table = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (line === "" || line.startsWith("#")) continue;
    const arr = line.match(/^\[\[\s*([^\]]+?)\s*\]\]$/);
    const tbl = line.match(/^\[\s*([^\]]+?)\s*\]$/);
    if (arr || tbl) {
      table = /** @type {RegExpMatchArray} */ (arr || tbl)[1];
      cur = null;
      if (arr && ["bin", "test", "example", "bench"].includes(table)) {
        cur = {};
        m[/** @type {"bin"} */ (table)].push(cur);
      } else if (table === "package") cur = m.pkg;
      else if (table === "lib") cur = m.lib = {};
      const dep = table.match(/^(?:target\.[^.]+(?:\([^)]*\))?\.)?(?:dev-|build-)?dependencies(?:\.(.+))?$/);
      if (dep?.[1]) m.deps.add(unquote(dep[1]).replace(/-/g, "_"));
      continue;
    }
    const kv = line.match(/^("[^"]+"|[A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
    if (!kv) continue;
    const key = unquote(kv[1]);
    if (/(?:^|\.)(?:dev-|build-)?dependencies$/.test(table)) {
      m.deps.add(key.split(".")[0].replace(/-/g, "_"));
      continue;
    }
    if (cur && (key === "name" || key === "path" || key === "build")) {
      const v = kv[2].trim();
      if (v === "false") cur[key] = false;
      else if (/^["']/.test(v)) cur[key] = unquote(v);
    }
  }
  return m;
}

/** @param {string} s */
function unquote(s) {
  return s.replace(/^["']|["']$/g, "");
}

/**
 * @typedef {{ id: string, pkgDir: string, pkgName: string, kind: string, name: string,
 *             root: string, label: string, libName?: string, deps: Set<string> }} Crate
 */

/**
 * Find every crate root in the repository.
 * @param {Map<string, string>} manifests Cargo.toml path -> text
 * @param {Set<string>} tracked every tracked path
 * @returns {Crate[]}
 */
export function discoverCrates(manifests, tracked) {
  /** @type {Crate[]} */
  const crates = [];
  for (const [file, text] of [...manifests].sort()) {
    const m = parseCargoToml(text);
    if (!m.pkg.name) continue;
    const pkgDir = dirname(file) === "." ? "" : dirname(file);
    const pkgName = m.pkg.name;
    /** @param {string} p */
    const at = (p) => normalize(join(pkgDir, p));
    const seen = new Set();
    /** @param {string} kind @param {string} name @param {string} root */
    const add = (kind, name, root) => {
      if (!tracked.has(root) || seen.has(root)) return;
      seen.add(root);
      const label = kind === "lib" ? pkgName : kind === "build" ? `${pkgName}[build]` : `${pkgName}[${kind} ${name}]`;
      const crate = { id: `${pkgName}:${kind}:${name}`, pkgDir, pkgName, kind, name, root, label, deps: m.deps };
      if (kind === "lib") Object.assign(crate, { libName: (m.lib?.name ?? pkgName).replace(/-/g, "_") });
      crates.push(crate);
    };
    add("lib", pkgName, at(m.lib?.path ?? "src/lib.rs"));
    for (const b of m.bin) add("bin", b.name ?? pkgName, at(b.path ?? (b.name ? `src/bin/${b.name}.rs` : "src/main.rs")));
    add("bin", pkgName, at("src/main.rs"));
    for (const [kind, dir] of /** @type {const} */ ([["test", "tests"], ["example", "examples"], ["bench", "benches"]])) {
      for (const t of m[kind]) if (t.path || t.name) add(kind, t.name ?? basename(t.path ?? "", ".rs"), at(t.path ?? `${dir}/${t.name}.rs`));
    }
    const auto = [["bin", "src/bin"], ["test", "tests"], ["example", "examples"], ["bench", "benches"]];
    for (const p of [...tracked].sort()) {
      for (const [kind, dir] of auto) {
        const base = at(dir) + "/";
        if (!p.startsWith(base)) continue;
        const rest = p.slice(base.length);
        const one = rest.match(/^([^/]+)\.rs$/);
        const multi = rest.match(/^([^/]+)\/main\.rs$/);
        if (one) add(kind, one[1], p);
        else if (multi) add(kind, multi[1], p);
      }
    }
    if (m.pkg.build !== false) add("build", "build", at(typeof m.pkg.build === "string" ? m.pkg.build : "build.rs"));
  }
  return crates;
}

/**
 * @typedef {{ name: string, inline: string[], pathAttr: string | null, body: boolean }} ModDecl
 * @typedef {{ crate: Crate, modPath: string[] }} FileModule
 */

/**
 * Walk `mod` declarations from every crate root.
 * @param {Crate[]} crates
 * @param {Set<string>} tracked
 * @param {(file: string) => Promise<{ mods: ModDecl[] } | undefined>} modsOf
 */
export async function buildModuleTree(crates, tracked, modsOf) {
  /** @type {Map<string, FileModule>} */
  const fileMod = new Map();
  /** @type {Map<string, string>} `${crate.id}::a::b` -> file */
  const modIndex = new Map();
  /** @type {[string, string][]} */
  const modEdges = [];

  /**
   * @param {Crate} crate
   * @param {string} file
   * @param {string[]} modPath
   * @param {boolean} ownsDir mod-rs semantics: children live beside this file
   */
  async function visit(crate, file, modPath, ownsDir) {
    const key = modKey(crate, modPath);
    if (modIndex.has(key)) return;
    modIndex.set(key, file);
    if (!fileMod.has(file)) fileMod.set(file, { crate, modPath });
    const info = await modsOf(file);
    if (!info) return;
    const dir = dirname(file);
    const childBase = ownsDir ? dir : join(dir, basename(file, ".rs"));
    for (const mod of info.mods) {
      const path = [...modPath, ...mod.inline, mod.name];
      if (mod.body) {
        modIndex.set(modKey(crate, path), file);
        continue;
      }
      /** @type {string} */
      let target;
      let childOwnsDir;
      if (mod.pathAttr !== null) {
        const base = mod.inline.length === 0 ? dir : join(childBase, ...mod.inline);
        target = normalize(join(base, mod.pathAttr));
        childOwnsDir = true;
      } else {
        const d = join(childBase, ...mod.inline);
        const flat = join(d, `${mod.name}.rs`);
        target = tracked.has(flat) ? flat : join(d, mod.name, "mod.rs");
        childOwnsDir = basename(target) === "mod.rs";
      }
      if (!tracked.has(target)) continue;
      modEdges.push([file, target]);
      await visit(crate, target, path, childOwnsDir);
    }
  }

  for (const crate of crates) await visit(crate, crate.root, [], true);
  return { fileMod, modIndex, modEdges };
}

/**
 * @param {Crate} crate
 * @param {string[]} modPath
 */
export function modKey(crate, modPath) {
  return [crate.id, ...modPath].join("::");
}
