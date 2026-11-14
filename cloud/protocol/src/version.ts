/**
 * Protocol version negotiation (Design §3): the one place a client decides which
 * protocol integer it speaks to a server, and whether that choice is deprecated.
 *
 * A client compiled with [cmin, cmax] talking to a server advertising [smin, smax]
 * picks n = min(cmax, smax) and requires n >= max(cmin, smin). When there is no overlap
 * the answer names which side must update, so the refusal can say so in words.
 *
 * - Pure; the Rust twin is `yaran_core::cloud::protocol::negotiate`, pinned by
 *   `fixtures/version/negotiate.json`.
 *
 * <module-headers:begin>
 * Uses:
 * src/version.ts
 * └── src/generated/types.ts
 * External: (none)
 *
 * Used by:
 * src/version.ts
 * ├── src/index.ts
 * └── test/version.test.ts
 * <module-headers:end>
 */
import type { Deprecation, ProtocolRange } from "./generated/types.ts";

/** The protocol versions this build of the package speaks. */
export const PROTOCOL_MIN = 1;
export const PROTOCOL_MAX = 1;

export type Negotiation =
  | { ok: true; version: number }
  | { ok: false; code: "protocol_unsupported"; update: "client" | "server" };

/**
 * Picks the protocol version. `update: "client"` means the server only speaks newer
 * versions than this client; `"server"` means the server is too old.
 */
export function negotiate(client: ProtocolRange, server: ProtocolRange): Negotiation {
  const version = Math.min(client.max, server.max);
  if (version >= Math.max(client.min, server.min)) return { ok: true, version };
  return { ok: false, code: "protocol_unsupported", update: server.min > client.max ? "client" : "server" };
}

/** The deprecation entry for the chosen version, if the server lists one. */
export function deprecationFor(version: number, deprecations: readonly Deprecation[] | undefined): Deprecation | null {
  return deprecations?.find((d) => d.protocol === version) ?? null;
}
