/**
 * The first-party import graph: files as nodes, imports as directed edges.
 *
 * Every language frontend writes into one Graph. A node is a repo-relative file path; how
 * that file is NAMED in somebody else's tree depends on who is looking (a Rust module path
 * is shorter inside its own crate), so naming is a per-language callback, not node state.
 *
 * - Edges carry an `inferred` flag (Kotlin and Swift name matching). An edge found both
 *   ways is not inferred.
 * - External dependencies and unresolved references are per-file string sets.
 * - Self edges are dropped.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * src/graph.mjs
 * ├── src/build.mjs
 * ├── test/block.test.mjs
 * └── test/graph.test.mjs
 * <module-headers:end>
 */

/** @typedef {(target: string, viewer: string) => string} Namer */

export class Graph {
  constructor() {
    /** @type {Map<string, Map<string, boolean>>} from -> (to -> inferred) */
    this.out = new Map();
    /** @type {Map<string, Map<string, boolean>>} to -> (from -> inferred) */
    this.in = new Map();
    /** @type {Map<string, Set<string>>} */
    this.external = new Map();
    /** @type {Map<string, Set<string>>} */
    this.unresolved = new Map();
    /** @type {Map<string, Namer>} file -> how to name it */
    this.namers = new Map();
    /** @type {Map<string, string>} file -> the root line of its own tree */
    this.rootNames = new Map();
  }

  /**
   * @param {string} file
   * @param {Namer} namer
   * @param {string} rootName
   */
  addNode(file, namer, rootName) {
    this.namers.set(file, namer);
    this.rootNames.set(file, rootName);
  }

  /**
   * @param {string} from
   * @param {string} to
   * @param {{ inferred?: boolean }} [opts]
   */
  addEdge(from, to, opts = {}) {
    if (from === to) return;
    const inferred = Boolean(opts.inferred);
    for (const [map, a, b] of /** @type {const} */ ([
      [this.out, from, to],
      [this.in, to, from],
    ])) {
      let m = map.get(a);
      if (!m) map.set(a, (m = new Map()));
      const prev = m.get(b);
      m.set(b, prev === undefined ? inferred : prev && inferred);
    }
  }

  /** @param {string} file @param {string} name */
  addExternal(file, name) {
    addTo(this.external, file, name);
  }

  /** @param {string} file @param {string} expr */
  addUnresolved(file, expr) {
    addTo(this.unresolved, file, expr);
  }

  /**
   * @param {string} target
   * @param {string} viewer
   */
  nameOf(target, viewer) {
    const namer = this.namers.get(target);
    return namer ? namer(target, viewer) : target;
  }

  /**
   * Named, sorted entries for one direction of one file.
   * @param {string} file
   * @param {"uses" | "usedBy"} dir
   * @returns {{ name: string, file: string, inferred: boolean }[]}
   */
  entries(file, dir) {
    const m = (dir === "uses" ? this.out : this.in).get(file) ?? new Map();
    return [...m]
      .map(([other, inferred]) => ({ name: this.nameOf(other, file), file: other, inferred }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** @param {string} file @returns {string[]} */
  externals(file) {
    return [...(this.external.get(file) ?? [])].sort();
  }

  /** @param {string} file @returns {string[]} */
  unresolvedOf(file) {
    return [...(this.unresolved.get(file) ?? [])].sort();
  }

  /** @param {string} file */
  rootName(file) {
    return this.rootNames.get(file) ?? file;
  }
}

/**
 * @param {Map<string, Set<string>>} map
 * @param {string} key
 * @param {string} value
 */
function addTo(map, key, value) {
  let s = map.get(key);
  if (!s) map.set(key, (s = new Set()));
  s.add(value);
}
