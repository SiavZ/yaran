/**
 * Host rules for org URLs and machine hosts: the TS twin of the native core's HostRules.
 *
 * Accepts `https` only, refuses userinfo, IP literals, IDNs, ports other than 443, paths,
 * queries and fragments, and normalises case, an explicit `:443` and one trailing slash into
 * the 02 `OrgUrl` form. The Kotlin, Swift and TS implementations are pinned by one shared
 * fixture, `mobile/plugins/core/fixtures/host-rules-cases.json`, checked in the order the
 * fixture's contract documents.
 *
 * - Pure; a trust boundary (QR, deep link and typed input all pass through here).
 * - shortcut: every IDN is refused instead of detecting mixed scripts; upgrade if a real
 *   org needs an IDN domain.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * src/lib/hostRules.ts
 * ├── src/lib/hostRules.test.ts
 * ├── src/lib/orgUrl.ts
 * └── src/screens/onboarding/ConfirmOrg.tsx
 * <module-headers:end>
 */

export type HostRefusal =
  | 'empty'
  | 'not_https'
  | 'userinfo'
  | 'ip_literal'
  | 'idn'
  | 'port'
  | 'path'
  | 'query'
  | 'fragment'
  | 'invalid';

export type HostResult = { ok: true; value: string } | { ok: false; refused: HostRefusal };

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^[a-z]{2,63}$/;
const refuse = (refused: HostRefusal): HostResult => ({ ok: false, refused });

// Shared host checks after authority parsing: IDN, IP literal, label grammar.
function checkHost(rawHost: string): HostResult {
  if (rawHost === '') return refuse('invalid');
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7f]/.test(rawHost)) return refuse('idn');
  const host = rawHost.toLowerCase();
  const labels = host.split('.');
  if (labels.some((l) => l.startsWith('xn--'))) return refuse('idn');
  if (labels.every((l) => /^[0-9]+$/.test(l))) return refuse('ip_literal');
  if (host.length > 253 || labels.length < 2 || !labels.every((l) => LABEL.test(l)) || !TLD.test(labels.at(-1)!)) {
    return refuse('invalid');
  }
  return { ok: true, value: host };
}

/** Normalises an org URL to the canonical 02 OrgUrl, or names the rule it breaks. */
export function orgUrl(input: string): HostResult {
  const text = input.trim();
  if (text === '') return refuse('empty');
  if (!/^https:\/\//i.test(text)) return refuse('not_https');
  const rest = text.slice('https://'.length);
  const end = rest.search(/[/?#]/);
  const authority = end < 0 ? rest : rest.slice(0, end);
  const remainder = end < 0 ? '' : rest.slice(end);
  if (authority.includes('@')) return refuse('userinfo');
  if (authority.startsWith('[')) return refuse('ip_literal');
  const colon = authority.lastIndexOf(':');
  const rawHost = colon < 0 ? authority : authority.slice(0, colon);
  if (colon >= 0 && authority.slice(colon + 1) !== '443') return refuse('port');
  const host = checkHost(rawHost);
  if (!host.ok) return host;
  const pathEnd = remainder.search(/[?#]/);
  const path = pathEnd < 0 ? remainder : remainder.slice(0, pathEnd);
  if (path !== '' && path !== '/') return refuse('path');
  if (remainder.includes('?')) return refuse('query');
  if (remainder.includes('#')) return refuse('fragment');
  return { ok: true, value: `https://${host.value}` };
}

/** Validates a bare machine hostname (02 Hostname). */
export function hostname(input: string): HostResult {
  const text = input.trim();
  if (text === '') return refuse('empty');
  if (text.startsWith('[')) return refuse('ip_literal');
  if (text.includes('@')) return refuse('userinfo');
  if (/[/:]/.test(text)) return refuse('invalid');
  return checkHost(text);
}
