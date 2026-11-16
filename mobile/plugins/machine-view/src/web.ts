/**
 * Browser stand-ins for MachineView and Session: every method rejects with `unavailable`.
 *
 * There is no web implementation of a separate native WebView or of the native vault, and
 * there must not be one: a JS fallback for `Session` would put credentials in JS (D22).
 *
 * - Loaded lazily by `index.ts`; used by mocks and tests only.
 *
 * <module-headers:begin>
 * Uses:
 * src/web.ts
 * └── src/definitions.ts
 * External: @capacitor/core
 *
 * Used by:
 * src/web.ts
 * ├── src/index.ts
 * └── test/contract.test.ts
 * <module-headers:end>
 */
import { WebPlugin } from "@capacitor/core";
import type { MachineViewPlugin, SessionPlugin } from "./definitions.ts";

const unavailable = (): Promise<never> =>
  Promise.reject(Object.assign(new Error("machine-view needs the native app"), { code: "unavailable" }));

export class MachineViewWeb extends WebPlugin implements Omit<MachineViewPlugin, "addListener" | "removeAllListeners"> {
  open = unavailable;
  close = unavailable;
}

export class SessionWeb extends WebPlugin implements SessionPlugin {
  meta = unavailable;
  signIn = unavailable;
  status = unavailable;
  request = unavailable;
  installId = unavailable;
  deviceKey = unavailable;
  callbackMode = unavailable;
  signOut = unavailable;
}
