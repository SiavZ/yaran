/**
 * Turns what a person typed (or a QR/deep link delivered) into a canonical org URL or a
 * direct machine's host.
 *
 * Adds `https://` when no scheme was typed, then applies the host rules (https only, the
 * default port, no path, no IP literal). Each refusal maps to one sentence for orgs and one
 * for machines.
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
 * ├── src/screens/machines/MachineRoutes.tsx
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

/** Normalises a typed machine address to its bare host (https, default port, no path). */
export function normalizeTypedMachineHost(input: string): { ok: true; host: string } | { ok: false; refused: HostRefusal } {
  const url = normalizeTypedOrgUrl(input);
  return url.ok ? { ok: true, host: url.value.slice('https://'.length) } : url;
}

/** The sentence for a refused machine address. */
export function machineRefusalMessage(refused: HostRefusal): MessageDescriptor {
  switch (refused) {
    case 'empty':
      return msg`Type the machine's HTTPS address, such as laptop.tail1234.ts.net.`;
    case 'not_https':
      return msg`Reach this machine over HTTPS, for example with tailscale serve.`;
    case 'userinfo':
      return msg`That address contains a user name or password. Remove everything before the @ and try again.`;
    case 'ip_literal':
      return msg`Use the machine's HTTPS name, not an IP address: no certificate matches an IP address.`;
    case 'idn':
      return msg`This app only accepts plain-ASCII machine names, so look-alike characters cannot fake one.`;
    case 'port':
      return msg`The app reaches machines on the standard HTTPS port. Remove the port, for example by serving yaran with tailscale serve.`;
    case 'path':
      return msg`Use only the machine's address, without a path after it.`;
    case 'query':
    case 'fragment':
      return msg`Remove everything after ? or # from the address.`;
    case 'invalid':
      return msg`That doesn't look like a machine name. Check for typos.`;
  }
}
