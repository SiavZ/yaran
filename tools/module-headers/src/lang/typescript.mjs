/**
 * TypeScript/JavaScript frontend: import scanning and module resolution via the TS 6 API.
 *
 * `ts.preProcessFile` finds every import, export-from, dynamic `import()` and `require`;
 * `ts.resolveModuleName` resolves each with the nearest tsconfig.json's options (`paths`
 * honored) under `bundler` resolution. A bare specifier naming a `file:` dependency in the
 * importer's nearest package.json resolves through that package's `exports` map to its
 * tracked source, so `@yaran/protocol` is first-party with no `npm ci` in the consumer.
 *
 * - Only tracked files become edges; anything resolving into node_modules, or a bare
 *   specifier that is not a `file:` dependency, goes to External as its package name.
 * - Unresolvable relative specifiers (assets, CSS) are ignored.
 * - Node names are paths relative to the target's package root; across packages they are
 *   `<package name>:<path>`.
 *
 * <module-headers:begin>
 * Uses: none
 * External: node:fs, node:module, node:path, typescript
 *
 * Used by:
 * src/lang/typescript.mjs
 * ├── src/build.mjs
 * └── test/typescript.test.mjs
 * <module-headers:end>
 */

import { readFileSync, realpathSync } from "node:fs";
import { builtinModules } from "node:module";
import { posix, join, relative, dirname } from "node:path";
import ts from "typescript";

/** @typedef {{ dir: string, name: string | undefined, fileDeps: Map<string, string>, exports: unknown }} Pkg */

/**
 * @param {import("../graph.mjs").Graph} graph
 * @param {{ repoRoot: string, files: Map<string, string>, tracked: Set<string> }} ctx
 */
export function addTsGraph(graph, { repoRoot, files, tracked }) {
  const root = realpathSync(repoRoot);
  /** @type {Map<string, Pkg | null>} */
  const pkgCache = new Map();
  /** @type {Map<string, { options: ts.CompilerOptions, cache: ts.ModuleResolutionCache }>} */
  const configCache = new Map();
  const tsFiles = [...files.keys()].filter(isTsPath);

  /** @param {string} rel repo-relative directory ("" for the root) @returns {Pkg | null} */
  function pkgFor(rel) {
    if (pkgCache.has(rel)) return /** @type {Pkg | null} */ (pkgCache.get(rel));
    const file = posix.join(rel, "package.json");
    /** @type {Pkg | null} */
    let pkg = null;
    if (tracked.has(file)) {
      try {
        const json = JSON.parse(readFileSync(join(root, file), "utf8"));
        const fileDeps = new Map();
        for (const k of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
          for (const [name, spec] of Object.entries(json[k] ?? {})) {
            if (typeof spec === "string" && spec.startsWith("file:")) {
              fileDeps.set(name, posix.normalize(posix.join(rel, spec.slice(5))));
            }
          }
        }
        pkg = { dir: rel, name: json.name, fileDeps, exports: json.exports };
      } catch {
        pkg = null;
      }
    }
    if (!pkg && rel !== "" && rel !== ".") pkg = pkgFor(posix.dirname(rel) === "." ? "" : posix.dirname(rel));
    pkgCache.set(rel, pkg);
    return pkg;
  }

  /** @param {string} relDir */
  function configFor(relDir) {
    const abs = join(root, relDir);
    const found = ts.findConfigFile(abs, ts.sys.fileExists, "tsconfig.json");
    const key = found ?? "";
    let entry = configCache.get(key);
    if (!entry) {
      /** @type {ts.CompilerOptions} */
      let options = {};
      if (found) {
        const read = ts.readConfigFile(found, ts.sys.readFile);
        options = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, dirname(found), undefined, found).options;
      }
      options = {
        ...options,
        allowJs: true,
        resolveJsonModule: true,
        allowImportingTsExtensions: true,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
      };
      entry = { options, cache: ts.createModuleResolutionCache(abs, (s) => s, options) };
      configCache.set(key, entry);
    }
    return entry;
  }

  for (const file of tsFiles) graph.addNode(file, namer, rootName(file));

  for (const file of tsFiles) {
    const text = /** @type {string} */ (files.get(file));
    const info = ts.preProcessFile(text, true, true);
    const dir = posix.dirname(file);
    for (const { fileName: spec } of info.importedFiles) {
      const bare = !spec.startsWith(".") && !spec.startsWith("/");
      if (bare) {
        const viaFileDep = resolveFileDep(spec, dir === "." ? "" : dir);
        if (viaFileDep) {
          if (tracked.has(viaFileDep)) graph.addEdge(file, viaFileDep);
          else graph.addExternal(file, packageName(spec));
          continue;
        }
      }
      const { options, cache } = configFor(dir);
      const res = ts.resolveModuleName(spec, join(root, file), options, ts.sys, cache).resolvedModule;
      const target = res ? toRepoPath(res.resolvedFileName) : undefined;
      if (target && tracked.has(target) && !res?.isExternalLibraryImport) graph.addEdge(file, target);
      else if (bare && !spec.startsWith("node:") && !isBuiltin(spec)) graph.addExternal(file, packageName(spec));
      else if (bare) graph.addExternal(file, spec.startsWith("node:") ? spec : `node:${spec.split("/")[0]}`);
    }
  }

  /**
   * @param {string} spec
   * @param {string} importerDir
   * @returns {string | undefined} repo-relative target, when spec names a file: dependency
   */
  function resolveFileDep(spec, importerDir) {
    const pkg = pkgFor(importerDir);
    if (!pkg) return undefined;
    const name = packageName(spec);
    const depDir = pkg.fileDeps.get(name);
    if (depDir === undefined) return undefined;
    const dep = pkgFor(depDir);
    const sub = spec === name ? "." : `.${spec.slice(name.length)}`;
    const targets = dep && dep.dir === depDir ? exportTargets(dep.exports, sub) : [];
    const paths = targets.map((t) => posix.normalize(posix.join(depDir, t)));
    return paths.find((p) => tracked.has(p)) ?? paths[0] ?? posix.join(depDir, "<unresolved>");
  }

  /** @param {string} abs */
  function toRepoPath(abs) {
    let real = abs;
    try {
      real = realpathSync(abs);
    } catch {
      // keep the unresolved path
    }
    const rel = relative(root, real).split("\\").join("/");
    return rel.startsWith("..") ? undefined : rel;
  }

  /** @type {import("../graph.mjs").Namer} */
  function namer(target, viewer) {
    const tp = pkgFor(posix.dirname(target));
    const vp = pkgFor(posix.dirname(viewer));
    const base = tp ? tp.dir : "";
    const rel = base ? target.slice(base.length + 1) : target;
    if (tp && vp && tp.dir === vp.dir) return rel;
    if (!tp) return target;
    return `${tp.name ?? tp.dir}:${rel}`;
  }

  /** @param {string} file */
  function rootName(file) {
    const p = pkgFor(posix.dirname(file));
    return p && p.dir ? file.slice(p.dir.length + 1) : file;
  }
}

