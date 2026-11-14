/**
 * Gate protocol: a tiny pre-built package bundled into the deploy tree, standing in for cloud/protocol.
 *
 * The real deploy branch bundles a pre-built copy of cloud/protocol that the Worker imports
 * by relative path, because the Deploy button cannot resolve workspace dependencies. This
 * package has the same shape (plain JavaScript plus a declaration file, no build step) so
 * G11 proves the button builds such a tree.
 *
 * - Plain ES module with no dependencies; nothing here is compiled at deploy time.
 * - metaBody carries booleans for secrets, never values.
 *
 * <module-headers:begin>
 * Uses:
 * index.js
 * External: (none)
 *
 * Used by:
 * index.js
 * └── ../../src/meta.ts
 * <module-headers:end>
 */

export const PROTOCOL_VERSION = 1;

export function metaBody(schema, secretsPresent) {
  return { protocol: PROTOCOL_VERSION, schema, secrets: secretsPresent };
}
