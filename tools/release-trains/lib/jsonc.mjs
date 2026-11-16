/**
 * Minimal JSONC reader for `wrangler.jsonc`: drops `//` and block comments outside
 * strings and trailing commas, then hands the text to `JSON.parse`.
 *
 * - No dependency; strings (with escapes) are copied verbatim, so `"https://x"` survives.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * lib/jsonc.mjs
 * ├── check-deploy-tree.mjs
 * └── test/deploy-tree.test.mjs
 * <module-headers:end>
 */

/** Parses JSON with comments and trailing commas. */
export function parseJsonc(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(stripTrailingCommas(out));
}

// Runs after comments are gone; skips string contents so a "," inside one is kept.
function stripTrailingCommas(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === ",") {
      let j = i + 1;
      while (/\s/.test(text[j] ?? "")) j++;
      if (text[j] !== "}" && text[j] !== "]") out += c;
    } else {
      out += c;
    }
  }
  return out;
}