/** @param {string} p */
export function isTsPath(p) {
  return /\.(?:[mc]?[jt]s|tsx)$/.test(p);
}

/** @param {string} spec */
export function packageName(spec) {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** @param {string} spec */
function isBuiltin(spec) {
  return builtinModules.includes(spec.split("/")[0]);
}

const CONDITIONS = new Set(["types", "import", "default"]);

/**
 * Resolve a subpath through a package.json `exports` value with the types/import/default
 * conditions, in the object's key order as Node does. Every matching target is returned
 * in that order, so the caller can take the first one that is a tracked source file.
 * @param {unknown} exportsField
 * @param {string} sub "." or "./x"
 * @returns {string[]}
 */
export function exportTargets(exportsField, sub) {
  if (exportsField === undefined || exportsField === null) return [sub === "." ? "./index.js" : sub];
  if (typeof exportsField === "string" || Array.isArray(exportsField)) {
    return sub === "." ? candidates(exportsField) : [];
  }
  const obj = /** @type {Record<string, unknown>} */ (exportsField);
  const keys = Object.keys(obj);
  if (!keys.some((k) => k.startsWith("."))) return sub === "." ? candidates(obj) : [];
  if (sub in obj) return candidates(obj[sub]);
  for (const k of keys) {
    const star = k.indexOf("*");
    if (star < 0) continue;
    const pre = k.slice(0, star);
    const post = k.slice(star + 1);
    if (sub.startsWith(pre) && sub.endsWith(post) && sub.length >= pre.length + post.length) {
      const mid = sub.slice(pre.length, sub.length - post.length);
      return candidates(obj[k]).map((t) => t.replace("*", mid));
    }
  }
  return [];
}

/**
 * @param {unknown} v
 * @returns {string[]}
 */
function candidates(v) {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(candidates);
  if (v && typeof v === "object") {
    return Object.entries(v).flatMap(([k, x]) => (CONDITIONS.has(k) ? candidates(x) : []));
  }
  return [];
}
