/**
 * The host lock (D19): which Host and path may reach the Worker in each setup state.
 *
 * While setup is open the Worker is reachable on its workers.dev host only for the wizard
 * (`/setup*`) and `/v1/meta`; on the control-plane host (behind Access once the wizard has
 * created it) only the admin claim and `/v1/meta`. Everything else answers
 * `503 setup_incomplete`. Once setup is closed, any Host but the recorded control-plane
 * host answers `421 misdirected_host` (workers.dev and preview hosts included), whose body
 * names no host, and `/setup*` on the control-plane host answers `410 setup_closed`.
 *
 * - Pure. Phase 04's pipeline calls `hostLock` before routing (its `http/host-guard.ts`
 *   documents the same rule; the two must be one function when the phases merge).
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * src/setup/host-lock.ts
 * ├── src/phase07.ts
 * ├── src/setup/routes.ts
 * └── test/host-lock.test.ts
 * <module-headers:end>
 */

export type HostLockVerdict = { ok: true } | { ok: false; code: "setup_incomplete" | "misdirected_host" | "setup_closed" };

export interface HostLockInput {
  setup: "open" | "closed";
  host: string;
  path: string;
  /** The recorded control-plane host, once the zone step chose it. */
  controlPlaneHost: string | undefined;
}

const OK: HostLockVerdict = { ok: true };

function isSetupPath(path: string): boolean {
  return path === "/setup" || path.startsWith("/setup/");
}

export function isWorkersDevHost(host: string): boolean {
  return host.endsWith(".workers.dev");
}

export function hostLock(input: HostLockInput): HostLockVerdict {
  const host = input.host.toLowerCase().replace(/:\d+$/, "");
  const cp = input.controlPlaneHost?.toLowerCase();
  if (input.setup === "closed") {
    if (host !== cp) return { ok: false, code: "misdirected_host" };
    return isSetupPath(input.path) ? { ok: false, code: "setup_closed" } : OK;
  }
  if (input.path === "/v1/meta") return OK;
  if (isWorkersDevHost(host) && isSetupPath(input.path)) return OK;
  if (cp !== undefined && host === cp && input.path === "/setup/claim") return OK;
  return { ok: false, code: "setup_incomplete" };
}

/** `<script>.<account-subdomain>.workers.dev` → the script name, else undefined. */
export function scriptNameFromHost(host: string): string | undefined {
  const parts = host.toLowerCase().replace(/:\d+$/, "").split(".");
  return parts.length === 4 && parts[2] === "workers" && parts[3] === "dev" ? parts[0] : undefined;
}
