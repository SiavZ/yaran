/**
 * Name-matching edges for languages whose files see each other without imports.
 *
 * Kotlin files in one package and Swift files in one module reference each other's
 * top-level declarations with no import line. This builds a scope -> name -> files index
 * and links a file to every file in its visible scopes that declares an identifier it uses.
 *
 * - Every edge made here is marked inferred and renders with an `(inferred)` suffix.
 * - Two files declaring the same name in one scope BOTH get the edge: a known over-report,
 *   pinned by the Kotlin and Swift tests so a future fix shows up as a test change.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * src/lang/inferred.mjs
 * ├── src/lang/kotlin.mjs
 * └── src/lang/swift.mjs
 * <module-headers:end>
 */

/** @typedef {Map<string, Map<string, Set<string>>>} ScopeIndex */

/**
 * @param {Iterable<{ scope: string, file: string, decls: string[] }>} entries
 * @returns {ScopeIndex}
 */
export function buildScopeIndex(entries) {
  /** @type {ScopeIndex} */
  const index = new Map();
  for (const { scope, file, decls } of entries) {
    let names = index.get(scope);
    if (!names) index.set(scope, (names = new Map()));
    for (const d of decls) {
      let files = names.get(d);
      if (!files) names.set(d, (files = new Set()));
      files.add(file);
    }
  }
  return index;
}

/**
 * @param {import("../graph.mjs").Graph} graph
 * @param {string} file
 * @param {string[]} idents identifiers the file uses
 * @param {Iterable<string>} scopes scopes visible without an import
 * @param {ScopeIndex} index
 */
export function linkInferred(graph, file, idents, scopes, index) {
  for (const scope of scopes) {
    const names = index.get(scope);
    if (!names) continue;
    for (const id of idents) {
      for (const target of names.get(id) ?? []) graph.addEdge(file, target, { inferred: true });
    }
  }
}

/**
 * Identifier texts of the given node types, de-duplicated, from offset `from` onwards.
 * @param {import("web-tree-sitter").Node} root
 * @param {Set<string>} types
 * @param {number} from
 */
export function identifiersAfter(root, types, from) {
  const out = new Set();
  const cursor = root.walk();
  walk: for (;;) {
    if (types.has(cursor.nodeType) && cursor.startIndex >= from) out.add(cursor.nodeText);
    if (cursor.gotoFirstChild()) continue;
    while (!cursor.gotoNextSibling()) if (!cursor.gotoParent()) break walk;
  }
  cursor.delete();
  return [...out];
}
