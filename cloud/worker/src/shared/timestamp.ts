/**
 * Unix seconds to and from 02's `Timestamp` (RFC 3339 UTC, seconds precision, `Z`).
 *
 * D1 stores Unix seconds (04 design §12); every API boundary in Phase 06 renders them
 * through this one formatter so two payloads never disagree on the form.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * src/shared/timestamp.ts
 * ├── src/devices/devices-repo.ts
 * ├── src/machine-api/config.ts
 * ├── src/machines/machine-view-model.ts
 * └── src/me/me-route.ts
 * <module-headers:end>
 */

/** 02 `Timestamp` for Unix seconds. */
export function toTimestamp(unixS: number): string {
  return new Date(unixS * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** 02 `NullableTimestamp`. */
export function toNullableTimestamp(unixS: number | null | undefined): string | null {
  return unixS === null || unixS === undefined ? null : toTimestamp(unixS);
}

/** Unix seconds for a 02 `Timestamp` (already schema-validated). */
export function fromTimestamp(ts: string): number {
  return Math.floor(Date.parse(ts) / 1000);
}
