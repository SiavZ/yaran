/**
 * Grammar loader: one web-tree-sitter parser per language, loaded lazily from wasm.
 *
 * Rust, bash and Kotlin grammars come from their pinned npm packages; Swift comes from
 * `.grammars/`, which `npm run fetch-grammars` fills from a pinned, checksummed GitHub
 * release because the npm package ships no wasm.
 *
 * - A grammar file that is not a WebAssembly module is refused before it is loaded.
 * - The Swift grammar is checked against the same SHA-256 the fetch script pins, so a
 *   swapped cache file is refused too.
 * - Loading is async and memoized; parsing is synchronous.
 *
 * <module-headers:begin>
 * Uses:
 * src/parsers.mjs
 * ├── scripts/fetch-grammars.mjs
 * └── src/config.mjs
 * External: node:crypto, node:fs, node:path, node:url, web-tree-sitter
 *
 * Used by:
 * src/parsers.mjs
 * ├── src/lang/kotlin.mjs
 * ├── src/lang/rust.mjs
 * ├── src/lang/shell.mjs
 * ├── src/lang/swift.mjs
 * └── test/parsers.test.mjs
 * <module-headers:end>
 */

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Parser, Language } from "web-tree-sitter";
import { SWIFT_WASM_SHA256 } from "../scripts/fetch-grammars.mjs";
import { UsageError } from "./config.mjs";

const TOOL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/** @type {Record<string, string>} */
export const GRAMMAR_FILES = {
  rust: join(TOOL_DIR, "node_modules/tree-sitter-rust/tree-sitter-rust.wasm"),
  shell: join(TOOL_DIR, "node_modules/tree-sitter-bash/tree-sitter-bash.wasm"),
  kotlin: join(TOOL_DIR, "node_modules/@tree-sitter-grammars/tree-sitter-kotlin/tree-sitter-kotlin.wasm"),
  swift: join(TOOL_DIR, ".grammars/tree-sitter-swift.wasm"),
};

/** @type {Promise<void> | undefined} */
let initialized;
/** @type {Map<string, Promise<Parser>>} */
const parsers = new Map();

/**
 * Load a grammar from bytes after the integrity checks.
 * @param {string} lang
 * @param {Uint8Array} bytes
 * @returns {Promise<Language>}
 */
export async function loadGrammarBytes(lang, bytes) {
  const magic = bytes.subarray(0, 4);
  if (bytes.length < 8 || magic[0] !== 0 || magic[1] !== 0x61 || magic[2] !== 0x73 || magic[3] !== 0x6d) {
    throw new UsageError(`the ${lang} grammar is not a WebAssembly module; reinstall it (npm ci / npm run fetch-grammars)`);
  }
  if (lang === "swift") {
    const sum = createHash("sha256").update(bytes).digest("hex");
    if (sum !== SWIFT_WASM_SHA256) {
      throw new UsageError(`the swift grammar's SHA-256 is ${sum}, expected ${SWIFT_WASM_SHA256}; run npm run fetch-grammars`);
    }
  }
  initialized ??= Parser.init();
  await initialized;
  return Language.load(bytes);
}

/**
 * @param {string} lang one of the GRAMMAR_FILES keys
 * @returns {Promise<Parser>}
 */
export function parserFor(lang) {
  let p = parsers.get(lang);
  if (!p) {
    p = (async () => {
      const file = GRAMMAR_FILES[lang];
      if (!file) throw new UsageError(`no grammar for ${lang}`);
      if (!existsSync(file)) {
        const fix = lang === "swift" ? "npm run fetch-grammars" : "npm ci";
        throw new UsageError(`the ${lang} grammar is missing (${file}); run \`${fix}\` in tools/module-headers`);
      }
      const language = await loadGrammarBytes(lang, readFileSync(file));
      const parser = new Parser();
      parser.setLanguage(language);
      return parser;
    })();
    parsers.set(lang, p);
  }
  return p;
}

/**
 * @param {string} lang
 * @param {string} text
 */
export async function parse(lang, text) {
  const parser = await parserFor(lang);
  const tree = parser.parse(text);
  if (!tree) throw new Error(`tree-sitter returned no tree for a ${lang} file`);
  return tree;
}
