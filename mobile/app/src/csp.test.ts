/**
 * Guards the shell's Content-Security-Policy and viewport (D9, T60).
 *
 * The shell is the only bridge-enabled page, so its CSP must never weaken: this parses
 * `index.html` and pins every directive exactly. The viewport meta copies the web UI's.
 *
 * <module-headers:begin>
 * Uses: none
 * External: node:fs, node:path, node:url, vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const APP = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const html = readFileSync(join(APP, 'index.html'), 'utf8');

function meta(attr: string, value: string): string {
  const m = new RegExp(`<meta\\s+${attr}="${value}"\\s+content="([^"]*)"`, 's').exec(html);
  if (!m) throw new Error(`no <meta ${attr}="${value}">`);
  return m[1]!;
}

describe('shell CSP', () => {
  it('pins every directive', () => {
    const directives = Object.fromEntries(
      meta('http-equiv', 'Content-Security-Policy')
        .split(';')
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => {
          const [name, ...values] = d.split(/\s+/);
          return [name!, values.join(' ')];
        }),
    );
    expect(directives).toEqual({
      'default-src': "'self'",
      'script-src': "'self' 'wasm-unsafe-eval'",
      'img-src': "'self' data: blob:",
      'media-src': "'self' blob:",
      'style-src': "'self' 'unsafe-inline'",
      'connect-src': "'self'",
      'object-src': "'none'",
      'base-uri': "'none'",
      'frame-ancestors': "'none'",
    });
  });
  it('has exactly one CSP and no inline script', () => {
    expect(html.match(/Content-Security-Policy/g)).toHaveLength(1);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  });
  it('copies the web UI viewport', () => {
    const web = readFileSync(join(APP, '..', '..', 'crates', 'yaran-web', 'web', 'index.html'), 'utf8');
    const webViewport = /<meta name="viewport" content="([^"]*)"/.exec(web)![1];
    expect(meta('name', 'viewport')).toBe(webViewport);
  });
});
