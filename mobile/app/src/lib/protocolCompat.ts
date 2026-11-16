/**
 * The app-facing protocol verdict for an org's `/v1/meta`.
 *
 * Wraps `@yaran/protocol`'s negotiation (the one place a client picks a protocol version)
 * and names who must update when there is no overlap: the app, or the org's control plane.
 * A chosen version the server has scheduled for removal carries its date.
 *
 * - Pure.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/protocolCompat.ts
 * └── @yaran/protocol:src/index.ts
 * External: none
 *
 * Used by:
 * src/lib/protocolCompat.ts
 * ├── src/lib/api.ts
 * ├── src/lib/protocolCompat.test.ts
 * ├── src/screens/onboarding/ConfirmOrg.tsx
 * └── src/screens/onboarding/SignInResult.tsx
 * <module-headers:end>
 */
import { PROTOCOL_MAX, PROTOCOL_MIN, deprecationFor, negotiate, type Meta, type ProtocolRange } from '@yaran/protocol';

export const APP_PROTOCOL: ProtocolRange = { min: PROTOCOL_MIN, max: PROTOCOL_MAX };

export type Compat =
  | { ok: true; version: number; deprecatedAfter: string | null }
  | { ok: false; update: 'app' | 'control_plane' };

export function protocolVerdict(meta: Pick<Meta, 'protocol' | 'deprecations'>, app = APP_PROTOCOL): Compat {
  const n = negotiate(app, meta.protocol);
  if (!n.ok) return { ok: false, update: n.update === 'client' ? 'app' : 'control_plane' };
  return { ok: true, version: n.version, deprecatedAfter: deprecationFor(n.version, meta.deprecations)?.after ?? null };
}

/** The side to update after a native `protocol_unsupported`, from the server's range when it sent one. */
export function updateFor(server: { min?: number; max?: number }, app = APP_PROTOCOL): 'client' | 'server' {
  if (server.min === undefined || server.max === undefined) return 'client';
  const n = negotiate(app, { min: server.min, max: server.max });
  return n.ok ? 'client' : n.update;
}
