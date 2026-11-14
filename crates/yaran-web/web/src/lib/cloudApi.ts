/**
 * HTTP client for the Yaran Cloud routes behind the app menu's "Yaran Cloud…" dialog.
 *
 * The server runs every action (the browser login, disconnect, token rotation) and
 * reports its outcome as a keyed toast on the events socket, so these calls answer
 * only what the dialog needs to move to its next state. A non-2xx throws with the
 * server's own sentence.
 *
 * - The server never opens a browser: `startLogin` answers the authorize URL and the
 *   dialog opens it from its own click handler.
 * - Each request carries the per-connection id, like every other mutating call.
 * - No secret crosses this wire; the status carries none.
 * - `setCloudMode` saves `[cloud] mode` and, while yaran serves, moves the tunnel; the
 *   reply is the sentence the server composed (the terminal UI shows the same one).
 *   `cloudApi.leg` reads the leg snapshot, which costs no remote call.
 * - `cloudApi.phoneQr` answers the phone QR code a paired machine shows in "Connect a
 *   phone…"; it throws a `CloudApiError` whose `status` is 409 when not paired.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/cloudApi.ts
 * └── src/lib/connection.ts
 * External: none
 *
 * Used by:
 * src/lib/cloudApi.ts
 * ├── src/components/CustomizeWebappDialog.test.tsx
 * ├── src/components/CustomizeWebappDialog.tsx
 * ├── src/components/cloud/CloudDialog.test.tsx
 * ├── src/components/cloud/CloudDialog.tsx
 * └── src/lib/bootstrapApi.ts
 * <module-headers:end>
 */

import { getConnectionId } from "./connection"
import { createJsonRequest } from "./jsonRequest"

/** The authorize step of a running login. */
export interface CloudLogin {
  login_id: string
  authorize_url: string
  /** 02 §7.1 form, e.g. `K7QF-3MZD-W2PA-HX5R-LC4N-TB6E`. */
  fingerprint: string
  org_name: string
}

/** `GET /api/v1/cloud/status`: `yaran cloud status --offline` plus the dialog's extras. */
export interface CloudStatus {
  paired: boolean
  mode: string
  org_url?: string | null
  org_name?: string | null
  hostname?: string | null
  owner_email?: string | null
  origin_port?: number | null
  token_version?: number | null
  paired_at?: string | null
  revoked_at?: string | null
  leg?: { state: string; pid: number; since: string } | null
  /** Why the credentials could not be read. */
  error?: string | null
  /** `[cloud] org_url`, the Connect field's default (empty: type it). */
  default_org_url: string
  /** The login waiting on a browser, so a reopened dialog resumes it. */
  active_login: CloudLogin | null
}

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
  | "not_serving"

export interface CloudLegView {
  mode: "auto" | "yes" | "no"
  state: CloudLegState
  /** Whether this machine holds an unrevoked pairing. An older server omits it. */
  paired?: boolean
  /** Download progress while `state` is `"acquiring"`. */
  pct?: number | null
  hostname: string | null
  org_url: string | null
  org_name: string | null
  since: string | null
  detail: string | null
}

export interface CloudModeReply {
  mode: string
  warning: boolean
  sticky: boolean
  message: string
  segments?: unknown
}

/** `GET /api/v1/cloud/phone-qr`: the org URL a person can type, the
 *  `yaranapp://add-org?u=…` payload, and that payload as an SVG QR code (white quiet
 *  zone drawn by the encoder, so it scans on a dark page). */
export interface PhoneQr {
  url: string
  uri: string
  svg: string
}

/** A failed phone-QR call; `status` is 0 for a transport failure, 409 when the machine
 *  is not paired. */
export class CloudApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "CloudApiError"
    this.status = status
  }
}

const statusRequest = createJsonRequest((message, status) => new CloudApiError(message, status))

/** What disconnect and rotate answer; the toast carries the same sentence. */
export interface CloudActionReply {
  ok: boolean
  message: string
}

// Long enough for the slowest route: `login/complete` waits for one claim, at most
// twice `[cloud] request_timeout_seconds` (15 s by default).
const REQUEST_TIMEOUT_MS = 60_000

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" }
  const id = getConnectionId()
  if (id) headers["x-connection-id"] = id
  let resp: Response
  try {
    resp = await fetch(path, {
      method,
      credentials: "same-origin",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    throw new Error("Could not reach the server.")
  }
  if (!resp.ok) {
    const detail = (await resp.text().catch(() => "")).trim()
    throw new Error(detail || `request failed (${resp.status})`)
  }
  if (resp.status === 204) return undefined as T
  return (await resp.json()) as T
}

export const cloudApi = {
  status: () => request<CloudStatus>("GET", "/api/v1/cloud/status"),
  /** Start a login (superseding any running one) and answer its authorize step. */
  startLogin: (orgUrl: string) =>
    request<CloudLogin>("POST", "/api/v1/cloud/login/start", { org_url: orgUrl }),
  /** Hand over the address a remote browser landed on. `finished: false` means the
   *  claim was still running when the server stopped waiting; the toast reports it. */
  completeLogin: (loginId: string, callbackUrl: string) =>
    request<{ finished: boolean }>("POST", "/api/v1/cloud/login/complete", {
      login_id: loginId,
      callback_url: callbackUrl,
    }),
  cancelLogin: (loginId: string) =>
    request<void>("POST", "/api/v1/cloud/login/cancel", { login_id: loginId }),
  logout: () => request<CloudActionReply>("POST", "/api/v1/cloud/logout", {}),
  rotate: () => request<CloudActionReply>("POST", "/api/v1/cloud/rotate", {}),
  leg: () => request<CloudLegView>("GET", "/api/v1/cloud/leg", undefined, 15_000),
  phoneQr: () => statusRequest<PhoneQr>("GET", "/api/v1/cloud/phone-qr"),
}

/** Save `[cloud] mode`; 15 s is above the server's own 7 s bound on a mode change. */
export function setCloudMode(mode: string): Promise<CloudModeReply> {
  return request<CloudModeReply>("POST", "/api/v1/server/cloud-mode", { mode }, 15_000)
}
