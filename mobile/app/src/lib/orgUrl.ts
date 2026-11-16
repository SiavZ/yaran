/**
 * Turns what a person typed (or a QR/deep link delivered) into a canonical org URL.
 *
 * Adds `https://` when no scheme was typed, then applies the host rules. Each refusal maps
 * to one sentence the Enter URL and Confirm org screens show.
 *
 * - Pure. Never fetches; the protocol check happens natively in Confirm org.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/orgUrl.ts
 * └── src/lib/hostRules.ts
 * External: @lingui/core
 *
 * Used by:
 * src/lib/orgUrl.ts
 * ├── src/lib/deepLinks.ts
 * ├── src/lib/orgUrl.test.ts
 * ├── src/screens/onboarding/EnterUrl.tsx
 * └── src/screens/onboarding/ScanQr.tsx
 * <module-headers:end>
 */
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

import { orgUrl, type HostRefusal, type HostResult } from './hostRules.ts';

/** Normalises typed input: a bare host gets `https://`; any other scheme is kept and refused. */
export function normalizeTypedOrgUrl(input: string): HostResult {
  const text = input.trim();
  // A scheme is letters then `:` not followed by a digit, so `cp.example.com:443` is a host.
  return orgUrl(text === '' || /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(text) ? text : `https://${text}`);
}

/** The sentence for a refusal (rendered through Lingui). */
export function refusalMessage(refused: HostRefusal): MessageDescriptor {
  switch (refused) {
    case 'empty':
      return msg`Type the address your admin gave you, such as cp.example.com.`;
    case 'not_https':
      return msg`Org addresses must use https. Check the address your admin gave you.`;
    case 'userinfo':
      return msg`That address contains a user name or password. Remove everything before the @ and try again.`;
    case 'ip_literal':
      return msg`Org addresses are domain names, not IP addresses.`;
    case 'idn':
      return msg`This app only accepts plain-ASCII org domains, so look-alike characters cannot fake one.`;
    case 'port':
      return msg`Org addresses use the standard https port. Remove the port number.`;
    case 'path':
      return msg`Use only the org's domain, without a path after it.`;
    case 'query':
    case 'fragment':
      return msg`Remove everything after ? or # from the address.`;
    case 'invalid':
      return msg`That doesn't look like a domain name. Check for typos.`;
  }
}
