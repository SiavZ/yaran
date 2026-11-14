/**
 * Stale-machine verdict table, `null` thresholds meaning off.
 *
 * <module-headers:begin>
 * Uses:
 * test/stale-policy.test.ts
 * └── src/admin/stale-policy.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker)
 * <module-headers:end>
 */
import { expect, test } from "vitest";
import { staleVerdict } from "../src/admin/stale-policy.ts";

const NOW = new Date("2026-11-14T00:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

test.each([
  [{ notify_after_days: 30, revoke_after_days: null }, 10, "keep"],
  [{ notify_after_days: 30, revoke_after_days: null }, 30, "notify"],
  [{ notify_after_days: 30, revoke_after_days: null }, 400, "notify"],
  [{ notify_after_days: 30, revoke_after_days: 90 }, 89, "notify"],
  [{ notify_after_days: 30, revoke_after_days: 90 }, 90, "revoke"],
  [{ notify_after_days: null, revoke_after_days: 90 }, 60, "keep"],
  [{ notify_after_days: null, revoke_after_days: 90 }, 91, "revoke"],
  [{ notify_after_days: null, revoke_after_days: null }, 9999, "keep"],
] as const)("%o offline %d days → %s", (policy, days, verdict) => {
  expect(staleVerdict(policy, ago(days), ago(10_000), NOW)).toBe(verdict);
});

test("a machine never seen counts from pairing", () => {
  expect(staleVerdict({ notify_after_days: 30, revoke_after_days: null }, null, ago(31), NOW)).toBe("notify");
});
