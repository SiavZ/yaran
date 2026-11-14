/**
 * Spike plugin proxies: the JavaScript face of the three in-app native gate probes.
 *
 * Declares the method and event shapes of MachineViewSpike (G1, G3, G6, G12), AuthSpike
 * (G13) and PushSpike (G4, G5), and registers them with Capacitor. The native halves live in
 * `android/app/src/main/java/io/github/siavz/yaran/gatespike/` and `ios/App/App/`.
 *
 * - Secrets (the pasted JWT) travel only from the shell's paste field into `open`; no method
 *   returns a cookie or a JWT back to JavaScript.
 * - Event payloads carry parameter NAMES and booleans, never the `jwe` value.
 *
 * <module-headers:begin>
 * Uses: none
 * External: @capacitor/core
 *
 * Used by:
 * src/plugins.ts
 * └── src/main.ts
 * <module-headers:end>
 */
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export type SameSite = 'Lax' | 'Strict' | 'None';

export interface OpenOptions {
  url: string;
  jwt: string;
  sameSite: SameSite;
  /** Android: 'native' swaps the platform-default file chooser for OpenMultipleDocuments (G6). */
  fileChooser: 'default' | 'native';
  /** Android: 'apply' pads the WebView by the IME inset itself and consumes it (G6 fallback). */
  imeInsets: 'default' | 'apply';
  /** iOS: pin the web view's bottom to keyboardLayoutGuide (G6 fallback). */
  keyboardGuide: boolean;
}

export interface MachineViewSpikePlugin {
  open(options: OpenOptions): Promise<{ cookieUrl: string; expires: string }>;
}

export interface AuthStartOptions {
  consentHost: string;
  mode: 'release' | 'dev';
  ephemeral: boolean;
  deviceLabel: string;
  /** Android: skip Auth Tab even when supported and use a plain Custom Tab. */
  forceCustomTab: boolean;
  /** iOS debug: start without a presentation context provider to record the error. */
  nilPresentationContext: boolean;
}

export interface AuthResult {
  path: string;
  paramNames: string[];
  stateOk: boolean;
  hasJwe: boolean;
  hasError: boolean;
  error?: string;
  detail?: string;
}

export interface AuthSpikePlugin {
  info(): Promise<Record<string, unknown>>;
  start(options: AuthStartOptions): Promise<{ via: string; consentUrlHost: string }>;
  addListener(event: 'authResult', fn: (r: AuthResult) => void): Promise<PluginListenerHandle>;
}

export interface PushEvent {
  kind: 'endpoint' | 'message' | 'failed' | 'unregistered' | 'token';
  [key: string]: unknown;
}

export interface PushSpikePlugin {
  register(options: { vapidPublicKey: string }): Promise<{ started: boolean; distributor?: string }>;
  addListener(event: 'push', fn: (e: PushEvent) => void): Promise<PluginListenerHandle>;
}

export const MachineViewSpike = registerPlugin<MachineViewSpikePlugin>('MachineViewSpike');
export const AuthSpike = registerPlugin<AuthSpikePlugin>('AuthSpike');
export const PushSpike = registerPlugin<PushSpikePlugin>('PushSpike');
