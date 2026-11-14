/**
 * The handoff redirect allowlist (Design §8): one rule for both handoff servers.
 *
 * A release request may only name one of the configured https callbacks, byte for byte;
 * the custom scheme `yaranapp://auth/callback` is accepted only with `build=dev`. Anything
 * else is handoff_request_invalid and is never redirected to.
 *
 * - Pure. Rust twin: `yaran_core::cloud::protocol::uri::redirect_allowed`.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * src/redirect.ts
 * ├── src/index.ts
 * └── test/redirect.test.ts
 * <module-headers:end>
 */

export const DEV_HANDOFF_REDIRECT = "yaranapp://auth/callback";

/** True when `redirect` may receive a handoff for the given build. */
export function redirectAllowed(redirect: string, build: "release" | "dev" | undefined, configured: readonly string[]): boolean {
  if (build === "dev") return redirect === DEV_HANDOFF_REDIRECT;
  return redirect.startsWith("https://") && configured.includes(redirect);
}
