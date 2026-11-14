/**
 * The string-building side of the console UI kit for Phase 06's pages: HTML escaping,
 * chips, buttons and notices with the markup and classes of 07's `console/ui` components,
 * and the page rendered inside 07's `Shell` (its stylesheets, enhancement script and
 * skip link), so the pairing and handoff pages look like the consoles.
 *
 * - Every interpolated value is escaped here; callers pass raw text, never HTML.
 * - The page runs no script and sets a strict CSP (same-origin style and font only,
 *   `frame-ancestors 'none'`), letting the caller widen only `form-action`, plus
 *   `Referrer-Policy: same-origin` (02 §8).
 *
 * <module-headers:begin>
 * Uses:
 * src/ui/kit.ts
 * ├── src/console/ui/shell.tsx
 * └── src/console/ui/strings.ts
 * External: hono
 *
 * Used by:
 * src/ui/kit.ts
 * ├── src/pairing/authorize-page.ts
 * └── src/sessions/handoff-page.ts
 * <module-headers:end>
 */

import { raw as rawHtml } from "hono/html";
import { Shell } from "../console/ui/shell.tsx";
import { S } from "../console/ui/strings.ts";

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

const TONE = { info: { cls: "info", icon: "i" }, warning: { cls: "warn", icon: "!" }, error: { cls: "error", icon: "×" } } as const;

/** 07's `Notice` markup: an icon and a word for the tone, never colour alone. */
export function notice(tone: "warning" | "error" | "info", ...parts: (Html | string)[]): Html {
  const t = TONE[tone];
  return raw(`<div class="notice notice-${t.cls}" role="${tone === "info" ? "status" : "alert"}"><span class="notice-icon" aria-hidden="true">${t.icon}</span><span class="sr-only">${esc(S.tone[t.cls])}</span><div class="notice-body">${join(parts)}</div></div>`);
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
    "font-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    `form-action 'self'${o.formAction ? ` ${o.formAction}` : ""}`,
    "frame-ancestors 'none'",
  ].join("; ");
  const doc = Shell({ title: o.title, script: false, children: rawHtml(body.map((b) => b.html).join("")) }).toString();
  if (typeof doc !== "string") throw new Error("the page shell rendered asynchronously");
  const html = `<!doctype html>${doc}`;
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
