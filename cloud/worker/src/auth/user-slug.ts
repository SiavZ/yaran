/**
 * Stand-in for Phase 05's `deriveUserSlug` (src/provisioning/naming.ts), with the same
 * signature and rules, until 05 lands; then identity.ts imports 05's and this file goes.
 *
 * Rules (05 §3): NFKD, lowercase, drop combining marks, every run outside `[a-z0-9]`
 * becomes one `-`, trim `-`, truncate to 20; empty means `u` plus the first 6 hex chars of
 * SHA-256 of the email.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * src/auth/user-slug.ts
 * ├── src/auth/identity.ts
 * └── test/identity.test.ts
 * <module-headers:end>
 */

export async function deriveUserSlug(email: string): Promise<string> {
  const local = email.slice(0, Math.max(0, email.lastIndexOf("@")));
  const slug = local.normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20).replace(/-+$/, "");
  if (slug) return slug;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email)));
  return `u${Array.from(digest.slice(0, 3), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
