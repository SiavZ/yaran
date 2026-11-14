/**
 * Naming: user and machine slugs, machine hostnames, and the per-instance resource markers.
 *
 * Every Cloudflare resource the engine creates carries this instance's marker
 * (`settings.instance_id`), so two control planes in one account never adopt or delete each
 * other's resources. Hostnames are one DNS label under the zone (D1), so Universal SSL
 * covers them.
 *
 * - Pure and deterministic, except `userSlugCandidate`'s final random fallback.
 * - A slug never contains `--` or a leading/trailing `-`, which rules out IDNA `xn--` labels.
 * - Hostname label: 32 (machine) + 1 + 24 (user) + 3 (suffix) = 60, under 63.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * src/provisioning/naming.ts
 * ├── src/cloudflare/desired.ts
 * ├── src/provisioning/index.ts
 * ├── src/provisioning/steps-provision.ts
 * ├── src/provisioning/steps-teardown.ts
 * ├── src/reconcile/orphans.ts
 * ├── src/reconcile/status.ts
 * └── test/provisioning/naming.test.ts
 * <module-headers:end>
 */

export const USER_SLUG_MAX = 20;
/** `users.slug` CHECK allows 24, which leaves room for a collision suffix. */
export const USER_SLUG_STORED_MAX = 24;
export const MACHINE_SLUG_MAX = 32;
export const MAX_HOSTNAME_CANDIDATES = 9;

/** NFKD, lowercase, drop combining marks, runs outside [a-z0-9] → `-`, trim, truncate. */
export function slugify(input: string, max: number): string {
  const s = input
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\p{M}+/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, max).replace(/-+$/, "");
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** User slug from the email local part; `u<6 hex>` of SHA-256(email) when that is empty. */
export async function deriveUserSlug(email: string): Promise<string> {
  const lower = email.toLowerCase();
  const at = lower.lastIndexOf("@");
  const local = at >= 0 ? lower.slice(0, at) : lower;
  const slug = slugify(local, USER_SLUG_MAX);
  return slug !== "" ? slug : `u${(await sha256Hex(lower)).slice(0, 6)}`;
}

/**
 * The n-th candidate for a unique `users.slug`: n = 1 is the base, 2…99 append `-n`, and past
 * that a random `-<4 hex>`. The base is shortened so the result fits `users.slug`.
 */
export function userSlugCandidate(base: string, n: number, random: () => number = Math.random): string {
  if (n <= 1) return base;
  const suffix =
    n <= 99
      ? `-${n}`
      : `-${Math.floor(random() * 0x10000)
          .toString(16)
          .padStart(4, "0")}`;
  const head = base.slice(0, USER_SLUG_STORED_MAX - suffix.length).replace(/-+$/, "");
  return `${head}${suffix}`;
}

/** Machine slug from 02's `MachineName`; `machine` when nothing survives. */
export function deriveMachineSlug(machineName: string): string {
  const slug = slugify(machineName, MACHINE_SLUG_MAX);
  return slug !== "" ? slug : "machine";
}

/** The n-th hostname candidate: n = 1 is `<machine>-<user>.<zone>`, then `-2`, `-3`, … on the label. */
export function deriveHostname(machineSlug: string, userSlug: string, zoneName: string, n = 1): string {
  const label = `${machineSlug}-${userSlug}${n > 1 ? `-${n}` : ""}`;
  return `${label}.${zoneName.toLowerCase()}`;
}

/** RFC 1123 single label, at most 63 characters, no `--`. */
export function isValidLabel(label: string): boolean {
  return label.length >= 1 && label.length <= 63 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label) && !label.includes("--");
}

// --- Markers --------------------------------------------------------------------------

export type MarkerKind = "tunnel" | "access_policy" | "access_app" | "dns_record";

export const tunnelName = (inst: string, machineId: string) => `yaran-${inst}-${machineId}`;
export const policyName = (inst: string, machineId: string) => `yaran:${inst}:owner:${machineId}`;
export const appName = (inst: string, machineId: string) => `yaran:${inst}:m:${machineId}`;
export const dnsComment = (inst: string, machineId: string) => `yaran:${inst}:m:${machineId}`;

/** The prefix every marker of `kind` for this instance starts with. */
export function markerPrefix(kind: MarkerKind, inst: string): string {
  switch (kind) {
    case "tunnel":
      return `yaran-${inst}-`;
    case "access_policy":
      return `yaran:${inst}:owner:`;
    case "access_app":
    case "dns_record":
      return `yaran:${inst}:m:`;
  }
}

export function markerFor(kind: MarkerKind, inst: string, machineId: string): string {
  return markerPrefix(kind, inst) + machineId;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The machine id a marker names, or null when it is not this instance's marker of `kind`. */
export function parseMarker(kind: MarkerKind, inst: string, marker: string | null | undefined): string | null {
  if (!marker) return null;
  const prefix = markerPrefix(kind, inst);
  if (!marker.startsWith(prefix)) return null;
  const id = marker.slice(prefix.length);
  return UUID.test(id) ? id : null;
}
