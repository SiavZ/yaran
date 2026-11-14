/**
 * The audit action catalogue: the closed `AuditAction` union and its runtime list, both
 * generated from Phase 02's `registry/audit-actions.json` and re-exported here.
 *
 * A phase adds an action to that registry file (and regenerates `@yaran/protocol`), never
 * here: nothing in this file is hand-written.
 *
 * <module-headers:begin>
 * Uses:
 * src/audit/actions.ts
 * ├── @yaran/protocol:src/index.ts
 * └── cloud/protocol/registry/audit-actions.json
 * External: none
 *
 * Used by:
 * src/audit/actions.ts
 * ├── src/audit/audit.ts
 * └── test/audit.test.ts
 * <module-headers:end>
 */
import registry from "@yaran/protocol/registry/audit-actions.json" with { type: "json" };
import type { AuditAction } from "@yaran/protocol";

export type { AuditAction };

export const AUDIT_ACTIONS: readonly AuditAction[] = registry.actions as AuditAction[];
