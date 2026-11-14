/**
 * Seam to Phase 15's `@yaran/machine-view` plugin: the `MachineView` and `Session` objects.
 *
 * Phase 15 owns these plugins and lands `mobile/plugins/machine-view/src/definitions.ts`;
 * until that package exists in this tree, the shell codes against the API its phase
 * document fixes (15 Design "Plugin API") through this one file. When 15 lands, replace the
 * declarations below with `export * from '@yaran/machine-view'` (and add the `file:`
 * dependency); no screen imports anything but this module.
 *
 * - Trust boundary (D22): no method returns a JWT, cookie or key. Every Worker call,
 *   `/v1/meta` included, goes through native code; the shell never touches the network.
 * - `orgId` is the org's canonical 02 `OrgUrl` (assumed; recorded in the Phase 14 report).
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/native/machineView.ts
 * └── @yaran/protocol:src/index.ts
 * External: @capacitor/core
 *
 * Used by:
 * src/lib/native/machineView.ts
 * ├── src/App.tsx
 * ├── src/a11y.test.tsx
 * ├── src/lib/api.test.ts
 * ├── src/lib/api.ts
 * ├── src/lib/buildInfo.ts
 * ├── src/lib/lifecycle.test.ts
 * ├── src/lib/lifecycle.ts
 * ├── src/lib/machinesStore.test.ts
 * ├── src/lib/orgStore.test.ts
 * ├── src/lib/orgStore.ts
 * ├── src/screens/machines/MachineList.tsx
 * ├── src/screens/machines/machines.test.tsx
 * ├── src/screens/onboarding/ConfirmOrg.tsx
 * ├── src/screens/onboarding/SignInResult.tsx
 * ├── src/screens/onboarding/onboarding.test.tsx
 * ├── src/screens/screens.test.tsx
 * └── src/test/setup.ts
 * <module-headers:end>
 */
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { Meta } from '@yaran/protocol';

export type CallbackMode = { mode: 'https'; domain: string } | { mode: 'dev' };

/** Phase 15 `ApiResult`: one variant per outcome of a native org API call. */
export type ApiResult =
  | { kind: 'ok'; status: number; body: unknown }
  | { kind: 'api_error'; status: number; body: unknown }
  | { kind: 'session_expired' }
  | { kind: 'device_revoked' }
  | { kind: 'offline' }
  | { kind: 'tls_error'; host: string }
  | { kind: 'refused'; reason: string }
  | { kind: 'protocol_unsupported'; update: 'client' | 'server' };

/** Phase 15 failure matrix rows (15 Design "Failure matrix"), one variant per sentence. */
export type SignInOutcome =
  | { kind: 'signed_in' }
  | { kind: 'cancelled' }
  | { kind: 'declined' }
  | { kind: 'app_closed' }
  | { kind: 'verification_failed'; domain: string }
  | { kind: 'rate_limited' }
  | { kind: 'protocol_unsupported'; update: 'client' | 'server' }
  | { kind: 'clock_skewed'; host: string }
  | { kind: 'request_refused'; code: string }
  | { kind: 'no_browser' }
  | { kind: 'reply_mismatch' }
  | { kind: 'decrypt_failed' }
  | { kind: 'reply_expired' }
  | { kind: 'not_owner'; email: string; machine: string }
  | { kind: 'device_revoked' }
  | { kind: 'offline' }
  | { kind: 'tls_error'; host: string }
  | { kind: 'locked' };

/** Rejection codes of `Session.meta` (the public `/v1/meta` fetch). */
export type MetaFailure = 'offline' | 'tls_error' | 'not_json' | 'access_redirect' | 'invalid' | 'refused';

export type MachineViewClosedReason = 'user' | 'home' | 'settings' | 'signedOut' | 'error';

export interface MachineViewPlugin {
  open(options: { orgId: string; machineId: string; host: string; route?: string }): Promise<void>;
  close(): Promise<void>;
  addListener(
    eventName: 'closed',
    listener: (event: { reason: MachineViewClosedReason; code?: string }) => void,
  ): Promise<PluginListenerHandle>;
}

export interface SessionPlugin {
  meta(options: { orgUrl: string }): Promise<Meta>;
  signIn(options: { orgId: string; target: 'control-plane' | { machineHost: string } }): Promise<SignInOutcome>;
  status(options: { host: string }): Promise<{ signedIn: boolean; expiresAt?: number }>;
  request(options: { orgId: string; method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; path: string; body?: unknown }): Promise<ApiResult>;
  installId(options: { orgId: string }): Promise<{ installId: string }>;
  callbackMode(): Promise<CallbackMode>;
  signOut(options: { orgId: string; hosts: string[] }): Promise<void>;
}

export const MachineView = registerPlugin<MachineViewPlugin>('MachineView');
export const Session = registerPlugin<SessionPlugin>('Session');

/** The `code` a rejected Capacitor call carries, or null. */
export function rejectionCode(err: unknown): string | null {
  return typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string' ? err.code : null;
}
