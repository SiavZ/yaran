/**
 * Stand-in for Phase 07's console UI kit (`console/ui/*`): HTML escaping, the page
 * shell with its security headers, chips, buttons and notices.
 *
 * Phase 06's pages call only these components. 07's kit replaces this file on
 * integration with the same props; until then the markup is deliberately plain.
 *
 * - Every interpolated value is escaped here; callers pass raw text, never HTML.
 * - The page shell sets the strict CSP (no script, `frame-ancestors 'none'`) and lets the
 *   caller widen only `form-action`, plus `Referrer-Policy: same-origin` (02 §8).
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * src/seams/ui-kit.ts
 * ├── src/pairing/authorize-page.ts
 * └── src/sessions/handoff-page.ts
 * <module-headers:end>
 */

/** Escapes text for HTML element and attribute context. */
export function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** A trusted HTML fragment produced by this kit. */
export interface Html {
  readonly html: string;
}

const raw = (html: string): Html => ({ html });
const join = (parts: readonly (Html | string)[]): string => parts.map((p) => (typeof p === "string" ? esc(p) : p.html)).join("");

/** A name in prose renders as a chip, never a quotation (house style). */
export function chip(text: string, o: { mono?: boolean; label?: string } = {}): Html {
  const aria = o.label ? ` aria-label="${esc(o.label)}"` : "";
  return raw(`<code class="chip${o.mono ? " chip-mono" : ""}"${aria}>${esc(text)}</code>`);
}

/** A sentence built from prose segments and chips. */
export function prose(...parts: (Html | string)[]): Html {
  return raw(`<p>${join(parts)}</p>`);
}

export function heading(...parts: (Html | string)[]): Html {
  return raw(`<h1>${join(parts)}</h1>`);
}

export function notice(tone: "warning" | "error" | "info", ...parts: (Html | string)[]): Html {
  return raw(`<div class="notice notice-${tone}" role="${tone === "info" ? "status" : "alert"}">${join(parts)}</div>`);
}

/** A form posting to `action` with hidden fields and its submit buttons. */
export function form(action: string, hidden: Record<string, string>, buttons: Html[], label: string): Html {
  const fields = Object.entries(hidden)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("");
  return raw(`<form method="post" action="${esc(action)}" aria-label="${esc(label)}">${fields}<div class="actions">${buttons.map((b) => b.html).join("")}</div></form>`);
}

/** A submit button; the primary one takes explicit focus. */
export function button(o: { name?: string; value?: string; text: string; primary?: boolean; focus?: boolean }): Html {
  const cls = o.primary ? "btn btn-primary" : "btn btn-outline";
  const nv = o.name === undefined ? "" : ` name="${esc(o.name)}" value="${esc(o.value ?? "")}"`;
  return raw(`<button type="submit" class="${cls}"${nv}${o.focus ? " autofocus" : ""}>${esc(o.text)}</button>`);
}

export interface PageOptions {
  title: string;
  status?: number;
  /** Extra `form-action` source beyond `'self'` (the redirect target's origin). */
  formAction?: string;
}

/** The page shell as a response with the security headers 02 §8 requires for these pages. */
export function page(body: Html[], o: PageOptions): Response {
  const csp = [
    "default-src 'none'",
    "style-src 'self'",
    "img-src 'self'",
    "base-uri 'none'",
    `form-action 'self'${o.formAction ? ` ${o.formAction}` : ""}`,
    "frame-ancestors 'none'",
  ].join("; ");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(o.title)}</title><link rel="stylesheet" href="/console/ui.css"></head><body><main>${body.map((b) => b.html).join("")}</main></body></html>`;
  return new Response(html, {
    status: o.status ?? 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": csp,
      "Referrer-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}
