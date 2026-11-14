/**
 * Public entry of `@yaran/push`: registers the native `Push` plugin and re-exports its contract
 * and guards.
 *
 * <module-headers:begin>
 * Uses:
 * src/index.ts
 * ├── src/definitions.ts
 * ├── src/guards.ts
 * └── src/web.ts
 * External: @capacitor/core
 *
 * Used by: entry point (package entry of @yaran/push (the "." export in mobile/plugins/push/package.json), imported by the shell)
 * <module-headers:end>
 */
import { registerPlugin } from "@capacitor/core";
import type { PushPlugin } from "./definitions.ts";

export const Push = registerPlugin<PushPlugin>("Push", {
  web: () => import("./web.ts").then((m) => new m.PushWeb()),
});

export type * from "./definitions.ts";
export * from "./guards.ts";
