/**
 * Finds a file's leading header comment and writes the generated block into it.
 *
 * Each language has its comment syntax: `//!` lines for Rust, a `/** … *\/` block (or `//`
 * lines, the web UI's existing style) for TS/JS, a KDoc block before `package` for Kotlin,
 * `///` lines for Swift (after a SwiftPM manifest's `// swift-tools-version:` line), and
 * `#` lines after the shebang for shell (a `# shellcheck` directive stays first). Only the delimited block is ever rewritten; the prose around it
 * belongs to the author.
 *
 * - A header with no title line (only directives, or nothing before the block) is reported.
 * - Inserting into a file with no header creates one holding only the block, which then
 *   fails the title check until the author writes the prose.
 *
 * <module-headers:begin>
 * Uses:
 * src/block.mjs
 * └── src/render.mjs
 * External: none
 *
 * Used by:
 * src/block.mjs
 * ├── src/headers.mjs
 * └── test/block.test.mjs
 * <module-headers:end>
 */

import { BEGIN, END } from "./render.mjs";

/** @typedef {{ kind: "line", prefix: string } | { kind: "block" }} Style */

/** @type {Record<string, Style[]>} */
const STYLES = {
  rust: [{ kind: "line", prefix: "//!" }],
  ts: [{ kind: "block" }, { kind: "line", prefix: "//" }],
  kotlin: [{ kind: "block" }],
  swift: [{ kind: "line", prefix: "///" }],
  shell: [{ kind: "line", prefix: "#" }],
};

/**
 * Lines that must stay first and precede the header: a shebang, or a SwiftPM manifest's
 * `// swift-tools-version:`, which SwiftPM only reads from line 1.
 * @param {string[]} lines
 * @param {string} lang
 */
function leadLines(lines, lang) {
  if (lang !== "rust" && lines[0]?.startsWith("#!")) return 1;
  if (lang === "swift" && /^\/\/\s*swift-tools-version:/.test(lines[0] ?? "")) return 1;
  return 0;
}

const DIRECTIVE = /^(?:shellcheck\s|@ts-|eslint-|prettier-|@generated|<reference\s|@jsx|@vitest-|@file:|-\*-)/;

/**
 * @typedef {{ style: Style, start: number, end: number, begin: number, finish: number }} Header
 * `start`/`end` bound the comment (end exclusive); `begin`/`finish` are the marker lines or -1.
 */

/**
 * @param {string[]} lines
 * @param {string} lang
 * @returns {Header | null}
 */
export function findHeader(lines, lang) {
  let i = leadLines(lines, lang);
  while (i < lines.length && lines[i].trim() === "") i++;
  for (const style of STYLES[lang]) {
    let end = i;
    if (style.kind === "line") {
      while (end < lines.length && isPrefixed(lines[end], style.prefix)) end++;
    } else if (lines[i]?.startsWith("/**")) {
      end = i;
      while (end < lines.length && !lines[end].includes("*/", end === i ? 3 : 0)) end++;
      end = Math.min(end + 1, lines.length);
    }
    if (end === i) continue;
    const begin = indexIn(lines, BEGIN, i, end);
    const finish = begin < 0 ? -1 : indexIn(lines, END, begin, end);
    return { style, start: i, end, begin, finish };
  }
  return null;
}

/**
 * @param {string} line
 * @param {string} prefix
 */
function isPrefixed(line, prefix) {
  if (!line.startsWith(prefix)) return false;
  // `//` must not swallow `//!`-less Rust or `///`; `#` must not take a shebang.
  if (prefix === "#" && line.startsWith("#!")) return false;
  return true;
}

/**
 * @param {string[]} lines
 * @param {string} marker
 * @param {number} from
 * @param {number} to
 */
function indexIn(lines, marker, from, to) {
  for (let k = from; k < to; k++) if (lines[k].includes(marker)) return k;
  return -1;
}

/**
 * Comment text of a header line with its syntax removed.
 * @param {string} line
 * @param {Style} style
 */
export function stripComment(line, style) {
  if (style.kind === "line") return line.slice(style.prefix.length).replace(/^ /, "");
  return line
    .replace(/^\s*\/\*\*?/, "")
    .replace(/\*\/.*$/, "")
    .replace(/^\s*\* ?/, "");
}

/**
 * Whether the comment before the block (or the whole header) has a real title line.
 * @param {string[]} lines
 * @param {Header | null} h
 */
export function hasTitle(lines, h) {
  if (!h) return false;
  const stop = h.begin < 0 ? h.end : h.begin;
  for (let k = h.start; k < stop; k++) {
    const text = stripComment(lines[k], h.style).trim();
    if (text !== "" && !DIRECTIVE.test(text)) return true;
  }
  return false;
}

/**
 * Existing block content (between and including the markers), comment syntax removed.
 * @param {string[]} lines
 * @param {Header} h
 */
export function blockContent(lines, h) {
  const prefixLen = lines[h.begin].indexOf(BEGIN);
  return lines.slice(h.begin, h.finish + 1).map((l) => l.slice(prefixLen).trimEnd());
}

/**
 * Return `text` with the block replaced or inserted.
 * @param {string} text
 * @param {string} lang
 * @param {string[]} content rendered block content lines
 */
export function applyBlock(text, lang, content) {
  const lines = text.split("\n");
  const h = findHeader(lines, lang);
  if (h && h.begin >= 0 && h.finish >= 0) {
    const prefix = lines[h.begin].slice(0, lines[h.begin].indexOf(BEGIN));
    lines.splice(h.begin, h.finish - h.begin + 1, ...withPrefix(content, prefix));
    return lines.join("\n");
  }
  if (h && h.begin >= 0) throw new Error(`${BEGIN} has no matching ${END}`);
  if (h && h.style.kind === "line") {
    const p = h.style.prefix;
    const sep = stripComment(lines[h.end - 1], h.style).trim() === "" ? [] : [p];
    lines.splice(h.end, 0, ...sep, ...withPrefix(content, `${p} `));
    return lines.join("\n");
  }
  if (h) {
    const last = h.end - 1;
    const close = lines[last].lastIndexOf("*/");
    const star = lines.slice(h.start + 1, last).find((l) => /^\s*\*/.test(l))?.match(/^\s*\*/)?.[0] ?? " *";
    const body = [star, ...withPrefix(content, `${star} `)];
    if (lines[last].slice(0, close).trim() === "") lines.splice(last, 0, ...body);
    else lines.splice(last, 1, lines[last].slice(0, close).trimEnd(), ...body, `${star}/${lines[last].slice(close + 2)}`);
    return lines.join("\n");
  }
  const at = leadLines(lines, lang);
  const style = STYLES[lang][0];
  const fresh =
    style.kind === "line" ? withPrefix(content, `${style.prefix} `) : ["/**", ...withPrefix(content, " * "), " */"];
  const after = lines[at]?.trim() === "" ? [] : [""];
  lines.splice(at, 0, ...fresh, ...after);
  return lines.join("\n");
}

/**
 * @param {string[]} content
 * @param {string} prefix
 */
function withPrefix(content, prefix) {
  return content.map((l) => (l === "" ? prefix.trimEnd() : `${prefix}${l}`));
}
