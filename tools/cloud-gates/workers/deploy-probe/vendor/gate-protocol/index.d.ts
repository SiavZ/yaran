/**
 * Gate protocol declarations: types for the pre-built index.js in this vendored package.
 *
 * Hand-written to match index.js, the way a pre-built cloud/protocol ships its .d.ts.
 *
 * - Declarations only; no runtime code.
 *
 * <module-headers:begin>
 * Uses:
 * index.d.ts
 * External: (none)
 *
 * Used by:
 * index.d.ts
 * └── ../../src/meta.ts
 * <module-headers:end>
 */

export declare const PROTOCOL_VERSION: 1;

export interface MetaBody<S> {
  protocol: typeof PROTOCOL_VERSION;
  schema: string | null;
  secrets: S;
}

export declare function metaBody<S>(schema: string | null, secretsPresent: S): MetaBody<S>;
