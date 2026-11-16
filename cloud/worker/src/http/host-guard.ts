/**
 * Host and setup-state enforcement (D19): which Host may be served, and which routes exist
 * in each setup state.
 *
 * - Setup open: `/v1/meta` on any Host; the wizard (`/setup*`) only on the workers.dev
 *   Host, except the admin claim (`/setup/claim`), which arrives on the control-plane Host
 *   behind the Access app the wizard created. Everything else answers
 *   `503 setup_incomplete`, and so does any route that is not `setup` or `public`.
 * - Setup closed: only `control_plane_host` is served. Every other Host, every
 *   `*.workers.dev` included, gets `421 misdirected_host` naming no host; this holds even
 *   if a redeploy re-enables workers.dev or preview URLs. `/setup*` answers
 *   `410 setup_closed` forever.
 *
 * <module-headers:begin>
 * Uses:
 * src/http/host-guard.ts
 * ├── src/http/responses.ts
 * └── src/http/routes.ts
 * External: none
 *
 * Used by:
 * src/http/host-guard.ts
 * ├── src/http/pipeline.ts
 * └── src/setup/routes.ts
 * <module-headers:end>
 */
import { HttpError } from "./responses.ts";
import type { RouteAuth } from "./routes.ts";

export interface HostState {
  setup: "open" | "closed";
  controlPlaneHost: string | null;
}

const isSetupPath = (path: string) => path === "/setup" || path.startsWith("/setup/");

export function isWorkersDevHost(host: string): boolean {
  return host.toLowerCase().replace(/:\d+$/, "").endsWith(".workers.dev");
}

/** `<script>.<account-subdomain>.workers.dev` → the script name, else undefined. */
export function scriptNameFromHost(host: string): string | undefined {
  const parts = host.toLowerCase().replace(/:\d+$/, "").split(".");
  return parts.length === 4 && parts[2] === "workers" && parts[3] === "dev" ? parts[0] : undefined;
}

/** Refuses a request for a Host (and, while setup is open, a path) this Worker must not serve. */
export function checkHost(state: HostState, hostname: string, path: string): void {
  const host = hostname.toLowerCase();
  if (state.setup === "open") {
    if (path === "/v1/meta") return;
    if (isWorkersDevHost(host) && isSetupPath(path)) return;
    if (state.controlPlaneHost !== null && host === state.controlPlaneHost && path === "/setup/claim") return;
    throw new HttpError("setup_incomplete", "Setup has not been completed; finish the setup wizard first.");
  }
  if (!state.controlPlaneHost || host !== state.controlPlaneHost) {
    throw new HttpError("misdirected_host", "This hostname does not serve the control plane.");
  }
}

/** Refuses a matched route the current setup state does not serve. */
export function gateRoute(state: HostState, auth: RouteAuth): void {
  if (state.setup === "open") {
    if (auth.kind !== "setup" && auth.kind !== "public") {
      throw new HttpError("setup_incomplete", "Setup has not been completed; finish the setup wizard first.");
    }
  } else if (auth.kind === "setup") {
    throw new HttpError("setup_closed", "Setup is complete; the setup wizard is closed.");
  }
}
