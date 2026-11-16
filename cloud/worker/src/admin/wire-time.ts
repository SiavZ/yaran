/**
 * 02's `Timestamp`: RFC 3339 UTC to the second (`2026-11-14T12:00:00Z`, no milliseconds).
 *
 * D1 stores Unix seconds; every timestamp this phase puts on the wire goes through here.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * src/admin/wire-time.ts
 * ├── scripts/assemble-deploy-tree.ts
 * ├── src/admin/audit-query.ts
 * ├── src/admin/health.ts
 * ├── src/admin/scheduled-jobs.ts
 * ├── src/admin/users.ts
 * ├── src/setup/steps/claim.ts
 * └── src/update/update-checker.ts
 * <module-headers:end>
 */
export function wireTime(at: Date | number): string {
  const d = typeof at === "number" ? new Date(at * 1000) : at;
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}
