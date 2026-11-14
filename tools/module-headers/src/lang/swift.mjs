/**
 * Swift frontend: module imports, plus same-module edges inferred from a declaration index.
 *
 * Swift files in one module see each other without imports, so every same-module edge is
 * inferred: an identifier that equals another file's top-level type, protocol, function,
 * typealias or global. `import M` makes a first-party module visible the same way, and
 * names any other module in External.
 *
 * - A file's module is its SwiftPM target (`Sources/<M>/…` or `Tests/<M>/…`), else the top
 *   directory under the nearest directory holding an `.xcodeproj`, else its parent directory.
 * - An `extension Foo` declares nothing new, so a file used only through an extension it
 *   adds is missed (documented limit).
 * - Node names are `<module>/<file stem>`.
 *
 * <module-headers:begin>
 * Uses:
 * src/lang/swift.mjs
 * ├── src/lang/inferred.mjs
 * └── src/parsers.mjs
 * External: node:path
 *
 * Used by:
 * src/lang/swift.mjs
 * ├── src/build.mjs
 * └── test/swift.test.mjs
 * <module-headers:end>
 */

import { posix } from "node:path";
import { parse } from "../parsers.mjs";
import { buildScopeIndex, linkInferred, identifiersAfter } from "./inferred.mjs";

const IDENT = new Set(["simple_identifier", "type_identifier"]);

/** @typedef {{ imports: string[], decls: string[], idents: string[] }} SwiftExtract */

/**
 * @param {string} text
 * @returns {Promise<SwiftExtract>}
 */
export async function extractSwift(text) {
  const tree = await parse("swift", text);
  const root = tree.rootNode;
  /** @type {SwiftExtract} */
  const ex = { imports: [], decls: [], idents: [] };
  let headerEnd = 0;
  for (const node of root.namedChildren) {
    if (!node) continue;
    const first = node.namedChildren.find((c) => c?.type !== "modifiers" && c?.type !== "attribute");
    switch (node.type) {
      case "import_declaration":
        ex.imports.push(node.namedChildren.find((c) => c?.type === "identifier")?.text.split(".")[0] ?? "");
        headerEnd = node.endIndex;
        break;
      case "class_declaration":
      case "protocol_declaration":
      case "typealias_declaration":
        if (first?.type === "type_identifier") ex.decls.push(first.text);
        break;
      case "function_declaration": {
        const name = node.namedChildren.find((c) => c?.type === "simple_identifier");
        if (name) ex.decls.push(name.text);
        break;
      }
      case "property_declaration":
        for (const p of node.namedChildren) {
          if (p?.type !== "pattern") continue;
          const name = p.namedChildren.find((c) => c?.type === "simple_identifier");
          if (name) ex.decls.push(name.text);
        }
        break;
    }
  }
  ex.idents = identifiersAfter(root, IDENT, headerEnd);
  tree.delete();
  return ex;
}

/**
 * @param {string} file
 * @param {Set<string>} xcodeDirs directories that contain an `.xcodeproj`
 */
export function swiftModuleOf(file, xcodeDirs) {
  const spm = file.match(/(?:^|\/)(?:Sources|Tests)\/([^/]+)\//);
  if (spm) return spm[1];
  for (let d = posix.dirname(file); d !== "." && d !== ""; d = posix.dirname(d)) {
    const parent = posix.dirname(d);
    if (xcodeDirs.has(parent === "." ? "" : parent)) return posix.basename(d);
  }
  return posix.basename(posix.dirname(file));
}

/**
 * @param {import("../graph.mjs").Graph} graph
 * @param {{ files: Map<string, string>, tracked: Set<string>,
 *           extract: (file: string) => Promise<SwiftExtract> }} ctx
 */
export async function addSwiftGraph(graph, { files, tracked, extract }) {
  const xcodeDirs = new Set();
  for (const p of tracked) {
    const m = p.match(/^(?:(.*)\/)?[^/]+\.xcodeproj\//);
    if (m) xcodeDirs.add(m[1] ?? "");
  }
  const sw = [...files.keys()].filter((f) => f.endsWith(".swift"));
  /** @type {Map<string, { module: string, ex: SwiftExtract }>} */
  const info = new Map();
  for (const f of sw) info.set(f, { module: swiftModuleOf(f, xcodeDirs), ex: await extract(f) });
  const index = buildScopeIndex([...info].map(([file, { module, ex }]) => ({ scope: module, file, decls: ex.decls })));

  /** @param {string} file */
  const nameOf = (file) => `${info.get(file)?.module}/${posix.basename(file, ".swift")}`;
  for (const f of sw) graph.addNode(f, (t) => nameOf(t), nameOf(f));

  for (const [file, { module, ex }] of info) {
    const visible = new Set([module]);
    for (const m of ex.imports) {
      if (index.has(m)) visible.add(m);
      else if (m) graph.addExternal(file, m);
    }
    linkInferred(graph, file, ex.idents, visible, index);
  }
}
