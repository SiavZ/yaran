/**
 * Parses a scanned QR payload into an org URL, accepting only the add-org link.
 *
 * The only payload the app acts on is `yaranapp://add-org?u=<OrgUrl>` (Phase 02 §10); the
 * parsing and the OrgUrl grammar come from `@yaran/protocol` so the QR, the deep link and the
 * CLI renderer agree. A QR code can come from anywhere, so the result only ever pre-fills the
 * Confirm org screen; it is never added automatically (T42).
 *
 * - Pure. The shell runs its host rules on the returned URL before showing it.
 *
 * <module-headers:begin>
 * Uses:
 * src/payload.ts
 * └── @yaran/protocol:src/index.ts
 * External: none
 *
 * Used by:
 * src/payload.ts
 * ├── src/index.ts
 * ├── test/decode.test.ts
 * └── test/payload.test.ts
 * <module-headers:end>
 */
import { parseAppUri } from '@yaran/protocol';

export type AddOrgPayload =
  | { ok: true; orgUrl: string }
  | { ok: false; reason: 'not_yaran' | 'not_add_org' | 'invalid' };

/** Interprets decoded QR text. */
export function parseAddOrgPayload(text: string): AddOrgPayload {
  const trimmed = text.trim();
  if (!/^yaranapp:\/\//i.test(trimmed)) return { ok: false, reason: 'not_yaran' };
  const parsed = parseAppUri(trimmed);
  if (!parsed.ok) return { ok: false, reason: 'invalid' };
  return parsed.kind === 'add-org' ? { ok: true, orgUrl: parsed.orgUrl } : { ok: false, reason: 'not_add_org' };
}
