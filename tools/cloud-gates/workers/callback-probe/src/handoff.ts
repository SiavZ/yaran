/**
 * Handoff consent for gate G13: validation, consent page, CSP and the 303 callback location.
 *
 * G13 runs the mobile auth flows against a page shaped like the control plane's
 * /v1/handoff (02 §8): a one-tap consent page naming the device and the host, whose form
 * POST answers 303 to the app's callback with `?state=…&jwe=…`, or with
 * `error=handoff_declined` on Cancel. The redirect is allowlisted exactly: the verified
 * https callback for release builds, the gate's custom scheme for dev builds only.
 *
 * - Nothing is redirected until every field validates; a bad request gets a 400, never a redirect.
 * - The jwe value is a fixed, obviously fake string; the probe holds no credentials.
 * - Every interpolated value is HTML-escaped; the device label refuses control and bidi characters.
 * - Pure: no I/O, unit-tested in Node.
 *
 * <module-headers:begin>
 * Uses:
 * src/handoff.ts
 * └── src/association.ts
 * External: (none)
 *
 * Used by:
 * src/handoff.ts
 * ├── src/index.ts
 * └── test/handoff.test.ts
 * <module-headers:end>
 */
import { CALLBACK_PATHS } from './association';

export interface HandoffConfig {
  callbackHost: string;
  devScheme: string;
}

export type Build = 'release' | 'dev';
export type Decision = 'continue' | 'cancel';

export interface Handoff {
  state: string;
  redirect: string;
  build: Build;
  device: string | null;
}

export type Validated<T> = { ok: true; value: T } | { ok: false; message: string };

type Fields = { get(name: string): unknown };

export const DUMMY_JWE = 'gate.probe.not-a.jwe.value';

const STATE = /^[A-Za-z0-9_-]{16,128}$/;
const UNSAFE_DEVICE = /[\p{Cc}؜‎‏‪-‮⁦-⁩]/u;

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

const text = (fields: Fields, name: string): string | null => {
  const v = fields.get(name);
  return typeof v === 'string' ? v : null;
};

export function allowedRedirects(build: Build, cfg: HandoffConfig): string[] {
  switch (build) {
    case 'release':
      return CALLBACK_PATHS.map((path) => `https://${cfg.callbackHost}${path}`);
    case 'dev':
      return [`${cfg.devScheme}://auth/callback`];
  }
}

/** Validates query (GET, with device) or form (POST, without device) fields. */
export function validateHandoff(fields: Fields, cfg: HandoffConfig, withDevice: boolean): Validated<Handoff> {
  const rawBuild = text(fields, 'build') || 'release';
  if (rawBuild !== 'release' && rawBuild !== 'dev') return { ok: false, message: 'build must be "release" or "dev".' };
  const build: Build = rawBuild;
  const state = text(fields, 'state') ?? '';
  if (!STATE.test(state)) return { ok: false, message: 'state must be 16 to 128 letters, digits, - or _.' };
  const redirect = text(fields, 'redirect') ?? '';
  if (!allowedRedirects(build, cfg).includes(redirect)) {
    return { ok: false, message: `redirect is not an allowed callback for a ${build} build.` };
  }
  let device: string | null = null;
  if (withDevice) {
    device = text(fields, 'device') ?? '';
    const length = [...device].length;
    if (length < 1 || length > 64 || UNSAFE_DEVICE.test(device)) {
      return { ok: false, message: 'device must be 1 to 64 characters with no control or bidirectional characters.' };
    }
  }
  return { ok: true, value: { state, redirect, build, device } };
}

export const parseDecision = (raw: unknown): Decision | null =>
  raw === 'continue' ? 'continue' : raw === 'cancel' ? 'cancel' : null;

export function decisionLocation(h: Handoff, decision: Decision): string {
  const state = encodeURIComponent(h.state);
  switch (decision) {
    case 'continue':
      return `${h.redirect}?state=${state}&jwe=${DUMMY_JWE}`;
    case 'cancel':
      return `${h.redirect}?state=${state}&error=handoff_declined`;
  }
}

/** form-action must allow the 303 target too, or the browser blocks the redirect. */
export function consentCsp(build: Build, cfg: HandoffConfig): string {
  const target = build === 'release' ? `https://${cfg.callbackHost}` : `${cfg.devScheme}:`;
  return `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${target}; frame-ancestors 'none'`;
}

export function consentPage(h: Handoff, requestHost: string): string {
  const devWarning =
    h.build === 'dev'
      ? '<p class="warn"><strong>Development build.</strong> This sign-in returns through a custom URL scheme that any installed app can claim. Use it only with a build you compiled yourself.</p>'
      : '';
  const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${esc(value)}">`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect a device</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem}
.warn{background:#fff3cd;color:#5c4400;padding:.75rem;border-radius:.5rem}
.row{display:flex;gap:1.5rem;margin-top:1.5rem}button{min-height:44px;padding:0 1.25rem;font-size:1rem}
code{background:#eee;color:#111;padding:0 .3rem;border-radius:.25rem}</style></head><body>
<h1>Connect a device</h1>
<p>The device <code>${esc(h.device ?? '')}</code> asks to sign in to <code>${esc(requestHost)}</code>.</p>
${devWarning}
<form method="post" action="/v1/handoff">${hidden('state', h.state)}${hidden('redirect', h.redirect)}${hidden('build', h.build)}
<div class="row"><button type="submit" name="decision" value="cancel">Cancel</button>
<button type="submit" name="decision" value="continue">Continue</button></div></form>
</body></html>`;
}
