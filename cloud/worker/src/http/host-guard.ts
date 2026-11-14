/**
 * Host and setup-state enforcement (D19): which Host may be served, and which routes exist
 * in each setup state.
 *
 * - Setup open: any Host (the workers.dev URL during first run, the custom domain once the
 *   wizard attached it). Only `setup` and `public` routes are served; every `user`, `admin`
 *   and `machine` route answers `503 setup_incomplete`.
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
 * └── src/http/pipeline.ts
 * <module-headers:end>
 */
import { HttpError } from "./responses.ts";
import type { RouteAuth } from "./routes.ts";

export interface HostState {
  setup: "open" | "closed";
  controlPlaneHost: string | null;
}

/** Refuses a request for a Host this Worker must not serve. */
export function checkHost(state: HostState, hostname: string): void {
  if (state.setup === "open") return;
  if (!state.controlPlaneHost || hostname.toLowerCase() !== state.controlPlaneHost) {
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
