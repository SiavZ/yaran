/**
 * Web stub of the `Push` plugin: every method rejects with `unimplemented`.
 *
 * The shell runs only inside the Capacitor app; this exists so `registerPlugin` has a web
 * fallback and Vitest mocks have a shape to match. Push in a browser tab is not a product path.
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
 * └── test/guards.test.ts
 * <module-headers:end>
 */
import { WebPlugin } from "@capacitor/core";
import type { PushPlugin } from "./definitions.ts";

export class PushWeb extends WebPlugin implements Omit<PushPlugin, "addListener"> {
  private refuse(): Promise<never> {
    return Promise.reject(this.unimplemented("Push notifications need the yaran phone app."));
  }

  checkPermission = () => this.refuse();
  requestPermission = () => this.refuse();
  openNotificationSettings = () => this.refuse();
  listDistributors = () => this.refuse();
  selectDistributor = () => this.refuse();
  registerDevice = () => this.refuse();
  localState = () => this.refuse();
  forgetOrg = () => this.refuse();
  setLocalMutes = () => this.refuse();
  cacheMachineNames = () => this.refuse();
  setVisibleAgent = () => this.refuse();
  clearDelivered = () => this.refuse();
  drainPendingRegistrations = () => this.refuse();
}
