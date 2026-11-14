/**
 * Naming: property tests over random Unicode, collision suffixes, marker round trips.
 *
 * <module-headers:begin>
 * Uses:
 * test/provisioning/naming.test.ts
 * └── src/provisioning/naming.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import {
  deriveHostname,
  deriveMachineSlug,
  deriveUserSlug,
  isValidLabel,
  markerFor,
  parseMarker,
  slugify,
  userSlugCandidate,
  type MarkerKind,
} from "../../src/provisioning/naming.ts";

/** Deterministic PRNG so failures reproduce. */
function rng(seed: number) {
  let x = seed;
  return () => ((x = (x * 1103515245 + 12345) % 2 ** 31), x / 2 ** 31);
}

const POOL = ["a", "Z", "9", "-", "_", ".", " ", "--", "é", "Å", "ß", "ﬁ", "Ⅻ", "😀", "́", "東京", "İ", "xn--", "\u0000", "Ω", "ı"];

function randomText(r: () => number, max: number): string {
  let s = "";
  const n = Math.floor(r() * max);
  for (let i = 0; i < n; i++) s += POOL[Math.floor(r() * POOL.length)];
  return s;
}

describe("slugs and hostnames (property)", () => {
  it("every hostname is one valid RFC 1123 label ≤ 63 with no -- and is deterministic", async () => {
    const r = rng(42);
    for (let i = 0; i < 1500; i++) {
      const email = `${randomText(r, 40)}@example.org`;
      const userSlug = userSlugCandidate(await deriveUserSlug(email), 1 + Math.floor(r() * 150), r);
      const machineSlug = deriveMachineSlug(randomText(r, 50));
      const n = 1 + Math.floor(r() * 9);
      const host = deriveHostname(machineSlug, userSlug, "Example.COM", n);
      const label = host.slice(0, -".example.com".length);
      expect(host.endsWith(".example.com")).toBe(true);
      expect(isValidLabel(label), `${JSON.stringify(email)} → ${label}`).toBe(true);
      expect(userSlug.length).toBeLessThanOrEqual(24);
      expect(machineSlug.length).toBeLessThanOrEqual(32);
      expect(deriveHostname(machineSlug, userSlug, "example.com", n)).toBe(host);
      expect(await deriveUserSlug(email)).toBe(await deriveUserSlug(email));
    }
  });

  it("normalizes, drops marks and collapses runs", async () => {
    expect(slugify("  Ångström--Lab__01 ", 32)).toBe("angstrom-lab-01");
    expect(await deriveUserSlug("José.Pérez+tag@x.org")).toBe("jose-perez-tag");
    expect(await deriveUserSlug("😀@x.org")).toMatch(/^u[0-9a-f]{6}$/);
    expect(deriveMachineSlug("my--box")).toBe("my-box");
    expect(deriveMachineSlug("___")).toBe("machine");
    expect(slugify("a".repeat(19) + "-b", 20)).toBe("a".repeat(19));
  });

  it("collision suffixes run -2 … -99, then a random 4-hex suffix, within 24 characters", () => {
    expect(userSlugCandidate("alice", 1)).toBe("alice");
    expect(userSlugCandidate("alice", 2)).toBe("alice-2");
    expect(userSlugCandidate("alice", 99)).toBe("alice-99");
    expect(userSlugCandidate("alice", 100, () => 0.5)).toBe("alice-8000");
    expect(userSlugCandidate("a".repeat(20), 100, () => 0)).toBe(`${"a".repeat(19)}-0000`);
    expect(deriveHostname("laptop", "alice", "example.com", 1)).toBe("laptop-alice.example.com");
    expect(deriveHostname("laptop", "alice", "example.com", 3)).toBe("laptop-alice-3.example.com");
  });
});

describe("markers", () => {
  const id = "0f0e0d0c-0b0a-4908-8706-050403020100";
  it.each<MarkerKind>(["tunnel", "access_policy", "access_app", "dns_record"])("%s round trips", (kind) => {
    const m = markerFor(kind, "a1b2c3d4", id);
    expect(parseMarker(kind, "a1b2c3d4", m)).toBe(id);
    expect(parseMarker(kind, "ffff0000", m)).toBeNull();
  });
  it("matches the documented shapes and lengths", () => {
    expect(markerFor("tunnel", "a1b2c3d4", id)).toHaveLength(51);
    expect(markerFor("dns_record", "a1b2c3d4", id)).toHaveLength(53);
    expect(markerFor("access_policy", "a1b2c3d4", id)).toBe(`yaran:a1b2c3d4:owner:${id}`);
  });
  it("rejects unmarked, malformed and foreign markers", () => {
    for (const bad of [null, undefined, "", "my-tunnel", `yaran:a1b2c3d4:m:${id}x`, `yaran:a1b2c3d4:m:not-a-uuid`]) {
      expect(parseMarker("access_app", "a1b2c3d4", bad)).toBeNull();
    }
  });
});
