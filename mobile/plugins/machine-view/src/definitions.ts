/**
 * The TypeScript contract of the two native plugins: `MachineView` and `Session`.
 *
 * `MachineView` opens one machine's yaran web UI in a separate, bridge-less native WebView
 * (D9), pinned to that machine's host and authenticated by an injected `CF_Authorization`
 * session cookie (D8). `Session` runs the system-browser sign-in plus sealed handoff, keeps
 * per-host sessions in the native vault, and is the only client of the org Worker (D22).
 *
 * - No method returns a JWT, a cookie or a key, and none signs on JS's behalf (D22). The
 *   direct-machine calls never take or return the machine password or the session it buys:
 *   the password is typed into a native sheet and the session stays in the native vault.
 * - Share intake hands JS a count and a state, never a URI, a file name or bytes.
 * - Wire names and the rules natives must enforce: docs/operations/mobile-parity-contracts.md.
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
 * ├── src/web.ts
 * └── test/contract.test.ts
 * <module-headers:end>
 */
import type { PluginListenerHandle } from "@capacitor/core";
import type {
  ApiResult,
  ClosedEvent,
  DirectSignInOutcome,
  DirectSignOutOutcome,
  DirectStatus,
  RouteStatus,
  ShareReceivedEvent,
  ShareStatus,
  SignInOutcome,
} from "./outcomes.ts";

/** The most routes one open may name (G2); natives refuse a longer list. */
export const MAX_ROUTES = 4;
/** The most files one share holds; natives keep the first ten and count the rest as dropped. */
export const MAX_SHARED_FILES = 10;

/** Fields every open form shares. */
interface OpenCommon {
  /** `#/agent/<sid>` with an optional `/tab/<id>` (see routes.ts); anything else is refused. */
  route?: string;
  /**
   * Hand the held share named `shareBatch` (its `batch` from `shareStatus` or `shareReceived`)
   * to this window (G5), taken only if it is still the share native holds, in one step. Natives
   * reject with `share_changed` when another share replaced it (nothing is taken and no window
   * opens; read `shareStatus` again), with `no_share` when none is held, and with
   * `invalid_arguments` for a malformed id. Nothing is uploaded until the page's own file chooser asks.
   */
  shareBatch?: string;
}

/** An org (Cloud Connect) machine: the original form, unchanged; `kind` may be omitted. */
export interface OrgOpenOptions extends OpenCommon {
  kind?: "org";
  orgId: string;
  machineId: string;
  /** The machine's hostname from the last authenticated machines list, never a deep link. */
  host: string;
}

/** A machine reached directly over HTTPS on the default port (G1). */
export interface DirectOpenOptions extends OpenCommon {
  kind: "direct";
  /** A public host (`isPublicHost` in @yaran/protocol); http, ports and IP literals are refused. */
  host: string;
  /**
   * The instance id this phone recorded for the machine. On a mismatch the window closes
   * with `{reason: "error", code: "instance_changed"}`. Absent: nothing to compare. A machine
   * whose status lacks `native_auth_ui: true` closes it with `code: "upgrade_required"`.
   */
  instance?: string;
}

/** One way to reach a machine. Every route signs in on its own; none shares another's session. */
export type MachineRoute =
  | { kind: "org"; orgId: string; machineId: string; host: string }
  | { kind: "direct"; host: string };

/**
 * Several user-approved routes to one machine (G2). Native tries them in order at open, at
 * resume after the sockets parked, and from the offline overlay, and loads the first whose
 * public status answers `instance`; it never switches under a live page. When none answers
 * the window closes with `{reason: "error", code: "no_route"}`, or `code: "upgrade_required"`
 * when the only answers came from yaran builds too old for the app (see `DirectClosedCode`).
 */
export interface RoutedOpenOptions extends OpenCommon {
  kind: "routes";
  /** 1 to MAX_ROUTES routes, distinct hosts, in the user's order. */
  routes: MachineRoute[];
  instance: string;
}

export type OpenOptions = OrgOpenOptions | DirectOpenOptions | RoutedOpenOptions;

export interface MachineViewPlugin {
  open(options: OpenOptions): Promise<void>;
  close(): Promise<void>;
  /** What the last share left waiting; the pull twin of `shareReceived`, for a cold start. */
  shareStatus(): Promise<ShareStatus>;
  /**
   * Forgets the held share named `batch` (Cancel on the share screen), only if it is still the one
   * held, in one step. Rejects `share_changed` when another share replaced it (that share and its
   * pending event stay); resolves when none is held; `invalid_arguments` for a malformed id.
   */
  discardShare(options: { batch: string }): Promise<void>;
  addListener(event: "closed", listener: (event: ClosedEvent) => void): Promise<PluginListenerHandle>;
  addListener(event: "shareReceived", listener: (event: ShareReceivedEvent) => void): Promise<PluginListenerHandle>;
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
  /**
   * `GET https://<host>/api/v1/auth/status`, no redirect followed. Native attaches this
   * host's own stored session, if any, and no other host's.
   */
  directStatus(options: { host: string }): Promise<DirectStatus>;
  /** Presents the native password sheet for `host` and keeps the resulting session natively. */
  directSignIn(options: { host: string }): Promise<DirectSignInOutcome>;
  /**
   * Ends `host`'s session on the machine (best effort), then deletes it and the host's web data.
   * With `signInId` (from that sign-in's `signed_in`), it ends only that sign-in: when the host's
   * current session is another one (a later sign-in, an older build's, or none) nothing is
   * touched and the answer is `not_current`. Without it, whatever is current goes (Remove),
   * including sign-ins that land meanwhile, up to a bound: when new sign-ins keep landing past
   * it, the newest one is kept and the answer is also `not_current`. For a call without an id,
   * `not_current` therefore means the host still has a session: the sign-out is incomplete.
   */
  directSignOut(options: { host: string; signInId?: string }): Promise<DirectSignOutOutcome>;
  /**
   * One route's `GET /api/v1/auth/status` (G2), for checking a route before it is saved: a
   * direct route as `directStatus`, an org route with only its own native session (see
   * `RouteStatus`). Never follows a redirect, never sends one host's credential to another.
   */
  routeStatus(options: { route: MachineRoute }): Promise<RouteStatus>;
}
