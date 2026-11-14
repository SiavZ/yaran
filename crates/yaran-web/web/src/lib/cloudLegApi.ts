/**
 * Cloud leg client: the `[cloud] mode` write and the leg snapshot read.
 *
 * `setCloudMode` saves the mode and, while yaran serves, moves the Cloudflare tunnel; the
 * reply is the sentence the server composed (the terminal UI shows the same one).
 * `getCloudLeg` reads the snapshot, which costs no remote call. Phase 13 refetches it on
 * the `cloud.changed` event.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/cloudLegApi.ts
 * └── src/lib/connection.ts
 * External: none
 *
 * Used by:
 * src/lib/cloudLegApi.ts
 * ├── src/components/CustomizeWebappDialog.test.tsx
 * ├── src/components/CustomizeWebappDialog.tsx
 * └── src/lib/bootstrapApi.ts
 * <module-headers:end>
 */

import { getConnectionId } from "./connection";

/** `CloudLegView` from `yaran_core::cloud::view`, flattened with its state. */
export type CloudLegState =
  | "off"
  | "unpaired"
  | "acquiring"
  | "starting"
  | "ready"
  | "reconnecting"
  | "healing"
  | "revoked"
  | "failed"
  | "not_serving";

export interface CloudLegView {
  mode: "auto" | "yes" | "no";
  state: CloudLegState;
  /** Download progress while `state` is `"acquiring"`. */
  pct?: number | null;
  hostname: string | null;
  org_url: string | null;
  org_name: string | null;
  since: string | null;
  detail: string | null;
}

export interface CloudModeReply {
  mode: string;
  warning: boolean;
  sticky: boolean;
  message: string;
  segments?: unknown;
}

export async function setCloudMode(mode: string): Promise<CloudModeReply> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const id = getConnectionId();
  if (id) headers["x-connection-id"] = id;
  let resp: Response;
  try {
    resp = await fetch("/api/v1/server/cloud-mode", {
      method: "POST",
      credentials: "same-origin",
      headers,
      body: JSON.stringify({ mode }),
      // Above the server's own 7 s bound on a mode change.
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Could not reach the server.");
  }
  if (!resp.ok) {
    const detail = (await resp.text().catch(() => "")).trim();
    throw new Error(detail || `request failed (${resp.status})`);
  }
  return resp.json();
}

export async function getCloudLeg(): Promise<CloudLegView> {
  const resp = await fetch("/api/v1/cloud/leg", {
    credentials: "same-origin",
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`request failed (${resp.status})`);
  return resp.json();
}
