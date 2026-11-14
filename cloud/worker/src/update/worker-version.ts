/**
 * The running Worker's release version, compared against the release train by the checker.
 *
 * `0.0.0-dev` on main; the deploy-tree assembler rewrites this file with the tag's version
 * (`yaran-cloud-vX.Y.Z` → `X.Y.Z`) in every tree it publishes. There is no runtime
 * self-version binding (the version-metadata binding has only id, tag and timestamp).
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * src/update/worker-version.ts
 * ├── src/routes/meta.ts
 * ├── src/routes/phase07-context.ts
 * └── test/me/meta.test.ts
 * <module-headers:end>
 */
export const WORKER_VERSION = "0.0.0-dev";
