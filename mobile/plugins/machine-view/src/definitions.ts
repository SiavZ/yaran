/**
 * The TypeScript contract of the two native plugins: `MachineView` and `Session`.
 *
 * `MachineView` opens one machine's yaran web UI in a separate, bridge-less native WebView
 * (D9), pinned to that machine's host and authenticated by an injected `CF_Authorization`
 * session cookie (D8). `Session` runs the system-browser sign-in plus sealed handoff, keeps
 * per-host sessions in the native vault, and is the only client of the org Worker (D22).
 *
 * - No method returns a JWT, a cookie or a key, and none signs on JS's behalf (D22).
 * - `install_id` is an identifier, not a credential, so JS may read it (Phase 16).
 * - Phase 14's mocks and Phase 16's push orchestration code against these types.
 *
 * <module-headers:begin>
 * Uses:
 * src/definitions.ts
 * └── src/outcomes.ts
 * External: @capacitor/core
 *
 * Used by:
 * src/definitions.ts
 * ├── src/index.ts
 * ├── src/openMachine.ts
 * ├── src/web.ts
 * ├── test/contract.test.ts
 * └── test/openMachine.test.ts
 * <module-headers:end>
 */
import type { PluginListenerHandle } from "@capacitor/core";
import type { ApiResult, ClosedEvent, SignInOutcome } from "./outcomes.ts";

export interface OpenOptions {
  orgId: string;
  machineId: string;
  /** The machine's hostname from the last authenticated machines list, never a deep link. */
  host: string;
  /** `#/agent/<sid>` with an optional `/tab/<id>` (see routes.ts); anything else is refused. */
  route?: string;
}

export interface MachineViewPlugin {
  open(options: OpenOptions): Promise<void>;
  close(): Promise<void>;
  addListener(event: "closed", listener: (event: ClosedEvent) => void): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}

export type SignInTarget = "control-plane" | { machineHost: string };

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

/** The callback this build sends (decided at compile time from the publisher build config). */
export type CallbackMode = { mode: "https"; domain: string } | { mode: "dev" };

export interface SessionPlugin {
  /** Public `GET <orgUrl>/v1/meta` (W1), no credentials; `ok.body` is a `Meta` to validate. */
  meta(options: { orgUrl: string }): Promise<ApiResult>;
  signIn(options: { orgId: string; target: SignInTarget }): Promise<SignInOutcome>;
  status(options: { host: string }): Promise<{ signedIn: boolean; expiresAt?: number }>;
  /** A `/v1/*` call on the org origin recorded at onboarding; nothing else is reachable. */
  request(options: { orgId: string; method: HttpMethod; path: string; body?: unknown }): Promise<ApiResult>;
  /** The org's InstallId, minted with the org's device key on first call. */
  installId(options: { orgId: string }): Promise<{ installId: string }>;
  /** The org's device public key (P256Point), for Phase 16's DeviceRegistration.device_key. */
  deviceKey(options: { orgId: string }): Promise<{ deviceKey: string }>;
  callbackMode(): Promise<CallbackMode>;
  /** Clears the vault sessions, cookies and data stores of `hosts`, the install_id and device key. */
  signOut(options: { orgId: string; hosts: string[] }): Promise<void>;
}
