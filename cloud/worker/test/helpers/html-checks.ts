/**
 * Static checks every rendered page must pass: the CSP rules (no inline script, style or
 * handlers) and the accessibility basics (labelled controls, captioned tables, button
 * classes carrying the 40px height, Cancel first and autofocused on confirm pages).
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * test/helpers/html-checks.ts
 * ├── test/console.test.ts
 * └── test/ui-kit.test.tsx
 * <module-headers:end>
 */
export function cspViolations(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) if (!/\bsrc=/.test(m[1]!) || m[2]!.trim()) out.push("inline script");
  const tags = [...html.matchAll(/<[a-z][^>]*>/gi)].map((m) => m[0]);
  if (tags.some((t) => /\sstyle=/.test(t))) out.push("style attribute");
  if (/<style\b/.test(html)) out.push("style element");
  if (tags.some((t) => /\son[a-z]+=/i.test(t))) out.push("inline handler");
  if (tags.some((t) => /=\s*"?\s*javascript:/i.test(t))) out.push("javascript: URL");
  return out;
}

export function a11yViolations(html: string): string[] {
  const out: string[] = [];
  const labels = new Set([...html.matchAll(/<label for="([^"]+)"/g)].map((m) => m[1]));
  for (const m of html.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
    if (/type="hidden"/.test(m[2]!)) continue;
    const id = /\bid="([^"]+)"/.exec(m[2]!)?.[1];
    if (!id || !labels.has(id)) out.push(`unlabelled ${m[1]} ${id ?? ""}`);
  }
  const tables = (html.match(/<table\b/g) ?? []).length;
  if ((html.match(/<caption>/g) ?? []).length !== tables) out.push("table without caption");
  for (const m of html.matchAll(/<button\b([^>]*)>/g)) if (!/class="btn /.test(m[1]!)) out.push("button without btn class");
  if (!/<html lang="en"/.test(html)) out.push("no lang");
  if (!/<main id="main"/.test(html) || !/class="skip-link"/.test(html)) out.push("no main landmark or skip link");
  if (html.includes("data-confirm-form")) {
    const cancel = html.indexOf(">Cancel<");
    const destructive = html.indexOf("btn-destructive");
    if (cancel < 0 || destructive < 0 || cancel > destructive) out.push("Cancel is not first on the confirm page");
    if (!/<a class="btn btn-outline" href="[^"]*" autofocus=""/.test(html)) out.push("Cancel is not autofocused");
  }
  return out;
}
