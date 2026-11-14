/**
 * `ProvisionError`: a permanent, engine-level refusal that carries its 02 registry code.
 *
 * Cloudflare failures are `CfApiError`s; everything the engine itself refuses (a full quota,
 * a hostname nobody can have, a machine in the wrong state, a tunnel that will not delete)
 * is a `ProvisionError`, so the HTTP layer can surface `code` and `details` unchanged.
 *
 * - `details` never holds secrets; it is shown to admins and written to audit rows.
 *
 * <module-headers:begin>
 * Uses:
 * src/provisioning/provision-error.ts
 * └── @yaran/protocol:src/index.ts
 * External: none
 *
 * Used by:
 * src/provisioning/provision-error.ts
 * ├── src/provisioning/engine.ts
 * ├── src/provisioning/index.ts
 * ├── src/provisioning/quota.ts
 * ├── src/provisioning/settings.ts
 * ├── src/provisioning/steps-provision.ts
 * └── src/provisioning/steps-rotate.ts
 * <module-headers:end>
 */
import type { ErrorCode } from "@yaran/protocol";

export class ProvisionError extends Error {
  override readonly name = "ProvisionError";
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
