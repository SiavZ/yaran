/**
 * Renders the generated block's content and reads hand annotations back out of it.
 *
 * The block is language-neutral text; block.mjs adds the comment syntax. Trees are drawn
 * with `├──`/`└──`, entries sorted by name. A trailing `(…)` on a tree line is a hand
 * annotation: it is read back keyed by node name and written again on regeneration, so
 * `--write` never loses it.
 *
 * - Pure string functions; deterministic output for a given input.
 * - `(inferred)` is generated, never treated as an annotation.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * src/render.mjs
 * ├── src/block.mjs
 * ├── src/headers.mjs
 * └── test/block.test.mjs
 * <module-headers:end>
 */

export const BEGIN = "<module-headers:begin>";
export const END = "<module-headers:end>";
const INFERRED = "(inferred)";

/**
 * @typedef {{ name: string, inferred: boolean }} Entry
 * @typedef {{ uses: Map<string, string>, usedBy: Map<string, string> }} Annotations
 * @typedef {{ root: string, uses: Entry[], unresolved: string[], external: string[],
 *             usedBy: Entry[], entryPoint?: string, annotations?: Annotations }} BlockModel
 */

/**
 * @param {BlockModel} model
 * @returns {string[]} content lines, BEGIN and END included
 */
export function renderBlock(model) {
  const ann = model.annotations ?? { uses: new Map(), usedBy: new Map() };
  const lines = [BEGIN];
  const useLines = [
    ...model.uses.map((e) => ({ label: label(e), note: ann.uses.get(e.name) })),
    ...model.unresolved.map((u) => ({ label: `unresolved: ${u}`, note: undefined })),
  ];
  if (useLines.length === 0) lines.push("Uses: none");
  else lines.push("Uses:", model.root, ...tree(useLines));
  lines.push(`External: ${model.external.length ? model.external.join(", ") : "none"}`);
  lines.push("");
  const byLines = model.usedBy.map((e) => ({ label: label(e), note: ann.usedBy.get(e.name) }));
  if (model.entryPoint !== undefined) {
    lines.push(`Used by: entry point (${model.entryPoint})`);
    if (byLines.length) lines.push(model.root, ...tree(byLines));
  } else if (byLines.length === 0) {
    lines.push("Used by: none");
  } else {
    lines.push("Used by:", model.root, ...tree(byLines));
  }
  lines.push(END);
  return lines;
}

/** @param {Entry} e */
function label(e) {
  return e.inferred ? `${e.name} ${INFERRED}` : e.name;
}

/**
 * @param {{ label: string, note: string | undefined }[]} items
 * @returns {string[]}
 */
function tree(items) {
  const width = Math.max(...items.map((i) => i.label.length));
  return items.map((item, idx) => {
    const glyph = idx === items.length - 1 ? "└──" : "├──";
    const note = item.note ? `${" ".repeat(width - item.label.length + 2)}${item.note}` : "";
    return `${glyph} ${item.label}${note}`;
  });
}

/**
 * Read hand annotations from existing block content lines (comment syntax already removed).
 * @param {string[]} content
 * @returns {Annotations}
 */
export function parseAnnotations(content) {
  /** @type {Annotations} */
  const ann = { uses: new Map(), usedBy: new Map() };
  /** @type {Map<string, string> | null} */
  let section = null;
  for (const line of content) {
    if (line.startsWith("Uses")) section = ann.uses;
    else if (line.startsWith("Used by")) section = ann.usedBy;
    else if (line.startsWith("External")) section = null;
    const m = line.match(/^[├└]── (.*)$/);
    if (!m || !section || m[1].startsWith("unresolved: ")) continue;
    const name = m[1].split(/\s+/)[0];
    let rest = m[1].slice(name.length).trim();
    if (rest.startsWith(INFERRED)) rest = rest.slice(INFERRED.length).trim();
    if (rest.startsWith("(") && rest.endsWith(")")) section.set(name, rest);
  }
  return ann;
}

/**
 * Split block content into its three comparable sections.
 * @param {string[]} content
 */
export function sections(content) {
  const norm = content.map((l) => l.replace(/\s+/g, " ").trim());
  const ext = norm.findIndex((l) => l.startsWith("External:"));
  const by = norm.findIndex((l) => l.startsWith("Used by"));
  return {
    uses: norm.slice(1, ext < 0 ? undefined : ext).join("\n"),
    external: ext < 0 ? "" : norm[ext],
    usedBy: by < 0 ? "" : norm.slice(by, -1).join("\n"),
  };
}
