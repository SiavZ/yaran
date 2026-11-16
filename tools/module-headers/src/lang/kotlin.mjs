/**
 * Kotlin frontend: package imports resolved through a top-level declaration index.
 *
 * `import a.b.C` resolves to the file(s) declaring top-level `C` in package `a.b` (and
 * `import a.b.C.Inner` to `C`'s file). A wildcard import makes that package visible. Files
 * in the same package, and in wildcard-imported packages, are linked by name matching:
 * an identifier that equals a top-level declaration of another file is an inferred edge.
 *
 * - The package comes from the `package` header, not the directory.
 * - Unresolved imports go to External as their package (`kotlinx.coroutines.flow`).
 * - Node names are `<package>.<file stem>`.
 *
 * <module-headers:begin>
 * Uses:
 * src/lang/kotlin.mjs
 * ├── src/lang/inferred.mjs
 * └── src/parsers.mjs
 * External: node:path
 *
 * Used by:
 * src/lang/kotlin.mjs
 * └── src/build.mjs
 * <module-headers:end>
 */

import { posix } from "node:path";
import { parse } from "../parsers.mjs";
import { buildScopeIndex, linkInferred, identifiersAfter } from "./inferred.mjs";

const DECL_TYPES = new Set(["class_declaration", "object_declaration", "function_declaration"]);
const IDENT = new Set(["identifier"]);

/**
 * @typedef {{ pkg: string, imports: { segs: string[], wildcard: boolean }[],
 *             decls: string[], idents: string[] }} KotlinExtract
 */

/**
 * @param {string} text
 * @returns {Promise<KotlinExtract>}
 */
export async function extractKotlin(text) {
  const tree = await parse("kotlin", text);
  const root = tree.rootNode;
  /** @type {KotlinExtract} */
  const ex = { pkg: "", imports: [], decls: [], idents: [] };
  let headerEnd = 0;
  for (const node of root.namedChildren) {
    if (!node) continue;
    if (node.type === "package_header") {
      ex.pkg = qualified(node);
      headerEnd = node.endIndex;
    } else if (node.type === "import") {
      const segs = qualified(node).split(".");
      ex.imports.push({ segs, wildcard: /\*\s*$/.test(node.text) });
      headerEnd = node.endIndex;
    } else if (DECL_TYPES.has(node.type)) {
      const name = node.childForFieldName("name")?.text;
      if (name) ex.decls.push(name);
    } else if (node.type === "type_alias") {
      const name = node.namedChildren.find((c) => c?.type === "identifier")?.text;
      if (name) ex.decls.push(name);
    } else if (node.type === "property_declaration") {
      for (const v of node.descendantsOfType("variable_declaration")) {
        if (v?.parent?.id !== node.id && v?.parent?.parent?.id !== node.id) continue;
        const name = v.namedChildren.find((c) => c?.type === "identifier")?.text;
        if (name) ex.decls.push(name);
      }
    }
  }
  ex.idents = identifiersAfter(root, IDENT, headerEnd);
  tree.delete();
  return ex;
}

/** @param {import("web-tree-sitter").Node} node */
function qualified(node) {
  const q = node.namedChildren.find((c) => c?.type === "qualified_identifier");
  return q ? q.text.replace(/\s+/g, "") : "";
}

/**
 * @param {import("../graph.mjs").Graph} graph
 * @param {{ files: Map<string, string>, extract: (file: string) => Promise<KotlinExtract> }} ctx
 */
export async function addKotlinGraph(graph, { files, extract }) {
  const kt = [...files.keys()].filter((f) => /\.kts?$/.test(f));
  /** @type {Map<string, KotlinExtract>} */
  const exs = new Map();
  for (const f of kt) exs.set(f, await extract(f));
  const index = buildScopeIndex([...exs].map(([file, ex]) => ({ scope: ex.pkg, file, decls: ex.decls })));

  /** @param {string} file */
  const nameOf = (file) => {
    const ex = /** @type {KotlinExtract} */ (exs.get(file));
    const stem = posix.basename(file).replace(/\.kts?$/, "");
    return ex.pkg ? `${ex.pkg}.${stem}` : stem;
  };
  for (const f of kt) graph.addNode(f, (t) => nameOf(t), nameOf(f));

  for (const [file, ex] of exs) {
    const visible = new Set([ex.pkg]);
    for (const imp of ex.imports) {
      if (imp.wildcard) {
        const pkg = imp.segs.join(".");
        if (index.has(pkg)) visible.add(pkg);
        else graph.addExternal(file, pkg);
        continue;
      }
      let found = false;
      for (let i = imp.segs.length - 1; i >= 1 && !found; i--) {
        const targets = index.get(imp.segs.slice(0, i).join("."))?.get(imp.segs[i]);
        if (!targets) continue;
        for (const t of targets) graph.addEdge(file, t);
        found = true;
      }
      if (!found) graph.addExternal(file, imp.segs.slice(0, -1).join(".") || imp.segs[0]);
    }
    linkInferred(graph, file, ex.idents, visible, index);
  }
}
