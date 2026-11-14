#!/usr/bin/env node
/**
 * Rewrites the web UI's imports of the primitives that moved into `@yaran/ui-kit`.
 *
 * The move was one mechanical change; this script is kept so a fork or a pull request
 * rebased across it can re-run the same rewrite instead of fixing imports by hand. It
 * rewrites quoted module specifiers only (static imports, `import()`, `vi.mock`), and only
 * for names that actually moved: a primitive still in the web keeps its import.
 *
 * - `@/components/ui/<moved>` (or a relative `./ui/<moved>`) becomes `@yaran/ui-kit/<moved>`.
 * - `@/lib/utils` becomes `@yaran/ui-kit/cn`; `@/hooks/use-mobile` becomes `@yaran/ui-kit/use-mobile`.
 * - Usage: `node packages/ui-kit/scripts/codemod-imports.mjs [dir]` (default: the web's `src/`).
 *   Prints each file it changed; running it twice changes nothing.
 *
 * <module-headers:begin>
 * Uses: none
 * External: node:fs, node:path, node:url
 *
 * Used by: entry point (CLI: node packages/ui-kit/scripts/codemod-imports.mjs, run by hand when rebasing across the ui-kit move)
 * <module-headers:end>
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = join(HERE, "../../..");
const DEFAULT_DIR = join(REPO, "crates/yaran-web/web/src");

/** The primitives that live in the kit; anything else under `components/ui` stayed. */
const MOVED = [
  "button", "card", "checkbox", "dialog", "dropdown-menu", "empty", "inline-code", "input",
  "popover", "popupSheet", "scroll-area", "select", "separator", "sheet", "skeleton", "sonner",
  "switch", "tooltip",
];

// The alias form, or a relative path through a `components/ui` or `ui` directory.
const PREFIX = String.raw`(?:@/|(?:\.\.?/)+)`;
const UI_RE = new RegExp(`(["'])(?:@/components/|(?:\\.\\.?/)+(?:components/)?)ui/(${MOVED.join("|")})\\1`, "g");
const RENAMES = [
  [new RegExp(`(["'])${PREFIX}lib/utils\\1`, "g"), "$1@yaran/ui-kit/cn$1"],
  [new RegExp(`(["'])${PREFIX}hooks/use-mobile\\1`, "g"), "$1@yaran/ui-kit/use-mobile$1"],
  [UI_RE, "$1@yaran/ui-kit/$2$1"],
];

/**
 * @param {string} source
 * @returns {string}
 */
function rewrite(source) {
  let out = source;
  for (const [re, to] of RENAMES) out = out.replace(re, /** @type {string} */ (to));
  return out;
}

/** @param {string} dir */
function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") yield* sourceFiles(full);
    } else if (/\.(?:[mc]?[jt]s|tsx)$/.test(entry.name)) {
      yield full;
    }
  }
}

function main() {
  const dir = process.argv[2] ?? DEFAULT_DIR;
  let changed = 0;
  for (const file of sourceFiles(dir)) {
    const before = readFileSync(file, "utf8");
    const after = rewrite(before);
    if (after === before) continue;
    writeFileSync(file, after);
    changed += 1;
    console.log(relative(REPO, file));
  }
  console.log(`codemod-imports: ${changed} file(s) rewritten`);
}

main();
